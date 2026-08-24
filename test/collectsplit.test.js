/**
 * collectServer(), read straight out of index.html, must split its work so a slow channel can never
 * take a fast one down with it. This is the regression guard for the outage where all 11 channels
 * went into ONE /api/collect request, the four Apify (Facebook/Instagram) reads pushed it past the
 * 60s function ceiling, and when it timed out every server channel — including the fast YouTube /
 * Telegram / X / Viber ones — came back blank.
 *
 * The contract this pins:
 *   · the fast channels share ONE request; each SLOW (facebook/instagram) channel gets its OWN
 *   · a request that fails leaves the OTHER requests' channels stored anyway (isolation)
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

/* the channels a real run collects: the fast four platforms plus the two Apify ones */
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
      return { json: async () => ({
        ok: true, collectedAt: "2026-08-24T00:00:00Z",
        results: body.channels.map(c => ({
          channelId: c.id, platform: c.platform, ok: true, source: "test",
          posts: [{ externalId: c.id + "-1", ts: "2026-08-24T00:00:00Z", text: "hi" }],
        })),
      }) };
    };
    return { fetchStub, requests };
  }

  /* 1) a healthy run */
  {
    const checks = { posts: {}, meta: {}, ytIds: {}, lastRun: null };
    const { fetchStub, requests } = stubFetch([]);
    await makeCollectServer(fetchStub, checks)({});

    ok(requests.length > 1, "more than one request is made — never a single big batch", `requests=${requests.length}`);
    const slowReqs = requests.filter(ids => ids.some(id => /^(fb|ig)/.test(id)));
    ok(slowReqs.every(ids => ids.length === 1), "each slow (Apify) channel is in its own request",
      JSON.stringify(slowReqs));
    const fastReq = requests.find(ids => ids.includes("yt-vn"));
    ok(fastReq && fastReq.includes("tg-vn") && fastReq.includes("x-vn") && fastReq.includes("vb-vn")
       && !fastReq.some(id => /^(fb|ig)/.test(id)),
      "the fast channels share one request, with no slow channel in it", JSON.stringify(fastReq));
    ok(["yt-vn","tg-vn","x-vn","vb-vn","fb-vn","fb-fans","ig-vn","ig-fans"].every(id => (checks.posts[id] || []).length === 1),
      "every channel's posts are stored");
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
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
