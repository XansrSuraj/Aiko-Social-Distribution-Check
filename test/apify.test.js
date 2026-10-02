/**
 * api/collect.js — Facebook, Instagram, TikTok and X read server-side through Apify, against a
 * stubbed fetch that plays Apify's own API: POST /acts/{actor}/runs starts a run, GET
 * /actor-runs/{id} reports it (with usageTotalUsd — the run's billed cost), GET
 * /datasets/{id}/items hands back the items. The item fixtures reproduce the fields each actor
 * actually emits (apify/instagram-post-scraper at basicData, apify/facebook-posts-scraper,
 * clockworks/tiktok-scraper, xquik/x-tweet-scraper), not whole items — the mappers read a handful.
 *
 * What is pinned here is what would quietly cost a post, mis-count one, or spend money:
 *   · a tagged post / reshare / retweet carrying someone else's name is dropped
 *   · each run asks for APIFY_MAX_POSTS items, with every paid add-on switched off
 *   · each result carries the run's own cost, and the response sums them
 *   · a restricted profile reports the actor's reason, not a silent "no posts"
 *   · the ~15-minute cache keeps a second click from paying again
 *   · the free plan's memory cap is waited out, and an exhausted credit is named as such
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

const ACTOR_KEY = u => /instagram-post-scraper/.test(u) ? "ig" : /facebook-posts-scraper/.test(u) ? "fb"
                     : /tiktok-scraper/.test(u) ? "tt" : /x-tweet-scraper/.test(u) ? "x" : null;
const COST = { ig: 0.0102, fb: 0.031, tt: 0.0232, x: 0.0009 };

/* A fake Apify. opts.pending: the run answers RUNNING first and SUCCEEDED on the next poll.
   opts.startFail: a list of {status, message} answers the start call gives before it succeeds. */
function fakeApify(itemsByActor, opts) {
  const o = opts || {};
  const calls = [];
  const runs = {};
  let seq = 0;
  const startFail = (o.startFail || []).slice();
  const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  global.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || "GET";
    calls.push({ url: u, method, body: init && init.body ? JSON.parse(init.body) : null });
    if (!u.startsWith("https://api.apify.com/v2/")) {
      return { status: 200, text: async () => "<html>a platform page — must not be used when a token is set</html>" };
    }
    const p = new URL(u).pathname.replace("/v2", "");
    let m;
    if (method === "POST" && (m = p.match(/^\/acts\/([^/]+)\/runs$/))) {
      const f = startFail.shift();
      if (f) return json(f.status, { error: { type: "x", message: f.message } });
      const key = ACTOR_KEY(m[1]);
      const id = "run" + (++seq);
      runs[id] = { key, polls: 0 };
      return json(201, { data: { id, status: o.pending ? "RUNNING" : "SUCCEEDED", defaultDatasetId: "ds-" + id,
                                 usageTotalUsd: COST[key], chargedEventCounts: { post: 6 } } });
    }
    if (method === "GET" && (m = p.match(/^\/actor-runs\/([^/]+)$/))) {
      const r = runs[m[1]]; r.polls++;
      return json(200, { data: { id: m[1], status: "SUCCEEDED", defaultDatasetId: "ds-" + m[1],
                                 usageTotalUsd: COST[r.key], chargedEventCounts: { post: 6 } } });
    }
    if (method === "GET" && (m = p.match(/^\/datasets\/ds-([^/]+)\/items$/))) {
      return json(200, itemsByActor[runs[m[1]].key] || []);
    }
    return json(404, { error: { message: "not stubbed: " + method + " " + p } });
  };
  return calls;
}

