/**
 * collectServer(), read straight out of index.html, must split its work so a slow channel can never
 * take a fast one down with it. This is the regression guard for the outage where all 11 channels
 * went into ONE /api/collect request, the four Apify (Facebook/Instagram) reads pushed it past the
 * 60s function ceiling, and when it timed out every server channel — including the fast YouTube /
 * Telegram / Viber ones — came back blank.
 *
 * The contract this pins:
 *   · the fast channels share ONE request; each SLOW (Apify: facebook/instagram/tiktok/x) channel
 *     gets its OWN
 *   · a request that fails leaves the OTHER requests' channels stored anyway (isolation)
 *   · what the press spent on Apify is summed from the responses and kept for the panel
 *
 *   node test/collectsplit.test.js
 */
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

const START = html.indexOf("async function collectServer(o){");
const END = html.indexOf("/* ── the browser half", START);
if (START < 0 || END < 0) { console.error("could not find collectServer in index.html"); process.exit(1); }
const src = html.slice(START, END);

let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };

/* the channels a real run collects: the free platforms plus the Apify ones */
const CHANS = [
  { id: "yt-vn", platform: "youtube" }, { id: "tg-vn", platform: "telegram" },
  { id: "x-vn", platform: "x" }, { id: "vb-vn", platform: "viber" },
  { id: "fb-vn", platform: "facebook" }, { id: "fb-fans", platform: "facebook" },
  { id: "ig-vn", platform: "instagram" }, { id: "ig-fans", platform: "instagram" },
];

function makeCollectServer(fetchStub, checks) {
  const location = { protocol: "https:" };
  const toast = () => {};
  const dcChannels = () => CHANS.map(c => ({ ...c, url: "https://x/" + c.id, handle: c.id }));
  const mergePosts = (id, posts) => {
    const have = checks.posts[id] || [];
    const seen = new Set(have.map(p => p.externalId));
    const add = (posts || []).filter(p => p.externalId && !seen.has(p.externalId));
    checks.posts[id] = [...have, ...add];
    return add.length;
  };
  const saveChecks = () => {};
  const fn = new Function("location", "toast", "dcChannels", "checks", "mergePosts", "saveChecks", "fetch", "Date",
    src + "\n; return collectServer;");
  return fn(location, toast, dcChannels, checks, mergePosts, saveChecks, fetchStub, Date);
}

