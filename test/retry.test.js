/**
 * api/collect.js — the retry, with a stubbed fetch.
 *
 * This exists because of two live failures that had the same shape and the same consequence.
 * Telegram once aborted mid-fetch; YouTube's feed endpoint hands back 500 intermittently for a
 * channel that is perfectly healthy. Either way the channel came back with no data, and in this
 * report "no data" is read as "no post went out" — a false alarm about missing content, which is
 * the one thing this tool must never manufacture.
 *
 * The distinction being pinned here: 404 and 403 are real answers about a real state and must be
 * reported as they stand, while 429 and 5xx are the server asking to be asked again.
 *
 *   node test/retry.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "collect.js");
const realFetch = global.fetch;

const FEED = ts => `<feed><entry><yt:videoId>vid1</yt:videoId>` +
  `<link rel="alternate" href="https://www.youtube.com/shorts/vid1"/>` +
  `<title>A short</title><published>${ts}</published>` +
  `<media:description>A short</media:description></feed>`;

function load() { delete require.cache[require.resolve(MOD)]; return require(MOD); }

function runWith(statuses, channel) {
  let calls = 0;
  global.fetch = async () => {
    const s = statuses[calls] === undefined ? 200 : statuses[calls];
    calls++;
    return { status: s, text: async () => FEED(new Date().toISOString()) };
  };
  const handler = load();
  return new Promise(resolve => {
    handler({ method: "POST", body: { channels: [channel], hours: 24 } }, {
      setHeader() {}, status() { return this; },
      json: p => resolve({ res: p.results[0], calls }),
    });
  }).finally(() => { global.fetch = realFetch; });
}

const YT = { id: "y", platform: "youtube", url: "https://youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa" };
const TG = { id: "t", platform: "telegram", url: "https://t.me/somechannel" };

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

(async () => {
  const cases = [
    /* [ label, channel, statuses returned in order, expected ok, expected fetch count ] */
    ["200 — answered, no retry", YT, [200], true, 1],
    ["500 then 200 — recovers", YT, [500, 200], true, 2],
    ["500 twice — reports the failure", YT, [500, 500], false, 2],
    ["503 then 200 — recovers", YT, [503, 200], true, 2],
    ["429 then 200 — recovers", YT, [429, 200], true, 2],
    ["403 — final, not retried", YT, [403], false, 1],

    /* The YouTube feed is the one place 404 is retried. YouTube does not use it to mean "no such
       channel" — under load it serves Google's generic 404 page, identical bytes for a real
       channel id and an invented one, so the status says nothing and may clear on a second ask. */
    ["YouTube feed 404 then 200 — recovers", YT, [404, 200], true, 2],
    ["YouTube feed 404 twice — reports it", YT, [404, 404], false, 2],

    /* Telegram means it. t.me answering 404 is a real statement about a real channel, so retrying
       would only waste a request and delay an honest answer. */
    ["Telegram 404 — final, not retried", TG, [404], false, 1],
  ];

  for (const [label, channel, statuses, wantOk, wantCalls] of cases) {
    const { res, calls } = await runWith(statuses, channel);
    const good = res.ok === wantOk && calls === wantCalls;
    check(good, label,
      `ok=${res.ok} fetches=${calls}` + (good ? "" : ` (wanted ok=${wantOk} fetches=${wantCalls})`));
  }

  /* the failure text has to steer the reader away from "the channel is empty" */
  const { res: blocked } = await runWith([404, 404], YT);
  check(/unknown, not empty/.test(blocked.note), "a refused feed says unknown, not empty", blocked.note);

  /* a connection that never answers has to say so in words the reader can act on */
  global.fetch = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  const handler = load();
  const dead = await new Promise(r => handler({ method: "POST", body: { channels: [YT], hours: 24 } },
    { setHeader() {}, status() { return this; }, json: p => r(p.results[0]) }));
  global.fetch = realFetch;
  check(dead.ok === false && /unknown, not empty/.test(dead.note),
    "a dead connection says unknown, not empty", dead.note);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
