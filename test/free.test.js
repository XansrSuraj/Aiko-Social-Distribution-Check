/**
 * api/collect.js — the free readers (Facebook's Reels tab, Instagram's and TikTok's embed widgets),
 * read first, with Apify only as the fallback. Fixtures reproduce the shape of the real pages
 * (measured 2026-10-03), trimmed to the fields read.
 *
 * Pinned: a free read is used as-is and Apify is not called; captions, times, covers and counters
 * come through; a free page that fails, comes back empty, or carries only old posts falls through
 * to Apify with the reason named; FREE_READERS=off goes straight to Apify.
 *
 *   node test/free.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "collect.js");
const STORE = path.join(__dirname, "..", "ingest-store.js");
const realFetch = global.fetch;
let pass = 0, fail = 0;
const check = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };

const secAgo = mins => Math.floor((Date.now() - mins * 60e3) / 1000);
/* a TikTok id whose top 32 bits are the given unix seconds */
const ttId = secs => String((BigInt(secs) << 32n) + 123456789n);

const FB_HTML = posts => `<html><script type="application/json" data-sjs>${JSON.stringify({ require: [["x", { data: { stories: posts.map(p => ({
  __typename: "Story", post_id: p.id, creation_time: p.t,
  message: { text: p.text, ranges: [{ entity: { __typename: "Hashtag", name: "#UEFANationsLeague" } }] },
  actors: [{ name: "Sports FC" }],
  short_form_video_context: {
    video: { id: "9" + p.id, playable_duration_in_ms: 42533, first_frame_thumbnail: "https://scontent.fbcdn.net/f.jpg" },
    shareable_url: "https://www.facebook.com/reel/9" + p.id,
    playback_video: { width: 1080, height: 1920, thumbnailImage: { uri: "https://scontent.fbcdn.net/t.jpg" } },
    play_count_reduced: 303,
  } })) } }]] })}</script></html>`;
const IG_HTML = (user, nodes) => {
  const ctx = JSON.stringify({ context: { graphql_media: nodes.map(n => ({ shortcode_media: {
    __typename: "GraphVideo", shortcode: n.code, is_video: true, taken_at_timestamp: n.t,
    display_url: "https://instagram.fxyz.fbcdn.net/d.jpg", dimensions: { width: 720, height: 1280 },
    edge_media_to_caption: { edges: [{ node: { text: n.text } }] },
    edge_liked_by: { count: 12 }, edge_media_to_comment: { count: 3 }, owner: { username: user } } })) } });
  return `<html><script>window.x={"contextJSON":${JSON.stringify(ctx)}}</script></html>`;
};
const TT_HTML = items => `<html><script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify({ source: { data: { "/embed/@sportsfc.vn": { videoList: items.map(i => ({
  id: i.id, desc: i.text, coverUrl: "https://p16-sign.tiktokcdn-us.com/c.jpeg", playCount: 310, width: 576, height: 1024,
  privateItem: false, authorUniqueId: "sportsfc.vn" })) } } } })}</script>
  ${items.map(i => `<a href="https://www.tiktok.com/@sportsfc.vn/video/${i.id}">x</a>`).join("")}</html>`;