(async () => {
  console.log("── collectServer splits fast vs slow, and isolates failures");

  /* record every request's channel-id list; a designated channel id makes its request fail */
  function stubFetch(failIds) {
    const requests = [];
    const fetchStub = async (url, opt) => {
      const body = JSON.parse(opt.body);
      const ids = body.channels.map(c => c.id);
      requests.push(ids);
      if (ids.some(id => (failIds || []).includes(id))) throw new Error("simulated timeout / 504");
      const paid = c => /^(fb|ig|x)-/.test(c.id);
      const results = body.channels.map(c => ({
        channelId: c.id, platform: c.platform, ok: true, source: "test",
        posts: [{ externalId: c.id + "-1", ts: "2026-08-24T00:00:00Z", text: "hi" }],
        cost: paid(c) ? { usd: 0.01, cached: false } : null,
      }));
      const runs = results.filter(r => r.cost).length;
      return { json: async () => ({ ok: true, collectedAt: "2026-08-24T00:00:00Z",
                                    apifyCostUsd: runs * 0.01, apifyRuns: runs, results }) };
    };
    return { fetchStub, requests };
  }

  /* 1) a healthy run */
  {
    const checks = { posts: {}, meta: {}, ytIds: {}, lastRun: null };
    const { fetchStub, requests } = stubFetch([]);
    await makeCollectServer(fetchStub, checks)({});

    ok(requests.length > 1, "more than one request is made — never a single big batch", `requests=${requests.length}`);
    const slowReqs = requests.filter(ids => ids.some(id => /^(fb|ig|x)-/.test(id)));
    ok(slowReqs.length === 5 && slowReqs.every(ids => ids.length === 1), "each slow (Apify) channel — X included — is in its own request",
      JSON.stringify(slowReqs));
    const fastReq = requests.find(ids => ids.includes("yt-vn"));
    ok(fastReq && fastReq.includes("tg-vn") && fastReq.includes("vb-vn")
       && !fastReq.some(id => /^(fb|ig|x)-/.test(id)),
      "the free channels share one request, with no Apify channel in it", JSON.stringify(fastReq));
    ok(["yt-vn","tg-vn","x-vn","vb-vn","fb-vn","fb-fans","ig-vn","ig-fans"].every(id => (checks.posts[id] || []).length === 1),
      "every channel's posts are stored");
    ok(checks.apifyLast && checks.apifyLast.runs === 5 && Math.abs(checks.apifyLast.usd - 0.05) < 1e-9 &&
       Math.abs(checks.apifyCheckUsd - 0.05) < 1e-9,
      "the press's Apify spend is summed and kept as the per-check cost", JSON.stringify(checks.apifyLast));
    ok(checks.meta["fb-vn"].cost === 0.01 && checks.meta["yt-vn"].cost === null, "each channel keeps its own run's cost");
  }

  /* 2) one slow channel's request fails — the others must be unaffected */
  {
    const checks = { posts: {}, meta: {}, ytIds: {}, lastRun: null };
    const { fetchStub } = stubFetch(["ig-vn"]);          // ig-vn's dedicated request throws
    await makeCollectServer(fetchStub, checks)({});

    ok((checks.posts["yt-vn"] || []).length === 1 && (checks.posts["tg-vn"] || []).length === 1
       && (checks.posts["x-vn"] || []).length === 1 && (checks.posts["vb-vn"] || []).length === 1,
      "a failed slow request leaves the FAST channels fully collected", JSON.stringify(Object.keys(checks.posts)));
    ok((checks.posts["fb-vn"] || []).length === 1 && (checks.posts["ig-fans"] || []).length === 1,
      "and the OTHER slow channels too");
    ok(!checks.posts["ig-vn"], "only the channel whose request failed is missing — it falls back elsewhere");
    ok(checks.apifyLast && checks.apifyLast.runs === 4 && checks.apifyCheckUsd === undefined,
      "a press with a lost request is not taken as the price of a full check", JSON.stringify(checks.apifyLast));
  }

  /* 3) a provisional bill is settled later from the same runs — refreshApifyUsage, read straight
        out of index.html like collectServer above */
  console.log("\n── a press's provisional Apify bill is replaced once Apify settles it");
  {
    const A = html.indexOf("let apifyInfo = null;");
    const B = html.indexOf("let extVersion = null;", A);
    if (A < 0 || B < 0) { console.error("could not find refreshApifyUsage in index.html"); process.exit(1); }
    const make = (checks, answers, timers) => {
      const asked = [];
      const fetchStub = async url => { asked.push(url); const a = answers.shift();
                                       return { json: async () => a }; };
      const fn = new Function("location", "checks", "fetch", "saveChecks", "dcRedraw", "setTimeout", "clearTimeout",
        html.slice(A, B) + "\n; return refreshApifyUsage;");
      return { run: fn({ protocol: "https:" }, checks, fetchStub, () => {}, null,
                       (f, ms) => { timers.push(ms); return 1; }, () => {}), asked };
    };
    const press = () => ({ usd: 0.045, runs: 2, cached: 0, settled: false, full: true, ids: ["runA", "runB"], at: "t1" });

    const timers = [];
    const checks = { apifyLast: press() };
    const { run, asked } = make(checks, [
      { ok: true, configured: true, remainingUsd: 1.4, limitUsd: 5,
        settle: [{ runId: "runA", usd: 0.031, settled: true }, { runId: "runB", usd: 0.001, settled: false }] },
      { ok: true, configured: true, remainingUsd: 1.35, limitUsd: 5,
        settle: [{ runId: "runA", usd: 0.031, settled: true }, { runId: "runB", usd: 0.031, settled: true }] },
    ], timers);
    await run();
    ok(/runs=runA%2CrunB$/.test(asked[0]), "the press's run ids are sent along", asked[0]);
    ok(checks.apifyLast.settled === false && checks.apifyLast.usd === 0.045 && timers[0] === 20000,
      "while any run is unsettled the figure is left alone and asked again in 20 s", JSON.stringify(checks.apifyLast));
    await run(1);
    ok(checks.apifyLast.settled === true && checks.apifyLast.usd === 0.062 && checks.apifyCheckUsd === 0.062,
      "once all have settled the press's cost is their exact sum, and becomes the price of a check",
      JSON.stringify(checks.apifyLast) + " check=" + checks.apifyCheckUsd);

    const t2 = [];
    const c2 = { apifyLast: { ...press(), full: false } };
    await make(c2, [{ ok: true, settle: [{ runId: "runA", usd: 0.03, settled: true }, { runId: "runB", usd: 0.02, settled: true }] }], t2).run();
    ok(c2.apifyLast.usd === 0.05 && c2.apifyCheckUsd === undefined,
      "a press that was not a full check is settled but never taken as the price", JSON.stringify(c2));

    const t3 = [];
    const c3 = { apifyLast: { usd: 0.098, runs: 6, settled: true, at: "t0" } };
    const m3 = make(c3, [{ ok: true, remainingUsd: 1.2 }], t3);
    await m3.run();
    ok(!/runs=/.test(m3.asked[0]) && !t3.length, "a settled press asks for nothing more", m3.asked[0]);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
