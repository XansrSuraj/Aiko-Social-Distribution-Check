/**
 * api/collect.js — the X (Twitter) arm, with a stubbed fetch.
 *
 * X has no feed a server can ask for by name. What it has instead is the profile page's own
 * server-rendered HTML: schema.org microdata, one <article itemType=".../SocialMediaPosting"> per
 * post, with an exact ISO timestamp and every counter. This fixture reproduces that exact shape —
 * confirmed against the real page for @Sportsfcvn and @NASA — rather than the full ~20 KB of
 * button and class-name markup around each real article, none of which the parser reads.
 *
 * A fixture is also the only way to pin the two shapes that actually cost posts: a repost, which
 * is somebody else's words wearing this account's page, and a quote-card with no author block at
 * all. Counting either as this channel's own post would make a day of reposts read as delivered.
 *
 *   node test/x.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "collect.js");
const realFetch = global.fetch;

function load() { delete require.cache[require.resolve(MOD)]; return require(MOD); }

const HANDLE = "sportsfc_vn";
const ago = mins => new Date(Date.now() - mins * 60e3).toISOString();

/* one InteractionCounter block, in the shape the page actually renders */
const stat = (action, name, n) =>
  `<div itemProp="interactionStatistic" itemScope itemType="https://schema.org/InteractionCounter">` +
  `<meta content="https://schema.org/${action}" itemProp="interactionType"/>` +
  `<meta content="${name}" itemProp="name"/>` +
  `<meta content="${n}" itemProp="userInteractionCount"/></div>`;

const videoBlock = (thumb, src, dur) =>
  `<div itemProp="video" itemScope itemType="https://schema.org/VideoObject">` +
  `<meta content="a video" itemProp="name"/><meta content="${src}" itemProp="contentUrl"/>` +
  `<meta content="${thumb}" itemProp="thumbnailUrl"/><meta content="${dur}" itemProp="duration"/></div>`;

const imageBlock = thumb =>
  `<div itemProp="image" itemScope itemType="https://schema.org/ImageObject">` +
  `<meta content="${thumb}" itemProp="contentUrl"/><meta content="${thumb}" itemProp="thumbnailUrl"/></div>`;

/* [ id, minutes ago, text, opts ] -> one <article>, in the exact microdata shape x.com renders.
   opts.author overrides the handle the post is attributed to (default: the requested one);
   opts.noAuthor drops the author block entirely, the way a quote-card renders. */
function article(id, mins, text, opts) {
  const o = opts || {};
  const author = o.noAuthor ? "" :
    `<div itemProp="author" itemScope itemType="https://schema.org/Person">` +
    `<meta content="900${id}" itemProp="identifier"/>` +
    `<meta content="${o.author || HANDLE}" itemProp="alternateName"/></div>`;
  const stats = [
    stat("LikeAction", "Likes", o.likes != null ? o.likes : 0),
    stat("ShareAction", "Retweets", o.reposts != null ? o.reposts : 0),
    stat("ReplyAction", "Replies", o.replies != null ? o.replies : 0),
    stat("ViewAction", "Views", o.views != null ? o.views : 1),
  ].join("");
  const media = o.video ? videoBlock(o.video.thumb || "https://pbs.twimg.com/thumb.jpg",
                                      o.video.src || "https://video.twimg.com/v.mp4", o.video.dur || "PT5S")
              : o.images ? o.images.map(imageBlock).join("")
              : "";
  return `<article data-tweet-id="${id}" itemScope itemProp="hasPart" ` +
    `itemType="https://schema.org/SocialMediaPosting">` +
    `<meta content="${id}" itemProp="identifier"/>` +
    `<meta content="${o.commentCount != null ? o.commentCount : 0}" itemProp="commentCount"/>` +
    `<meta content="${ago(mins)}" itemProp="dateCreated"/>` +
    `<meta content="${ago(mins)}" itemProp="datePublished"/>` +
    `<meta content="https://x.com/${HANDLE}/status/${id}" itemProp="url"/>` +
    `<meta content="${text}" itemProp="text"/>` +
    author + stats + media + `</article>`;
}