/* fetch: the three free pages from `pages`, a minimal Apify for the fallback */
function stub(pages) {
  const calls = [];
  global.fetch = async (url, init) => {
    const u = String(url), method = (init && init.method) || "GET";
    calls.push({ u, method });
    const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
    if (u.startsWith("https://api.apify.com/v2/")) {
      const p = new URL(u).pathname;
      if (method === "POST") return json(201, { data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1", usageTotalUsd: 0.03,
                                                         chargedEventCounts: { "apify-default-dataset-item": 1, post: 1, result: 1 } } });
      if (/actor-runs/.test(p)) return json(200, { data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1", usageTotalUsd: 0.03,
                                                            chargedEventCounts: { "apify-default-dataset-item": 1, post: 1, result: 1 } } });
      if (/datasets/.test(p)) return json(200, [{ post_id: "A1", time: new Date(Date.now() - 5 * 60e3).toISOString(), text: "",
        shortCode: "A1", timestamp: new Date(Date.now() - 5 * 60e3).toISOString(), type: "Image", ownerUsername: "sportsfc.vn",
        id: "7600000000000000001", createTimeISO: new Date(Date.now() - 5 * 60e3).toISOString(), authorMeta: { name: "sportsfc.vn" } }]);
    }
    for (const [re, page] of pages) if (re.test(u)) return { status: page.status || 200, text: async () => page.html };
    return { status: 404, text: async () => "not found" };
  };
  return calls;
}
function collect(channels, pages, env) {
  const calls = stub(pages);
  const saved = {};
  for (const [k, v] of Object.entries(env || {})) { saved[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  delete require.cache[require.resolve(MOD)];
  const handler = require(MOD);
  return new Promise(resolve => handler({ method: "POST", body: { channels, hours: 48 } },
    { setHeader() {}, status() { return this; }, json: p => resolve({ payload: p, calls }) }))
    .finally(() => { global.fetch = realFetch; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
const at = (payload, id) => payload.results.find(r => r.channelId === id);

const FB = { id: "fb", platform: "facebook", url: "https://facebook.com/sportsfc.vn" };
const IG = { id: "ig", platform: "instagram", url: "https://instagram.com/sportsfc.vn" };
const TT = { id: "tt", platform: "tiktok", url: "https://www.tiktok.com/@sportsfc.vn" };

(async () => {
  const store = require(STORE);
  const wipe = async () => { const all = await store.readAll(); delete all.__cache; await store.writeAll(all); };
  await wipe();

  console.log("── the free readers answer, Apify is not called");
  {
    const t1 = secAgo(30), t2 = secAgo(150);
    const { payload, calls } = await collect([FB, IG, TT], [
      [/facebook\.com\/sportsfc\.vn\/reels\/$/, { html: FB_HTML([{ id: "1221", t: t1, text: "https://sfc.my/r/abc\n\nMODRIC đối đầu BELLINGHAM" },
                                                                 { id: "1220", t: t2, text: "older one" }]) }],
      [/instagram\.com\/sportsfc\.vn\/embed\/$/, { html: IG_HTML("sportsfc.vn", [{ code: "DeB1", t: t1, text: "Trận đấu này" },
                                                                                  { code: "DeB0", t: t2, text: "older" },
                                                                                  { code: "Zz9", t: t1, text: "a collab", }].map((n, i) => i === 2 ? { ...n } : n)) }],
      [/tiktok\.com\/embed\/@sportsfc\.vn$/, { html: TT_HTML([{ id: ttId(t1), text: "https://sfc.my/r/tt1 MODRIC" }, { id: ttId(t2), text: "older" }]) }],
    ], { APIFY_TOKEN: "tok" });
    const fb = at(payload, "fb"), ig = at(payload, "ig"), tt = at(payload, "tt");
    check(fb.ok && fb.source === "facebook-free" && fb.posts.length === 2, "Facebook read free", `${fb.source} ${fb.posts.length}`);
    const f0 = fb.posts[0];
    check(f0.externalId === "1221" && Math.abs(new Date(f0.ts) / 1000 - t1) < 1 && /MODRIC/.test(f0.text) && f0.kind === "reel" &&
          f0.thumb === "https://scontent.fbcdn.net/t.jpg" && f0.permalink === "https://www.facebook.com/reel/91221" &&
          f0.views === 303 && f0.duration === 43 && f0.link === "https://sfc.my/r/abc" && f0.hashtags[0] === "UEFANationsLeague" &&
          f0.author === "Sports FC", "Facebook: time, caption, reel link, cover, plays, length, link, hashtags, page", JSON.stringify(f0).slice(0, 160));
    check(ig.ok && ig.source === "instagram-free" && ig.posts[0].externalId === "DeB1" && ig.posts[0].thumb.includes("fbcdn") &&
          ig.posts[0].likes === 12 && ig.posts[0].comments === 3 && ig.posts[0].kind === "reel" && /Trận/.test(ig.posts[0].text),
      "Instagram read free: shortcode, time, caption, preview, likes, comments", JSON.stringify(ig.posts[0]).slice(0, 140));
    check(tt.ok && tt.source === "tiktok-free" && Math.abs(new Date(tt.posts[0].ts) / 1000 - t1) < 1 && /MODRIC/.test(tt.posts[0].text) &&
          tt.posts[0].views === 310 && tt.posts[0].thumb.includes("tiktokcdn") && tt.posts[0].link === "https://sfc.my/r/tt1",
      "TikTok read free: time from the video id, caption, cover, plays", JSON.stringify(tt.posts[0]).slice(0, 140));
    check(!calls.some(c => /api\.apify\.com/.test(c.u)) && payload.apifyRuns === 0 && payload.apifyCostUsd === 0,
      "no Apify run at all — the check cost nothing");
    check(/no Apify/.test(fb.note), "the note says how it was read", fb.note);
  }

  console.log("\n── a free read that fails or looks wrong falls back to Apify, reason named");
  {
    await wipe();
    const old = secAgo(6 * 24 * 60);
    const { payload } = await collect([FB, IG, TT], [
      [/facebook\.com\/sportsfc\.vn\/reels\/$/, { status: 400, html: "bad request" }],
      [/instagram\.com\/sportsfc\.vn\/embed\/$/, { html: "<html>no posts here</html>" }],
      [/tiktok\.com\/embed\/@sportsfc\.vn$/, { html: TT_HTML([{ id: ttId(old), text: "six days old" }]) }],
    ], { APIFY_TOKEN: "tok" });
    const fb = at(payload, "fb"), ig = at(payload, "ig"), tt = at(payload, "tt");
    check(fb.ok && fb.source === "facebook-reels" && /free read failed first: HTTP 400/.test(fb.note), "Facebook HTTP 400 → Apify", fb.note);
    check(ig.ok && ig.source === "instagram-apify" && /no posts found/.test(ig.note), "Instagram empty widget → Apify", ig.note);
    check(tt.ok && tt.source === "tiktok-apify" && /older than 4 days/.test(tt.note), "TikTok only old posts → Apify (stale, not trusted)", tt.note);
    check(payload.apifyRuns === 3, "and those fallbacks are counted in the cost", String(payload.apifyRuns));
  }

  console.log("\n── FREE_READERS=off goes straight to Apify");
  {
    await wipe();
    const { payload, calls } = await collect([FB], [[/facebook/, { html: FB_HTML([{ id: "1", t: secAgo(5), text: "x" }]) }]],
                                           { APIFY_TOKEN: "tok", FREE_READERS: "off" });
    check(at(payload, "fb").source === "facebook-reels" && !calls.some(c => /facebook\.com/.test(c.u)),
      "the free page is never fetched", at(payload, "fb").source);
  }
  await wipe();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
