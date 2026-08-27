/**
 * extension/background.js — xDomScrape(), the fragile fallback that reads X's live rendered
 * timeline (data-testid="tweet" articles) when the schema.org microdata route fails, which it now
 * usually does: X serves the microdata only to a genuine top-level navigation and nothing else, so
 * this DOM-reading path is what actually runs most of the time.
 *
 * xDomScrape is injected with chrome.scripting.executeScript, which serialises the function and
 * cuts it off from any outer scope — so, same as fbdate.test.js does for fbScrape, this pulls the
 * source out by brace-matching (not a blank-line heuristic — the function has blank lines inside
 * it) and runs it against a stub DOM built from plain objects.
 *
 *   node test/x-dom.test.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
const start = src.indexOf("async function xDomScrape");
if (start < 0) { console.error("xDomScrape not found in background.js"); process.exit(1); }
const openBrace = src.indexOf("{", start);
let depth = 0, end = -1;
for (let i = openBrace; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error("could not find the end of xDomScrape"); process.exit(1); }
const body = src.slice(start, end);

/* ── a stub page ──────────────────────────────────────────────────────────
   A fake <article>: getAttribute for the article itself, plus querySelector answers keyed by the
   selector strings xDomScrape actually uses. Anything not listed returns null, same as a real
   element that lacks that part. */
function fakeEl(overrides) {
  return Object.assign({
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    innerText: "", closest: () => null, src: "",
  }, overrides || {});
}

/* handle: the profile this scrape is reading. opts: { id, mins, text, video, photos, retweet,
   promoted, author, stats } builds one fake <article>. */
function tweet(opts) {
  const o = opts || {};
  const id = o.id || "1";
  const ts = new Date(Date.now() - (o.mins || 0) * 60e3).toISOString();
  const href = `/${o.author || "sportsfc_vn"}/status/${id}`;
  const timeEl = fakeEl({
    getAttribute: k => (k === "datetime" ? ts : null),
    closest: sel => (sel.includes("status") ? fakeEl({ getAttribute: k => (k === "href" ? href : null) }) : null),
  });
  const nameLink = fakeEl({ getAttribute: k => (k === "href" ? "/" + (o.author || "sportsfc_vn") : null) });
  const nameBlock = fakeEl({ querySelector: sel => (sel.startsWith("a[") ? nameLink : null) });
  const textEl = fakeEl({ innerText: o.text || "" });
  const videoEl = o.video ? fakeEl({ src: "https://video.x/v.mp4" }) : null;
  const photoEls = Array.from({ length: o.photos || 0 }, () => fakeEl());

  return fakeEl({
    getAttribute: k => (k === "aria-label" ? (o.promoted ? "Promoted" : "") : null),
    querySelector: sel => {
      if (sel.includes("socialContext")) return o.retweet ? fakeEl() : null;
      if (sel === "time[datetime]") return timeEl;
      if (sel === '[data-testid="User-Name"]') return nameBlock;
      if (sel === '[data-testid="tweetText"]') return textEl;
      if (sel === "video") return videoEl;
      if (sel === "video, [data-testid='tweetPhoto'] img") return videoEl || (photoEls[0] || null);
      if (sel.includes('role="group"')) return o.stats ? fakeEl({ getAttribute: () => o.stats }) : null;
      return null;
    },
    querySelectorAll: sel => (sel.includes("tweetPhoto") ? photoEls : []),
  });
}

let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };

async function run(articles, handle) {
  const document = { querySelectorAll: sel => (sel.includes("article") ? articles : []) };
  const window = { scrollBy: () => {} };
  const setTimeout = (fn, ms) => { fn(); return 0; };   // resolve every poll instantly
  const fn = new Function("document", "window", "setTimeout", body + "\n;return xDomScrape;")(document, window, setTimeout);
  return fn(handle, 500, 10);
}

(async () => {
  console.log("── a real tweet is read with a real timestamp");
  let posts = await run([tweet({ id: "111", mins: 30, text: "Trận cầu tâm điểm tối nay" })], "sportsfc_vn");
  ok(posts.length === 1 && posts[0].externalId === "111", "the tweet is read", JSON.stringify(posts.map(p => p.externalId)));
  ok(!isNaN(new Date(posts[0].ts).getTime()) && Math.abs(Date.now() - new Date(posts[0].ts).getTime() - 30 * 60e3) < 5000,
    "its timestamp is the real <time datetime>, not a guess", posts[0].ts);
  ok(posts[0].permalink === "https://x.com/sportsfc_vn/status/111", "and the permalink points at the status", posts[0].permalink);
  ok(posts[0].text === "Trận cầu tâm điểm tối nay", "the words come through for the language check", posts[0].text);

  console.log("\n── what must not become a post");
  posts = await run([
    tweet({ id: "1", mins: 10, retweet: true, text: "someone else's post, reposted" }),
    tweet({ id: "2", mins: 20, promoted: true, text: "an ad" }),
    tweet({ id: "3", mins: 30, author: "someone_else", text: "a quoted tweet from another account" }),
  ], "sportsfc_vn");
  ok(posts.length === 0, "a repost, a promoted slot, and another author's tweet are all skipped",
    JSON.stringify(posts.map(p => p.externalId)));

  console.log("\n── media and stats");
  posts = await run([tweet({ id: "9", mins: 5, video: true, stats: "12 replies, 34 reposts, 56 likes, 5.6K views" })], "sportsfc_vn");
  ok(posts[0].kind === "video", "a video tweet is marked video", posts[0].kind);
  ok(posts[0].comments === 12 && posts[0].reposts === 34 && posts[0].likes === 56 && posts[0].views === 5600,
    "counts are read out of the action bar's aria-label, including a 'K' suffix",
    JSON.stringify({ c: posts[0].comments, r: posts[0].reposts, l: posts[0].likes, v: posts[0].views }));

  posts = await run([tweet({ id: "10", mins: 5, photos: 3 })], "sportsfc_vn");
  ok(posts[0].kind === "carousel", "three photos make a carousel, not a single photo", posts[0].kind);

  console.log("\n── ordering and dedupe");
  /* real X status ids are numeric — the id regex expects digits, same as the server parser */
  posts = await run([
    tweet({ id: "111", mins: 300 }), tweet({ id: "222", mins: 10 }), tweet({ id: "111", mins: 300 }),
  ], "sportsfc_vn");
  ok(posts.length === 2, "the same id appearing twice (re-rendered mid-scroll) counts once", posts.map(p => p.externalId).join(","));
  ok(posts[0] && posts[0].externalId === "222", "newest first — the report relies on it", posts.map(p => p.externalId).join(","));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