/* an article with no itemType at all — a promoted slot or a render gap, not a post */
function bareArticle(id) {
  return `<article data-tweet-id="${id}">no microdata here</article>`;
}

const page = (...articles) => `<!doctype html><html><body>${articles.join("")}</body></html>`;

function runWith(body, status, hours, channel) {
  const calls = [];
  global.fetch = async url => { calls.push(String(url)); return { status: status == null ? 200 : status, text: async () => body }; };
  const handler = load();
  return new Promise(resolve => {
    handler({ method: "POST", body: {
      channels: [channel || { id: "x1", platform: "x", url: "https://x.com/" + HANDLE }],
      hours: hours || 24,
    } }, {
      setHeader() {}, status() { return this; },
      json: p => resolve({ res: p.results[0], calls }),
    });
  }).finally(() => { global.fetch = realFetch; });
}

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

const VN = "Hai huyền thoại của Tam Sư. Hai sự nghiệp phi thường. Một cuộc tranh luận chưa hạ nhiệt.";
const VN2 = "🐐 Tuổi tác chỉ là một con số với Cristiano Ronaldo. Từ Saudi Pro League đến World Cup.";

(async () => {
  console.log("── what comes out of one profile page");

  let { res } = await runWith(page(article("1811", 60, VN), article("1802", 300, VN2)));
  check(res.ok === true && res.posts.length === 2, "a profile page is read", res.note || "");
  check(res.source === "x-web", "and the run says which route read it", String(res.source));
  check(res.posts.every(p => p.externalId && !isNaN(new Date(p.ts).getTime())),
    "every post has an id and a real timestamp", JSON.stringify(res.posts[0]));
  check(res.posts[0].externalId === "1811", "newest first — the report relies on it",
    res.posts.map(p => p.externalId).join(","));
  check(res.posts[0].permalink === `https://x.com/${HANDLE}/status/1811`,
    "the permalink points at the status", res.posts[0].permalink);
  /* the language check reads p.text and nothing else, so an empty text is a silent hole */
  check(/huyền thoại/.test(res.posts[0].text),
    "the words come through, so the language check has something to read",
    res.posts[0].text.slice(0, 40));

  console.log("\n── media and stats");

  ({ res } = await runWith(page(article("2001", 30, "a clip", {
    video: { thumb: "https://pbs.twimg.com/vt.jpg", src: "https://video.twimg.com/v.mp4", dur: "PT1M9S" },
    likes: 42, reposts: 7, replies: 3, views: 5000,
  }))));
  check(res.posts[0].kind === "video" && res.posts[0].duration === 69,
    "a video carries its kind and its duration in seconds", JSON.stringify(res.posts[0]));
  check(res.posts[0].thumb === "https://pbs.twimg.com/vt.jpg", "and its own thumbnail");
  check(res.posts[0].likes === 42 && res.posts[0].views === 5000 && res.posts[0].comments === 3,
    "likes, views and replies land in the fields every other platform uses",
    `likes=${res.posts[0].likes} views=${res.posts[0].views} comments=${res.posts[0].comments}`);
  /* reposts is X's own metric — nothing else this file collects has one */
  check(res.posts[0].reposts === 7, "reposts come through as their own field", String(res.posts[0].reposts));

  ({ res } = await runWith(page(article("2002", 30, "one photo", { images: ["https://pbs.twimg.com/a.jpg"] }))));
  check(res.posts[0].kind === "photo", "a single image is a photo, not a carousel", res.posts[0].kind);

  ({ res } = await runWith(page(article("2003", 30, "an album",
    { images: ["https://pbs.twimg.com/a.jpg", "https://pbs.twimg.com/b.jpg", "https://pbs.twimg.com/c.jpg"] }))));
  check(res.posts[0].kind === "carousel" && res.posts[0].thumb === "https://pbs.twimg.com/a.jpg",
    "several images make a carousel, banner from the first", res.posts[0].kind);

  /* X favours hex numeric entities ("&#x27;") where the RSS/HTML feeds elsewhere in this file use
     decimal or named ones — confirmed on a live @NASA post ("Yesterday&#x27;s total solar...") */
  ({ res } = await runWith(page(article("2004", 30, "Yesterday&#x27;s launch went well"))));
  check(res.posts[0].text === "Yesterday's launch went well",
    "a hex HTML entity in the text is decoded", res.posts[0].text);

  console.log("\n── what must not become a drop");

  /* a repost is another account's post, carried on this account's page under its own byline —
     not this channel's own content, and counting it means a day of reposts reads as delivered */
  ({ res } = await runWith(page(
    article("1811", 60, VN),
    article("1799", 90, "originally posted by someone else", { author: "someone_else" }))));
  check(res.posts.length === 1 && res.posts[0].externalId === "1811",
    "a repost by a different author is not this channel's post",
    res.posts.map(p => p.externalId).join(","));

  /* a quote-card or promoted slot renders with no author block at all — skipped rather than
     guessed at, since there is nothing here to prove whose post it is */
  ({ res } = await runWith(page(
    article("1811", 60, VN),
    article("1780", 95, "a quoted post with no byline", { noAuthor: true }))));
  check(res.posts.length === 1, "a post with no author block is skipped", res.posts.map(p => p.externalId).join(","));

  /* an article with no schema.org typing at all is a render gap, not a post */
  ({ res } = await runWith(page(article("1811", 60, VN), bareArticle("999"))));
  check(res.posts.length === 1, "an article with no microdata typing is skipped",
    res.posts.map(p => p.externalId).join(","));

  console.log("\n── empty is not the same as unreadable");

  /* A logged-out render of a real, healthy handle always carries at least one full article — the
     account this was built against returns all three of its posts at three posts total. Zero here
     is indistinguishable from a dead handle or a suspended one, and neither is "posted nothing". */
  ({ res } = await runWith(page()));
  check(res.ok === false && /unknown, not empty/.test(res.note),
    "a page with no posts at all says unknown, not empty", res.note);

  ({ res } = await runWith(page(bareArticle("1"), bareArticle("2"))));
  check(res.ok === false && /unknown, not empty/.test(res.note),
    "a page whose articles carry no post typing is the same as an empty one", res.note);

  console.log("\n── when X will not answer");

  /* 429 is retried by the shared get() helper (RETRY_STATUS), same as every other platform here */
  let r2 = await runWith("", 429);
  check(r2.res.ok === false && /would not serve/.test(r2.res.note),
    "a rate-limited page is reported, not mistaken for an empty one", r2.res.note);
  check(r2.calls.length === 2, "and it was asked again", `fetches=${r2.calls.length}`);

  r2 = await runWith("", 404);
  check(r2.res.ok === false && r2.calls.length === 1,
    "404 is final, not retried", `fetches=${r2.calls.length}`);
  check(/would not serve/.test(r2.res.note), "and says so plainly", r2.res.note);

  console.log("\n── the handle");

  for (const [url, handleField, want] of [
    ["https://x.com/sportsfc_vn", "", "sportsfc_vn"],
    ["https://twitter.com/sportsfc_vn", "", "sportsfc_vn"],
    ["https://x.com/sportsfc_vn/status/1811", "", "sportsfc_vn"],
    ["https://x.com/i/status/1811", "@sportsfc_vn", "sportsfc_vn"],
    ["https://x.com/intent/follow?screen_name=sportsfc_vn", "sportsfc_vn", "sportsfc_vn"],
    ["", "@sportsfc_vn", "sportsfc_vn"],
  ]) {
    const out = await runWith(page(article("1811", 60, VN, { author: want })), 200, 24,
      { id: "x1", platform: "x", url, handle: handleField });
    const got = decodeURIComponent((out.calls[0] || "").replace(/^https:\/\/x\.com\//, ""));
    check(got === want, `handle from url="${url}" handle="${handleField}"`, `asked for "${got}"`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
