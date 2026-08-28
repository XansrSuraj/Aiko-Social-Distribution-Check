/**
 * api/collect.js — the retry in get(), with a stubbed fetch.
 *
 * This exists because of a live failure whose shape keeps recurring: Telegram aborted mid-fetch,
 * the channel came back with no data, and in this report "no data" is read as "no post went out"
 * — a false alarm about missing content, which is the one thing this tool must never manufacture.
 *
 * The distinction being pinned here: 404 and 403 are real answers about a real state and must be
 * reported as they stand, while 429 and 5xx are the server asking to be asked again.
 *
 * Telegram is the vehicle because it is the plainest user of get() — one fetch, one parse, no
 * per-platform retry of its own on top. YouTube used to play this part, back when it was read
 * through an RSS feed that needed a retry loop of its own; that feed is gone and so is the loop,
 * and what replaced it is covered in youtube.test.js instead.
 *
 *   node test/retry.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "collect.js");
const realFetch = global.fetch;

const PAGE = ts =>
  `<div class="tgme_widget_message" data-post="somechannel/12">` +
  `<div class="tgme_widget_message_text">A post</div>` +
  `<time datetime="${ts}"></time></div>`;

function load() { delete require.cache[require.resolve(MOD)]; return require(MOD); }

function runWith(statuses, channel) {
  let calls = 0;
  global.fetch = async () => {
    const s = statuses[calls] === undefined ? 200 : statuses[calls];
    calls++;
    return { status: s, text: async () => PAGE(new Date().toISOString()) };
  };
  const handler = load();
  return new Promise(resolve => {
    handler({ method: "POST", body: { channels: [channel], hours: 24 } }, {
      setHeader() {}, status() { return this; },
      json: p => resolve({ res: p.results[0], calls }),
    });
  }).finally(() => { global.fetch = realFetch; });
}

const TG = { id: "t", platform: "telegram", url: "https://t.me/somechannel" };

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

(async () => {
  /* get() asks twice on a retryable status and no more, so a blip costs 2 fetches and a genuine
     outage is given up on after 2 rather than being hammered. */
  const cases = [
    /* [ label, channel, statuses returned in order, expected ok, expected fetch count ] */
    ["200 — answered, no retry", TG, [200], true, 1],
    ["500 then 200 — recovers", TG, [500, 200], true, 2],
    ["500 persistently — reports the failure", TG, [500, 500], false, 2],
    ["503 then 200 — recovers", TG, [503, 200], true, 2],
    ["429 then 200 — recovers", TG, [429, 200], true, 2],
    ["403 — final, not retried", TG, [403], false, 1],

    /* Telegram means it. t.me answering 404 is a real statement about a real channel, so retrying
       would only waste a request and delay an honest answer. */
    ["404 — final, not retried", TG, [404], false, 1],
  ];

  for (const [label, channel, statuses, wantOk, wantCalls] of cases) {
    const { res, calls } = await runWith(statuses, channel);
    const good = res.ok === wantOk && calls === wantCalls;
    check(good, label,
      `ok=${res.ok} fetches=${calls}` + (good ? "" : ` (wanted ok=${wantOk} fetches=${wantCalls})`));
  }

  /* a connection that never answers has to say so in words the reader can act on */
  global.fetch = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  const handler = load();
  const dead = await new Promise(r => handler({ method: "POST", body: { channels: [TG], hours: 24 } },
    { setHeader() {}, status() { return this; }, json: p => r(p.results[0]) }));
  global.fetch = realFetch;
  check(dead.ok === false && /unknown, not empty/.test(dead.note),
    "a dead connection says unknown, not empty", dead.note);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
