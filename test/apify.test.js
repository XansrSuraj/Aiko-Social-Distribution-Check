/**
 * api/collect.js — the Instagram and Facebook arms, read server-side through Apify, with a stubbed
 * fetch. Apify runs a scraper "actor" and returns the dataset items as JSON from a single
 * run-sync-get-dataset-items POST; these fixtures reproduce the fields each actor actually emits
 * (verified against apify/instagram-post-scraper and apify/facebook-posts-scraper), not the whole
 * item, since the mapper only reads a handful of them.
 *
 * The two things worth pinning here are the ones that would quietly cost a post or mis-count one:
 * a tagged post carrying someone else's ownerUsername (must be dropped), and the ~15-minute cache
 * that keeps repeated daily-check runs from each spending a paid Apify call.
 *
 *   node test/apify.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "collect.js");
const STORE = path.join(__dirname, "..", "ingest-store.js");
const realFetch = global.fetch;
function load() { delete require.cache[require.resolve(MOD)]; return require(MOD); }

const ago = mins => new Date(Date.now() - mins * 60e3).toISOString();
let pass = 0, fail = 0;
const check = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };

/* run one collect for a single channel, with fetch stubbed to answer the Apify run-sync route */
function runApify(channel, itemsByActor, opts) {
  const o = opts || {};
  const calls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
    const which = /instagram-post-scraper/.test(u) ? "ig" : /facebook-posts-scraper/.test(u) ? "fb"
                : /tiktok-scraper/.test(u) ? "tt" : null;
    if (which) return { status: 201, text: async () => JSON.stringify(itemsByActor[which] || []) };
    return { status: 200, text: async () => "<html>a platform page — must not be used when a token is set</html>" };
  };
  if (o.token !== null) process.env.APIFY_TOKEN = o.token || "apify-test-key";
  const handler = load();
  return new Promise(resolve => handler(
    { method: "POST", body: { channels: [channel], hours: o.hours || 48 } },
    { setHeader() {}, status() { return this; }, json: p => resolve({ res: p.results[0], calls }) }
  )).finally(() => { global.fetch = realFetch; if (o.token !== null) delete process.env.APIFY_TOKEN; });
}

