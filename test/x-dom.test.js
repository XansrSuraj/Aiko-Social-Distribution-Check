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
  const document = {
    querySelectorAll: sel => (sel.includes("article") ? articles : []),
    querySelector: () => null, body: { innerText: "" },
  };
  const window = { scrollBy: () => {} };
  const setTimeout = (fn, ms) => { fn(); return 0; };   // resolve every poll instantly
  const fn = new Function("document", "window", "setTimeout", body + "\n;return xDomScrape;")(document, window, setTimeout);
  const res = await fn(handle, 500, 10);
  return res.posts;
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

  console.log("\n── the real bug: X's timeline call is slow, and zero-so-far must not give up early");
  /* the regression this guards: an early build treated "zero results, unchanged, three polls in a
     row" as a reason to stop — but a slow first load looks EXACTLY like that for its first several
     polls, so it was declaring "no posts" before X had even answered. Zero must keep polling for
     the WHOLE time budget; only a count that has found something and then stops growing may bail
     out early. */
  {
    let calls = 0;
    const document = {
      querySelectorAll: sel => {
        if (!sel.includes("article")) return [];
        calls++;
        return calls < 6 ? [] : [tweet({ id: "555", mins: 5 })];   // nothing renders until the 6th poll
      },
      querySelector: () => null, body: { innerText: "" },
    };
    const window = { scrollBy: () => {} };
    const setTimeout = (fn) => { fn(); return 0; };
    const fn = new Function("document", "window", "setTimeout", body + "\n;return xDomScrape;")(document, window, setTimeout);
    const res = await fn("sportsfc_vn", 5000, 10);          // plenty of polls at 10ms each before 5s
    ok(res.posts.length === 1 && res.posts[0].externalId === "555",
      "a post that only renders on the 6th poll is still found — zero-so-far did not bail out early",
      `calls=${calls} posts=${JSON.stringify(res.posts.map(p => p.externalId))}`);
  }

  console.log("\n── when nothing is ever found, the diagnostic says WHY");
  {
    const mk = bodyText => new Function("document", "window", "setTimeout", body + "\n;return xDomScrape;")(
      { querySelectorAll: () => [], querySelector: () => null, body: { innerText: bodyText } },
      { scrollBy: () => {} }, fn => { fn(); return 0; }
    );
    let res = await mk("Log in to X\nSee what's happening in the world")("sportsfc_vn", 100, 10);
    ok(res.posts.length === 0 && /not logged into x\.com/i.test(res.diag), "a login prompt is named as such", res.diag);

    res = await mk("This account doesn't exist\nTry searching for another.")("sportsfc_vn", 100, 10);
    ok(res.posts.length === 0 && /does not exist/i.test(res.diag), "a dead handle is named as such", res.diag);

    res = await mk("These Tweets are protected. Only confirmed followers have access.")("sportsfc_vn", 100, 10);
    ok(res.posts.length === 0 && /protected/i.test(res.diag), "a protected account is named as such", res.diag);

    res = await mk("some ordinary page text with no recognisable signal")("sportsfc_vn", 100, 10);
    ok(res.posts.length === 0 && /rendered nothing recognisable/i.test(res.diag),
      "an unrecognised empty page still gets a plain, honest diagnostic (not a false claim)", res.diag);
  }

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

  /* ═══════ a virtualised timeline delivers in batches — one tweet is not an answer ═══════
     The live failure: a channel that had posted seven times reported ONE, and the report then
     crossed the other six. X renders further tweets only as they scroll into view, so the reader
     saw whatever happened to be on screen, the count stopped changing, and three quiet polls ended
     the run in under three seconds. Stopping on a COUNT is the mistake — the only thing that
     licenses calling a drop missing is having scrolled back PAST the window. */
  console.log("\n── a virtualised timeline is read to the end of the window, not to a count");
  {
    /* tweets appear a batch at a time, the way a virtualised list actually fills */
    const mk = mins => tweet({ id: String(700000 + mins), mins });
    const batches = [
      [mk(30)],                                        // only the newest is rendered at first
      [mk(30), mk(120)],
      [mk(30), mk(120), mk(300)],
      [mk(30), mk(120), mk(300), mk(3000)],            // this one is older than the window
    ];
    let calls = 0;
    const document = {
      querySelectorAll: sel => {
        if (!sel.includes("article")) return [];
        /* a batch arrives only every fifth poll — a virtualised list pauses between them, and a
           reader that quits after three unchanged polls never sees the second batch */
        const b = batches[Math.min(Math.floor(calls++ / 8), batches.length - 1)];
        return b;
      },
      querySelector: () => null, body: { innerText: "" },
      documentElement: { scrollTop: 0 },
    };
    const window = { scrollBy: () => {}, dispatchEvent: () => {}, innerHeight: 900 };
    const setTimeout = (fn) => { fn(); return 0; };
    const fn = new Function("document", "window", "setTimeout", "Event",
      body + "\n;return xDomScrape;")(document, window, setTimeout, function Event() {});
    const sinceMs = Date.now() - 24 * 3600e3;            // a one-day window
    const res = await fn("sportsfc_vn", 5000, 5, sinceMs);
    ok(res.posts.length >= 3,
      "it keeps scrolling past the first rendered tweet instead of stopping at one",
      `found ${res.posts.length}: ` + res.posts.map(p => p.externalId).join(","));
    ok(res.covered === true,
      "and reports the window as covered once it reaches a post older than it", String(res.covered));
  }

  /* the other half of the same rule: a timeline that genuinely stops giving more must NOT claim
     the window was covered, so the report can decline to cross anything on the strength of it */
  {
    let calls = 0;
    const only = [tweet({ id: "900001", mins: 30 })];
    const document = {
      querySelectorAll: sel => { calls++; return sel.includes("article") ? only : []; },
      querySelector: () => null, body: { innerText: "" }, documentElement: { scrollTop: 0 },
    };
    const window = { scrollBy: () => {}, dispatchEvent: () => {}, innerHeight: 900 };
    const setTimeout = (fn) => { fn(); return 0; };
    const fn = new Function("document", "window", "setTimeout", "Event",
      body + "\n;return xDomScrape;")(document, window, setTimeout, function Event() {});
    const res = await fn("sportsfc_vn", 3000, 5, Date.now() - 24 * 3600e3);
    ok(res.posts.length === 1, "the one tweet that did render is still returned", String(res.posts.length));
    ok(res.covered === false,
      "but the window is NOT claimed as covered, so nothing may be crossed on it", String(res.covered));
  }

  /* ═══════ the list RECYCLES its nodes — a single snapshot is never the timeline ═══════
     The second, stranger live failure. X's timeline is virtualised in BOTH directions: scrolling
     down does not merely add tweets at the bottom, it REMOVES the ones that leave the top from the
     DOM. So each harvest sees only a moving window. A reader that keeps "the biggest single
     harvest" keeps one arbitrary slice — and because scrolling moves that slice DOWNWARDS, the
     slice it ends up keeping holds the OLDER tweets. On a channel that had posted seven times that
     read as: the three oldest drops ticked, the four newest crossed. Exactly backwards.
     The union of every poll is the only correct reading of a list that recycles its own nodes. */
  console.log("\n── a timeline that unmounts what scrolls off the top is still read whole");
  {
    /* five tweets, newest first, but only three are ever in the DOM at once — the window slides
       down one tweet per poll, dropping the newest as it goes, exactly as X does */
    const all = [10, 60, 120, 180, 240].map(mins => tweet({ id: String(800000 + mins), mins }));
    let poll = 0;
    const document = {
      querySelectorAll: sel => {
        if (!sel.includes("article")) return [];
        const startAt = Math.min(Math.floor(poll++ / 2), all.length - 3);
        return all.slice(startAt, startAt + 3);         // a three-tweet sliding window
      },
      querySelector: () => null, body: { innerText: "" }, documentElement: { scrollTop: 0 },
    };
    const window = { scrollBy: () => {}, dispatchEvent: () => {}, innerHeight: 900 };
    const setTimeout = (fn) => { fn(); return 0; };
    const fn = new Function("document", "window", "setTimeout", "Event",
      body + "\n;return xDomScrape;")(document, window, setTimeout, function Event() {});
    const res = await fn("sportsfc_vn", 4000, 5, Date.now() - 24 * 3600e3);

    const ids = res.posts.map(p => p.externalId);
    ok(res.posts.length === 5, "every tweet the sliding window ever showed is kept, not just one slice",
      `${res.posts.length}: ${ids.join(",")}`);
    ok(ids[0] === "800010",
      "including the NEWEST, which scrolling had unmounted — the four-newest-crossed failure", ids[0]);
    ok(ids[ids.length - 1] === "800240", "and the oldest, which only later polls showed", ids[ids.length - 1]);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
