/**
 * extension/background.js — the Instagram parser (igScrape), checked against realistic Instagram
 * API responses. This has had ZERO test coverage until now, unlike X (x-ext.test.js, x-dom.test.js):
 * the mapping from Instagram's own JSON shapes into the report's post shape was never verified
 * against fixtures, only ever eyeballed. This exists so a change to the mapping — or a change in
 * Instagram's response shape — fails a fast local test instead of only ever showing up live.
 *
 * igScrape is pulled out of background.js between its own declaration and the next section's
 * banner comment (the same bounded-marker trick x-ext.test.js uses), then run with a stubbed
 * fetch() that plays back canned Instagram responses instead of a real network call.
 *
 *   node test/ig-ext.test.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
const START = "async function igScrape(usernames) {";
const END = "/* ═══════════════════ facebook: the fetch routes";
const a = SRC.indexOf(START), b = SRC.indexOf(END);
if (a === -1 || b === -1) { console.error("FAIL  could not find igScrape's bounds in background.js"); process.exit(1); }
const body = SRC.slice(a, b);

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

/* runs igScrape against a map of path -> { status, json } responses, standing in for fetch() */
function run(usernames, responses) {
  const fetchStub = async (reqPath) => {
    const hit = responses[reqPath];
    if (!hit) throw new Error("no stub for " + reqPath);
    return { status: hit.status, text: async () => JSON.stringify(hit.json || {}) };
  };
  const fn = new Function("fetch", "usernames", body + "\n;return igScrape(usernames);");
  return fn(fetchStub, usernames);
}