/* run one /api/collect request for the given channels against the fake */
function collect(channels, itemsByActor, opts) {
  const o = opts || {};
  const calls = fakeApify(itemsByActor, o);
  if (o.token !== null) process.env.APIFY_TOKEN = "apify-test-key";
  const handler = load();
  return new Promise(resolve => handler(
    { method: "POST", body: { channels, hours: o.hours || 48 } },
    { setHeader() {}, status() { return this; }, json: p => resolve({ payload: p, res: p.results[0], calls }) }
  )).finally(() => {
    global.fetch = realFetch;
    delete process.env.APIFY_TOKEN;
  });
}
const started = calls => calls.filter(c => c.method === "POST" && /\/runs\?/.test(c.url));
const q = (call, k) => new URL(call.url).searchParams.get(k);

const IG = { id: "ig", platform: "instagram", url: "https://www.instagram.com/sportsfcvn/" };
const FB = { id: "fb", platform: "facebook", url: "https://www.facebook.com/Sportsfcvn" };
const TT = { id: "tt", platform: "tiktok", url: "https://www.tiktok.com/@sportsfc.fans" };
const X  = { id: "x",  platform: "x", url: "https://x.com/Sportsfcvn" };

(async () => {
  const store = require(STORE);
  const wipeCache = async () => { const all = await store.readAll(); delete all.__cache; await store.writeAll(all); };
  await wipeCache();

  console.log("── Instagram via Apify");
  {
    const items = [
      { id: "1", shortCode: "AbC", timestamp: ago(30), type: "Video", productType: "clips",
        caption: "Bàn thắng đẹp nhất tuần", url: "https://www.instagram.com/p/AbC/",
        likesCount: 120, commentsCount: 8, videoViewCount: 5000, videoDuration: 15,
        displayUrl: "https://scontent.cdninstagram.com/a.jpg", ownerUsername: "sportsfcvn" },
      { id: "2", shortCode: "DeF", timestamp: ago(300), type: "Sidecar",
        caption: "album", url: "https://www.instagram.com/p/DeF/", ownerUsername: "sportsfcvn" },
      { id: "3", shortCode: "GhI", timestamp: ago(120), type: "Image",
        caption: "not ours — tagged", ownerUsername: "someone_else" },   // must be dropped
    ];
    const { res, calls, payload } = await collect([IG], { ig: items });
    check(res.ok === true && res.posts.length === 2, "only this channel's own posts come through — a tagged post is dropped",
      (res.posts || []).map(p => p.externalId).join(","));
    check(res.source === "instagram-apify", "the run says it read via Apify", String(res.source));
    check(res.posts[0].externalId === "AbC", "the shortcode is the id — the same one the extension reports, so reads merge",
      (res.posts || []).map(p => p.externalId).join(","));
    check(res.posts[0].kind === "reel", "a clip maps to reel", res.posts[0].kind);
    check(res.posts.find(p => p.externalId === "DeF").kind === "carousel", "a sidecar maps to carousel");
    check(res.posts[0].likes === 120 && res.posts[0].views === 5000, "counts land in the shared fields",
      `likes=${res.posts[0].likes} views=${res.posts[0].views}`);
    check(/Bàn/.test(res.posts[0].text), "the caption comes through for the language check", res.posts[0].text.slice(0, 24));
    const s = started(calls)[0];
    check(s && s.url.includes("token=apify-test-key") && s.url.includes("instagram-post-scraper"),
      "the token and actor travel in the run URL");
    check(s.body.dataDetailLevel === "basicData" && s.body.skipPinnedPosts === true && s.body.resultsLimit === 6 &&
          s.body.username[0] === "sportsfcvn" && !("onlyPostsNewerThan" in s.body),
      "basicData (no per-post details charge), pinned skipped, 6 posts, no date filter", JSON.stringify(s.body));
    check(q(s, "memory") === "512" && Number(q(s, "maxTotalChargeUsd")) > 0,
      "memory is pinned and a spending cap is set on the run", `memory=${q(s, "memory")} cap=${q(s, "maxTotalChargeUsd")}`);
    check(res.cost && res.cost.usd === COST.ig && res.cost.cached === false && res.cost.events.post === 6,
      "the result carries the run's own billed cost", JSON.stringify(res.cost));
    check(payload.apifyCostUsd === COST.ig && payload.apifyRuns === 1, "the response totals what the request spent",
      `apifyCostUsd=${payload.apifyCostUsd} runs=${payload.apifyRuns}`);
    check(!calls.some(c => /instagram\.com\/api/.test(c.url)), "the public endpoint is not touched when a token is set");
  }

  console.log("\n── Facebook via Apify");
  {
    const items = [
      { postId: "101", url: "https://www.facebook.com/Sportsfcvn/posts/101", time: ago(45), text: "Trận cầu tâm điểm",
        likes: 40, comments: 5, shares: 3, viewsCount: 900, media: [{ type: "Video", videoUrl: "https://video.fb/v.mp4", thumbnail: "https://fb/t.jpg" }] },
      { postId: "102", timestamp: Math.floor((Date.now() - 200 * 60e3) / 1000), text: "just words", media: [] },
      { postId: "103", url: "https://www.facebook.com/reel/103", time: ago(100), text: "a reel", media: [] },
    ];
    const { res, calls } = await collect([FB], { fb: items });
    check(res.ok === true && res.posts.length === 3, "the page's recent posts come through", (res.posts || []).map(p => p.externalId).join(","));
    check(res.source === "facebook-apify", "the run says it read via Apify", String(res.source));
    check(res.posts[0].externalId === "101" && res.posts[0].kind === "video", "a post with a video maps to video, newest first", res.posts[0].kind);
    check(res.posts.find(p => p.externalId === "102").kind === "text", "a words-only post maps to text");
    check(res.posts.find(p => p.externalId === "103").kind === "reel", "a /reel/ URL maps to reel");
    check(res.posts[0].reposts === 3 && res.posts[0].views === 900, "shares and views land in their fields",
      `shares=${res.posts[0].reposts} views=${res.posts[0].views}`);
    const t2 = new Date(res.posts.find(p => p.externalId === "102").ts).getTime();
    check(isFinite(t2) && Math.abs(Date.now() - t2 - 200 * 60e3) < 5 * 60e3, "a seconds-only timestamp is read correctly");
    const s = started(calls)[0];
    check(s.url.includes("facebook-posts-scraper") && s.body.startUrls[0].url.includes("facebook.com/Sportsfcvn") &&
          s.body.resultsLimit === 6 && s.body.captionText === false && !("onlyPostsNewerThan" in s.body),
      "page URL passed, 6 posts, paid caption transcription off, no date filter", JSON.stringify(s.body));
    check(res.cost && res.cost.usd === COST.fb, "the result carries the run's own billed cost", JSON.stringify(res.cost));
  }

  console.log("\n── TikTok via Apify");
  {
    const items = [
      { id: "7001", createTimeISO: ago(40), text: "Bàn thắng đẹp nhất tuần 🔥", webVideoUrl: "https://www.tiktok.com/@sportsfc.fans/video/7001",
        playCount: 12000, diggCount: 800, commentCount: 30, shareCount: 45, authorMeta: { name: "sportsfc.fans" }, videoMeta: { duration: 18, coverUrl: "https://tt/c.jpg" } },
      { id: "7002", createTimeISO: ago(310), text: "another clip", webVideoUrl: "https://www.tiktok.com/@sportsfc.fans/video/7002", authorMeta: { name: "sportsfc.fans" } },
      { id: "7003", createTimeISO: ago(90), text: "not ours", authorMeta: { name: "someone_else" } },   // reshare — must drop
    ];
    const { res, calls } = await collect([TT], { tt: items });
    check(res.ok === true && res.posts.length === 2, "only this profile's own videos come through — a reshare is dropped",
      (res.posts || []).map(p => p.externalId).join(","));
    check(res.source === "tiktok-apify", "the run says it read via Apify", String(res.source));
    check(res.posts[0].externalId === "7001" && res.posts[0].kind === "video", "newest first, kind video", res.posts[0].kind);
    check(res.posts[0].views === 12000 && res.posts[0].likes === 800 && res.posts[0].reposts === 45,
      "counts land in the shared fields", `views=${res.posts[0].views} likes=${res.posts[0].likes} shares=${res.posts[0].reposts}`);
    const s = started(calls)[0];
    const b = s.body;
    check(b.profiles[0] === "sportsfc.fans" && b.resultsPerPage === 6 && b.excludePinnedPosts === true &&
          b.profileSorting === "latest" && !("oldestPostDateUnified" in b),
      "profile passed, 6 newest, pinned excluded, no (paid) date filter", JSON.stringify(b).slice(0, 140));
    check(b.shouldDownloadVideos === false && b.shouldDownloadCovers === false && b.shouldDownloadSlideshowImages === false &&
          b.shouldDownloadAvatars === false && b.shouldDownloadMusicCovers === false &&
          b.downloadSubtitlesOptions === "NEVER_DOWNLOAD_SUBTITLES" && b.proxyCountryCode === "None",
      "every separately-billed download and the paid proxy country are off");
    check(q(s, "memory") === "2048", "memory pinned so the whole check fits the free plan's 8 GB", q(s, "memory"));
  }

  console.log("\n── X via Apify");
  {
    const xDate = mins => new Date(Date.now() - mins * 60e3).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1 $3 $2 $5 +0000 $4");
    const items = [
      { id: "1900", text: "Trận cầu tâm điểm tối nay", createdAt: xDate(25), url: "https://x.com/Sportsfcvn/status/1900",
        author: { username: "Sportsfcvn" }, viewCount: 300, likeCount: 12, replyCount: 1, retweetCount: 2,
        media: [{ type: "video", url: "https://pbs/x.jpg" }] },
      { id: "1899", text: "RT someone", createdAt: xDate(60), author: { username: "Sportsfcvn" }, isRetweet: true },
      { id: "1898", text: "not ours", createdAt: xDate(70), author: { username: "someone_else" } },
      { id: "1897", text: "words only", createdAt: xDate(400), author: { username: "sportsfcvn" } },
    ];
    const { res, calls } = await collect([X], { x: items });
    check(res.ok === true && res.posts.map(p => p.externalId).join(",") === "1900,1897",
      "own posts only — a retweet and another author's post are dropped", (res.posts || []).map(p => p.externalId).join(","));
    check(res.source === "x-apify", "the run says it read via Apify", String(res.source));
    check(Math.abs(Date.now() - new Date(res.posts[0].ts).getTime() - 25 * 60e3) < 2 * 60e3,
      "X's own \"Wed Oct 01 13:00:00 +0000 2026\" date form is read correctly", res.posts[0].ts);
    check(res.posts[0].kind === "video" && res.posts[1].kind === "text", "media type maps to kind");
    const s = started(calls)[0];
    check(s.url.includes("x-tweet-scraper") && s.body.twitterHandles[0] === "Sportsfcvn" && s.body.mode === "profileTweets" &&
          s.body.maxItems === 6 && s.body.tweetTypes.excludeRetweets === true && s.body.tweetTypes.excludeReplies === true,
      "handle passed, 6 posts, replies and retweets excluded before they are billed", JSON.stringify(s.body));
    check(!calls.some(c => /twitterapi\.io|^https:\/\/x\.com/.test(c.url)), "no other X route is touched when Apify answers");
  }

  console.log("\n── a whole check: four platforms, one request, one total");
  {
    await wipeCache();
    const { payload } = await collect([IG, FB, TT, X], {
      ig: [{ shortCode: "Q1", timestamp: ago(5), type: "Image", caption: "a", ownerUsername: "sportsfcvn" }],
      fb: [{ postId: "9", time: ago(5), text: "b" }],
      tt: [{ id: "8", createTimeISO: ago(5), text: "c", authorMeta: { name: "sportsfc.fans" } }],
      x:  [{ id: "7", createdAt: ago(5), text: "d", author: { username: "Sportsfcvn" } }],
    });
    const want = Math.round((COST.ig + COST.fb + COST.tt + COST.x) * 1e6) / 1e6;
    check(payload.results.every(r => r.ok) && payload.apifyRuns === 4 && payload.apifyCostUsd === want,
      "apifyCostUsd is the sum of every run's own figure", `got ${payload.apifyCostUsd}, want ${want}`);
  }

  console.log("\n── a run still going when first asked is waited for, not abandoned");
  {
    await wipeCache();
    const { res, calls } = await collect([IG], { ig: [{ shortCode: "P1", timestamp: ago(5), type: "Image", caption: "x", ownerUsername: "sportsfcvn" }] },
                                        { pending: true });
    const polls = calls.filter(c => c.method === "GET" && /\/actor-runs\//.test(c.url)).length;
    check(res.ok && res.posts.length === 1 && polls >= 1, "polled until SUCCEEDED, then read", `polls=${polls}`);
  }

  console.log("\n── the free plan's memory cap is waited out, not reported as a dead channel");
  {
    await wipeCache();
    const { res, calls } = await collect([X], { x: [{ id: "5", createdAt: ago(5), text: "d", author: { username: "Sportsfcvn" } }] },
      { startFail: [{ status: 402, message: "By launching this job you will exceed the memory limit of 8192MB for all your Actor runs" }] });
    check(res.ok && started(calls).length === 2, "retried once the memory frees up", `starts=${started(calls).length} note=${res.note}`);
  }

  console.log("\n── an exhausted monthly credit is named as such");
  {
    await wipeCache();
    process.env.TWITTERAPI_KEY = "";
    const { res } = await collect([IG], {}, { startFail: [{ status: 402, message: "You have reached your monthly usage hard limit" }] });
    check(res.ok === false && /credit is used up/.test(res.note), "the note says the credit ran out", res.note.slice(0, 90));
    delete process.env.TWITTERAPI_KEY;
  }

  console.log("\n── a restricted profile reports Instagram's reason, not a silent empty");
  {
    await wipeCache();
    const { res, payload } = await collect([IG], { ig: [{ url: "https://www.instagram.com/sportsfcvn", error: "restricted_profile",
      errorDescription: "This profile is restricted (age or country) and cannot be viewed without logging in." }] });
    check(res.ok === false && /restricted/.test(res.note) && /unknown, not empty/.test(res.note),
      "ok:false with the actor's own reason", res.note.slice(0, 100));
    check(res.cost && res.cost.usd === COST.ig && payload.apifyCostUsd === COST.ig,
      "a run that read nothing still reports what it was billed", JSON.stringify(res.cost));
  }

  console.log("\n── the ~15-minute cache spares a second paid call");
  {
    await wipeCache();
    const items = { ig: [{ shortCode: "Zzz", timestamp: ago(10), type: "Image", caption: "hi", ownerUsername: "sportsfcvn" }] };
    const first = await collect([IG], items);
    const second = await collect([IG], items);
    check(first.res.ok && started(first.calls).length === 1, "first run starts one Apify run");
    check(second.res.ok && /cached/.test(second.res.note || "") && started(second.calls).length === 0,
      "second run inside the window is served from cache — no extra paid call", `note="${second.res.note}"`);
    check(second.res.cost && second.res.cost.cached === true && second.payload.apifyCostUsd === 0 && second.payload.apifyRuns === 0,
      "a cached read reports zero spend", JSON.stringify(second.res.cost));
    await wipeCache();
  }

  console.log("\n── without a token, Facebook and TikTok go to the extension (never a false empty)");
  {
    for (const ch of [FB, TT]) {
      const { res, calls } = await collect([ch], {}, { token: null });
      check(res.ok === false && res.browserRequired === true && res.source === "browser-required" && res.posts.length === 0,
        ch.platform + " → browser-required, not a failure and not an empty success", res.note.slice(0, 70));
      check(!calls.some(c => /api\.apify\.com/.test(c.url)), ch.platform + ": Apify is never called without a token");
    }
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
