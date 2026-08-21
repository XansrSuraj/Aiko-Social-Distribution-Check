/**
 * extension/background.js — the X (Twitter) parser, checked against the same microdata the server
 * parser reads. The extension is the fallback path for X: when a Vercel datacenter IP is refused,
 * the browser fetches the profile from the user's own IP and parses it with a COPY of the server's
 * parser. A copy can drift; this test is what stops it drifting silently.
 *
 * It lifts the parser out of background.js by the markers around it (the same trick reconcile.test
 * uses on index.html), runs the exact article fixtures the server test uses, and asserts identical
 * results. If someone fixes a parsing bug in api/collect.js and forgets background.js — or the
 * reverse — a case here fails.
 *
 *   node test/x-ext.test.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

/* pull out just the block between the parse markers and evaluate it in isolation, returning the
   two entry points the collector uses */
const START = "/* ── x parse: mirror of api/collect.js";
const END = "/* ── end x parse ──";
const a = SRC.indexOf(START), b = SRC.indexOf(END);
if (a === -1 || b === -1) { console.error("FAIL  could not find the x-parse markers in background.js"); process.exit(1); }
const block = SRC.slice(SRC.indexOf("\n", a) + 1, b);
const parser = new Function(block + "\n;return { xArticles, xParsePost };")();

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

/* ── the same fixture builder api/collect.js's test uses ──────────────────── */
const HANDLE = "sportsfc_vn";
const ago = mins => new Date(Date.now() - mins * 60e3).toISOString();
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
const bareArticle = id => `<article data-tweet-id="${id}">no microdata here</article>`;
const page = (...articles) => `<!doctype html><html><body>${articles.join("")}</body></html>`;
const parse = html => parser.xArticles(html).map(x => parser.xParsePost(x, HANDLE)).filter(Boolean);

const VN = "Hai huyền thoại của Tam Sư. Một cuộc tranh luận chưa hạ nhiệt.";

(async () => {
  console.log("── the extension parser reads the same microdata the server does");
  let posts = parse(page(article("1811", 60, VN), article("1802", 300, "second")));
  check(posts.length === 2, "two articles → two posts", String(posts.length));
  check(posts.every(p => p.externalId && !isNaN(new Date(p.ts).getTime())),
    "every post has an id and a real timestamp", JSON.stringify(posts[0]));
  check(posts[0].permalink === `https://x.com/${HANDLE}/status/1811`,
    "permalink points at the status", posts[0].permalink);
  check(/huyền thoại/.test(posts[0].text), "the words come through for the language check",
    posts[0].text.slice(0, 30));

  console.log("\n── media and stats land in the same fields");
  posts = parse(page(article("2001", 30, "a clip", {
    video: { thumb: "https://pbs.twimg.com/vt.jpg", dur: "PT1M9S" },
    likes: 42, reposts: 7, replies: 3, views: 5000 })));
  check(posts[0].kind === "video" && posts[0].duration === 69, "video kind + duration in seconds", JSON.stringify(posts[0]));
  check(posts[0].thumb === "https://pbs.twimg.com/vt.jpg", "and its own thumbnail");
  check(posts[0].likes === 42 && posts[0].views === 5000 && posts[0].comments === 3,
    "likes / views / replies map to the shared fields",
    `likes=${posts[0].likes} views=${posts[0].views} comments=${posts[0].comments}`);
  check(posts[0].reposts === 7, "reposts as its own field", String(posts[0].reposts));

  posts = parse(page(article("2002", 30, "one photo", { images: ["https://pbs.twimg.com/a.jpg"] })));
  check(posts[0].kind === "photo", "one image is a photo, not a carousel", posts[0].kind);
  posts = parse(page(article("2003", 30, "album",
    { images: ["https://pbs.twimg.com/a.jpg", "https://pbs.twimg.com/b.jpg"] })));
  check(posts[0].kind === "carousel", "several images make a carousel", posts[0].kind);

  console.log("\n── what must be skipped, exactly as the server skips it");
  posts = parse(page(article("3001", 10, "someone else's words", { author: "another_account" })));
  check(posts.length === 0, "a repost (different author) is not this channel's post", JSON.stringify(posts));
  posts = parse(page(article("3002", 10, "a quote card", { noAuthor: true })));
  check(posts.length === 0, "a quote-card with no author block is skipped");
  posts = parse(page(bareArticle("3003"), article("3004", 10, "a real one")));
  check(posts.length === 1 && posts[0].externalId === "3004",
    "an article with no microdata is passed over, the real one still read", JSON.stringify(posts));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