(async () => {
  /* ── route 1: the mobile feed, the one tried first ───────────────────────── */
  {
    const path1 = "/api/v1/feed/user/sportsfc.vn/username/?count=24";
    const res = await run(["sportsfc.vn"], {
      [path1]: { status: 200, json: { items: [
        {
          code: "Cabc123", pk: "111", taken_at: 1755000000, product_type: "clips",
          caption: { text: "Bàn thắng đẹp mắt" },
          play_count: 5000, like_count: 300, comment_count: 12, video_duration: 42.6,
          image_versions2: { candidates: [{ url: "https://scontent/x.jpg" }] },
          original_width: 1080, original_height: 1920,
        },
        {
          code: "Cdef456", pk: "222", taken_at: 1755001000, media_type: 8,
          caption: null, carousel_media_count: 3,
          image_versions2: { candidates: [{ url: "https://scontent/y.jpg" }] },
        },
      ] } },
    });
    const r = res["sportsfc.vn"];
    check(r.ok === true, "the feed route is trusted when it returns items", JSON.stringify(r.tried));
    check(r.posts.length === 2, "both items became posts", r.posts.length);
    const [reel, carousel] = r.posts;
    check(reel.kind === "reel", "clips product_type maps to a reel", reel.kind);
    check(reel.views === 5000 && reel.likes === 300 && reel.comments === 12, "counts are read off the item",
      JSON.stringify({ v: reel.views, l: reel.likes, c: reel.comments }));
    check(reel.duration === 43, "a fractional duration is rounded", reel.duration);
    check(reel.permalink === "https://www.instagram.com/reel/Cabc123/", "a reel permalink uses /reel/", reel.permalink);
    check(carousel.kind === "carousel" && carousel.slides === 3, "media_type 8 is a carousel, slide count kept",
      JSON.stringify({ kind: carousel.kind, slides: carousel.slides }));
    check(carousel.text === "", "a null caption becomes an empty string, not a crash", JSON.stringify(carousel.text));
    check(carousel.views === null, "a photo/carousel with no play_count reports null, not 0 — not-reported must stay distinguishable from a real zero",
      carousel.views);
  }

  /* ── route 2: web_profile_info, only reached when the feed gives nothing ─── */
  {
    const feedPath = "/api/v1/feed/user/sportsfc.fans/username/?count=24";
    const webPath = "/api/v1/users/web_profile_info/?username=sportsfc.fans";
    const res = await run(["sportsfc.fans"], {
      [feedPath]: { status: 400, json: { message: "ig_business_category_subvertical has been deleted" } },
      [webPath]: { status: 200, json: { data: { user: { edge_owner_to_timeline_media: { count: 40, edges: [
        {
          node: {
            shortcode: "Cghi789", taken_at_timestamp: 1755002000, __typename: "GraphVideo", is_video: true,
            edge_media_to_caption: { edges: [{ node: { text: "What a finish!" } }] },
            video_view_count: 9001, edge_media_preview_like: { count: 88 },
            edge_media_to_comment: { count: 4 }, video_duration: 12.2,
            dimensions: { width: 720, height: 1280 }, thumbnail_src: "https://scontent/z.jpg",
          },
        },
      ] } } } } },
    });
    const r = res["sportsfc.fans"];
    check(r.ok === true && r.route === "web", "falls back to the web route when the feed 400s",
      JSON.stringify(r.tried));
    check(r.totalPosts === 40, "the profile's total post count rides along", r.totalPosts);
    const p = r.posts[0];
    check(p.kind === "video", "GraphVideo + is_video maps to video", p.kind);
    check(p.text === "What a finish!", "caption is read out of the nested edge", p.text);
    check(p.views === 9001 && p.likes === 88 && p.comments === 4, "counts come from the web-route field names",
      JSON.stringify({ v: p.views, l: p.likes, c: p.comments }));
    /* GraphVideo without product_type:"clips" is "video", not "reel" — only the reel kind gets
       the /reel/ permalink; a plain video post uses /p/ like every other post */
    check(p.permalink === "https://www.instagram.com/p/Cghi789/", "a plain video (not a reel) permalink uses /p/", p.permalink);
  }

  /* ── a dead handle is named as such, not reported as merely empty ─────────── */
  {
    const feedPath = "/api/v1/feed/user/nosuchaccount/username/?count=24";
    const webPath = "/api/v1/users/web_profile_info/?username=nosuchaccount";
    const res = await run(["nosuchaccount"], {
      [feedPath]: { status: 200, json: {} },
      [webPath]: { status: 404, json: {} },
    });
    const r = res["nosuchaccount"];
    check(r.ok === false && r.dead === true, "a 404 on the web route is filed as dead, not just failed",
      JSON.stringify(r));
  }

  /* ── both routes fail: the reason is named, not swallowed ─────────────────── */
  {
    const feedPath = "/api/v1/feed/user/blocked/username/?count=24";
    const webPath = "/api/v1/users/web_profile_info/?username=blocked";
    const res = await run(["blocked"], {
      [feedPath]: { status: 200, json: {} },
      [webPath]: { status: 200, json: { data: null } },
    });
    const r = res["blocked"];
    check(r.ok === false && !r.dead, "neither route gave a profile — failed, but not filed as dead", JSON.stringify(r));
    check(/both routes failed/.test(r.note) && r.note.length > 20, "the note says why, not just that it failed", r.note);
  }

  /* ── a post missing its id or timestamp is dropped, not filed half-formed ─── */
  {
    const feedPath = "/api/v1/feed/user/partial/username/?count=24";
    const res = await run(["partial"], {
      [feedPath]: { status: 200, json: { items: [
        { code: "", pk: "", taken_at: 1755000000, caption: { text: "no id at all" } },
        { code: "Cvalid", pk: "999", taken_at: 0, caption: { text: "no real timestamp" } },
        { code: "Ckeep", pk: "1", taken_at: 1755000000, caption: { text: "kept" } },
      ] } },
    });
    const r = res["partial"];
    check(r.posts.length === 1 && r.posts[0].text === "kept", "only the post with both an id and a timestamp survives",
      JSON.stringify(r.posts.map(p => p.text)));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