(async () => {
  const store = require(STORE);
  const wipeCache = async () => { const all = await store.readAll(); delete all.__cache; await store.writeAll(all); };
  await wipeCache();

  console.log("── Instagram via Apify");
  {
    const items = [
      { id: "ig1", shortCode: "AbC", timestamp: ago(30), type: "Video", productType: "clips",
        caption: "Bàn thắng đẹp nhất tuần", url: "https://www.instagram.com/p/AbC/",
        likesCount: 120, commentsCount: 8, videoViewCount: 5000, videoDuration: 15,
        displayUrl: "https://scontent.cdninstagram.com/a.jpg", ownerUsername: "sportsfcvn" },
      { id: "ig2", shortCode: "DeF", timestamp: ago(300), type: "Sidecar",
        caption: "album", url: "https://www.instagram.com/p/DeF/", ownerUsername: "sportsfcvn" },
      { id: "ig3", shortCode: "GhI", timestamp: ago(120), type: "Image",
        caption: "not ours — tagged", ownerUsername: "someone_else" },   // must be dropped
    ];
    const ch = { id: "ig", platform: "instagram", url: "https://www.instagram.com/sportsfcvn/" };
    const { res, calls } = await runApify(ch, { ig: items });
    check(res.ok === true && res.posts.length === 2, "only this channel's own posts come through — a tagged post is dropped",
      (res.posts || []).map(p => p.externalId).join(","));
    check(res.source === "instagram-apify", "the run says it read via Apify", String(res.source));
    check(res.posts[0].externalId === "ig1", "newest first — the report relies on it",
      (res.posts || []).map(p => p.externalId).join(","));
    check(res.posts[0].kind === "reel", "a clip maps to reel", res.posts[0].kind);
    check(res.posts.find(p => p.externalId === "ig2").kind === "carousel", "a sidecar maps to carousel");
    check(res.posts[0].likes === 120 && res.posts[0].views === 5000, "counts land in the shared fields",
      `likes=${res.posts[0].likes} views=${res.posts[0].views}`);
    check(/huyền|thắng|Bàn/.test(res.posts[0].text), "the caption comes through for the language check", res.posts[0].text.slice(0, 24));
    check(calls[0].url.includes("token=apify-test-key") && calls[0].url.includes("instagram-post-scraper"),
      "the token and actor travel in the run-sync URL");
    check(calls[0].body && calls[0].body.skipPinnedPosts === true && Array.isArray(calls[0].body.username),
      "pinned posts are skipped and the username is passed", JSON.stringify(calls[0].body.username));
  }

  console.log("\n── Facebook via Apify");
  {
    const items = [
      { postId: "fb1", url: "https://www.facebook.com/Sportsfcvn/posts/1", time: ago(45), text: "Trận cầu tâm điểm",
        likes: 40, comments: 5, shares: 3, viewsCount: 900, media: [{ type: "Video", videoUrl: "https://video.fb/v.mp4", thumbnail: "https://fb/t.jpg" }] },
      { postId: "fb2", timestamp: Math.floor((Date.now() - 200 * 60e3) / 1000), text: "just words", media: [] },
    ];
    const ch = { id: "fb", platform: "facebook", url: "https://www.facebook.com/Sportsfcvn" };
    const { res, calls } = await runApify(ch, { fb: items });
    check(res.ok === true && res.posts.length === 2, "the page's recent posts come through", (res.posts || []).map(p => p.externalId).join(","));
    check(res.source === "facebook-apify", "the run says it read via Apify", String(res.source));
    check(res.posts[0].externalId === "fb1" && res.posts[0].kind === "video", "a post with a video maps to video, newest first", res.posts[0].kind);
    check(res.posts.find(p => p.externalId === "fb2").kind === "text", "a words-only post maps to text");
    check(res.posts[0].reposts === 3 && res.posts[0].views === 900, "shares and views land in their fields",
      `shares=${res.posts[0].reposts} views=${res.posts[0].views}`);
    /* the numeric-only timestamp on fb2 (unix seconds) must resolve to a real, recent instant */
    const t2 = new Date(res.posts.find(p => p.externalId === "fb2").ts).getTime();
    check(isFinite(t2) && Math.abs(Date.now() - t2 - 200 * 60e3) < 5 * 60e3, "a seconds-only timestamp is read correctly");
    check(calls[0].url.includes("facebook-posts-scraper") && calls[0].body.startUrls[0].url.includes("facebook.com/Sportsfcvn"),
      "the page URL is passed to the FB actor");
  }

  console.log("\n── TikTok via Apify");
  {
    const items = [
      { id: "tt1", createTimeISO: ago(40), text: "Bàn thắng đẹp nhất tuần 🔥", webVideoUrl: "https://www.tiktok.com/@sportsfc.fans/video/tt1",
        playCount: 12000, diggCount: 800, commentCount: 30, shareCount: 45, authorMeta: { name: "sportsfc.fans" }, videoMeta: { duration: 18, coverUrl: "https://tt/c.jpg" } },
      { id: "tt2", createTimeISO: ago(310), text: "another clip", webVideoUrl: "https://www.tiktok.com/@sportsfc.fans/video/tt2", authorMeta: { name: "sportsfc.fans" } },
      { id: "tt3", createTimeISO: ago(90), text: "not ours", authorMeta: { name: "someone_else" } },   // reshare — must drop
    ];
    const ch = { id: "tt", platform: "tiktok", url: "https://www.tiktok.com/@sportsfc.fans" };
    const { res, calls } = await runApify(ch, { tt: items });
    check(res.ok === true && res.posts.length === 2, "only this profile's own videos come through — a reshare is dropped",
      (res.posts || []).map(p => p.externalId).join(","));
    check(res.source === "tiktok-apify", "the run says it read via Apify", String(res.source));
    check(res.posts[0].externalId === "tt1" && res.posts[0].kind === "video", "newest first, kind video", res.posts[0].kind);
    check(res.posts[0].views === 12000 && res.posts[0].likes === 800 && res.posts[0].reposts === 45,
      "counts land in the shared fields", `views=${res.posts[0].views} likes=${res.posts[0].likes} shares=${res.posts[0].reposts}`);
    check(/Bàn|thắng/.test(res.posts[0].text), "the caption comes through for the language check", res.posts[0].text.slice(0, 24));
    check(calls[0].url.includes("tiktok-scraper") && calls[0].body.profiles[0] === "sportsfc.fans",
      "the profile is passed to the TikTok actor");
  }

  console.log("\n── the ~15-minute cache spares a second paid call");
  {
    await wipeCache();
    const items = [{ id: "c1", shortCode: "Zzz", timestamp: ago(10), type: "Image", caption: "hi", ownerUsername: "sportsfcvn" }];
    const ch = { id: "ig", platform: "instagram", url: "https://www.instagram.com/sportsfcvn/" };
    const first = await runApify(ch, { ig: items });
    const before = first.calls.length;
    const second = await runApify(ch, { ig: items });
    const apiCalls = second.calls.filter(c => /instagram-post-scraper/.test(c.url)).length;
    check(first.res.ok && before >= 1, "first run fetches from Apify", `calls=${before}`);
    check(second.res.ok && /cached/.test(second.res.note || "") && apiCalls === 0,
      "second run inside the window is served from cache — no extra paid call",
      `note="${second.res.note}" apiCalls=${apiCalls}`);
    await wipeCache();
  }

  console.log("\n── without a token, Facebook still says use the extension");
  {
    const ch = { id: "fb", platform: "facebook", url: "https://www.facebook.com/Sportsfcvn" };
    const { res } = await runApify(ch, {}, { token: null });
    check(res.browserRequired === true && res.source === "browser-required",
      "no APIFY_TOKEN → Facebook falls back to browser-required", res.source);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
