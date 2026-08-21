/**
 * The Facebook date reader, extracted from extension/background.js and run against fake posts.
 *
 * This exists because the first version read 0 of 4 dates on a live page and reported the channel
 * as having no data — a silent hole in the report with no way to tell why. Facebook has put the
 * timestamp in the link's text, an aria-label, a title, an <abbr> and a <time datetime>, so the
 * reader has to try all of them, and that is only worth trusting if it is tested.
 *
 * fbScrape is injected with chrome.scripting.executeScript, which serialises the function and
 * cuts it off from any outer scope — so the classifier has to live inside it, and testing it
 * means pulling the source out and giving it a stub DOM and a fixed clock.
 *
 *   node test/fbdate.test.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
const start = src.indexOf("async function fbScrape");
if (start < 0) { console.error("fbScrape not found in background.js"); process.exit(1); }
/* the function ends at the next top-level closing brace followed by a blank line */
const end = src.indexOf("\n}\n", start);
const body = src.slice(start, end + 3);

/* ── a fake post ──────────────────────────────────────────────────────────
   attrs is what Facebook offers on the element that carries the time. */
function post(attrs, text, href) {
  const el = {
    getAttribute: k => (k in attrs ? attrs[k] : null),
    innerText: text || "",
  };
  const link = {
    getAttribute: k => (k === "href" ? (href || "/sportsfc.vn/posts/pfbid0abc123") : null),
    innerText: "",
  };
  return {
    querySelectorAll: () => [el, link],
    querySelector: () => null,
    innerText: "some post body text",
  };
}

/* A clock pinned to 2026-08-01 10:00 local, so "2h" is today and "12h" is yesterday.
   now() has to creep forward even so: the poll loop runs until Date.now() passes its deadline,
   and a truly frozen clock makes that condition permanently true — an infinite loop on any post
   the reader cannot date. The step is small enough that no verdict changes. */
const NOW = new Date(2026, 7, 1, 10, 0, 0);
let tick = 0;
class FakeDate extends Date {
  constructor(...a) { if (!a.length) super(NOW.getTime() + tick); else super(...a); }
  static now() { tick += 250; return NOW.getTime() + tick; }
}

/* A skeleton: what Facebook paints before the real post arrives. */
function skeleton() {
  const ph = { getAttribute: () => null, innerText: "Loading..." };
  return { querySelectorAll: () => [ph], querySelector: () => null, innerText: "Loading..." };
}

/**
 * @param posts   array of fake articles, or an array of arrays to hand back one per poll —
 *                that is how the "waits for the feed to arrive" case is expressed
 * @param waitMs  1 by default so the poll loop does not actually run
 */
async function run(posts, waitMs) {
  const frames = Array.isArray(posts[0]) ? posts.slice() : [posts];
  let frame = 0;
  const document = {
    querySelectorAll: sel => (sel === '[role="article"]'
      ? frames[Math.min(frame, frames.length - 1)] : []),
    querySelector: () => null, title: "Facebook",
  };
  const fn = new Function("document", "window", "location", "Date", "setTimeout",
    body + "\n;return fbScrape(WAIT, 1);".replace("WAIT", String(waitMs || 1)));
  return fn(document,
    { scrollBy: () => {}, innerHeight: 900 },
    { pathname: "/sportsfc.vn", href: "https://www.facebook.com/sportsfc.vn" },
    FakeDate,
    /* each sleep advances to the next frame, standing in for the feed streaming in */
    fn2 => { frame++; fn2(); return 0; });
}

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

(async () => {
  /* one post at a time, so each verdict is unambiguous */
  const cases = [
    /* [ description, attrs, innerText, expected bucket ] */
    ["link text  2h",                      {}, "2h", "today"],
    ["link text  45m",                     {}, "45m", "today"],
    ["link text  Just now",                {}, "Just now", "today"],
    ["link text  12h (crosses midnight)",  {}, "12h", "older"],
    ["link text  Yesterday at 18:31",      {}, "Yesterday at 18:31", "older"],
    ["link text  2d",                      {}, "2d", "older"],
    ["link text  1w",                      {}, "1w", "older"],

    /* the case that was silently failing: a written-out date, wherever it sits */
    ["aria-label full date, today",  { "aria-label": "Saturday, August 1, 2026 at 9:15 AM" }, "", "today"],
    ["aria-label full date, older",  { "aria-label": "Wednesday, July 29, 2026 at 10:00 AM" }, "", "older"],
    ["title  July 29 at 10:00 AM",   { title: "July 29 at 10:00 AM" }, "", "older"],
    ["link text  29 July 2026",      {}, "29 July 2026", "older"],
    ["link text  Jul 28",            {}, "Jul 28", "older"],
    ["link text  1 August",          {}, "1 August", "today"],

    /* the cleanest signal of all, when Facebook bothers to provide it */
    ["datetime attribute, today",  { datetime: "2026-08-01T09:15:00+00:00" }, "", "today"],
    ["datetime attribute, older",  { datetime: "2026-07-29T09:15:00+00:00" }, "", "older"],

    /* chrome that must not be mistaken for a time */
    ["not a time: page name",  {}, "Sportsfc.fans", "unknown"],
    ["not a time: Like",       {}, "Like", "unknown"],
    ["not a time: view count", {}, "1.2K views", "unknown"],
    ["not a time: empty",      {}, "", "unknown"],
  ];

  for (const [label, attrs, text, want] of cases) {
    const r = await run([post(attrs, text)]);
    const got = r.todayCount ? "today" : r.olderCount ? "older" : "unknown";
    check(got === want, label, got === want ? "" : `got ${got}, wanted ${want}`);
  }

  /* ── skeletons ──────────────────────────────────────────────────────────
     The live failure: four placeholder articles were counted as four undated posts, so the
     channel reported no data and the note blamed unreadable dates. */
  const onlySkeletons = await run([skeleton(), skeleton(), skeleton(), skeleton()]);
  check(onlySkeletons.skeletonCount === 4 && onlySkeletons.visibleCount === 0 &&
        onlySkeletons.unknownCount === 0,
    "placeholders are not counted as undated posts",
    `skeleton=${onlySkeletons.skeletonCount} visible=${onlySkeletons.visibleCount} unknown=${onlySkeletons.unknownCount}`);
  check(onlySkeletons.stillLoading === true,
    "a page of nothing but placeholders reports stillLoading");

  const halfLoaded = await run([post({}, "2h"), skeleton(), skeleton()]);
  check(halfLoaded.todayCount === 1 && halfLoaded.skeletonCount === 2 && halfLoaded.visibleCount === 1,
    "real posts count, placeholders alongside them do not",
    `today=${halfLoaded.todayCount} skeleton=${halfLoaded.skeletonCount}`);
  check(halfLoaded.stillLoading === false, "a page with one real post is not stillLoading");

  /* ── the poll ───────────────────────────────────────────────────────────
     Skeletons first, real posts on a later pass — a fixed sleep would have taken the first. */
  const streamed = await run([
    [skeleton(), skeleton()],
    [skeleton(), skeleton()],
    [post({}, "2h"), post({}, "2d")],
  ], 5000);
  check(streamed.todayCount === 1 && streamed.olderCount === 1,
    "waits for the feed to arrive instead of reading placeholders",
    `today=${streamed.todayCount} older=${streamed.olderCount} polls=${streamed.polls}`);
  check(streamed.polls >= 1, "it actually polled", `polls=${streamed.polls}`);

  /* the shape the dashboard depends on */
  const mixed = await run([post({}, "2h"), post({}, "2d"), post({}, "Like")]);
  check(mixed.todayCount === 1 && mixed.olderCount === 1 && mixed.unknownCount === 1,
    "counts split across today / older / unknown",
    `${mixed.todayCount}/${mixed.olderCount}/${mixed.unknownCount}`);
  check(mixed.visibleCount === 3, "visibleCount is every post seen", String(mixed.visibleCount));
  check(Array.isArray(mixed.diag) && mixed.diag.length === 1,
    "an unreadable post leaves a diagnostic sample", JSON.stringify(mixed.diag));
  /* The permalink id is what separates a real post from a placeholder when neither has a readable
     date: a skeleton carries no link. Asserting the harvested list itself was asserting a field
     nothing consumed; this asserts the decision it actually drives. */
  const undatedReal = await run([post({}, "Sportsfc.fans")]);   // has a permalink, no usable time
  check(undatedReal.unknownCount === 1 && undatedReal.skeletonCount === 0,
    "an undated post with a permalink is unknown, not a placeholder",
    `unknown=${undatedReal.unknownCount} skeleton=${undatedReal.skeletonCount}`);

  /* a login wall must be reported as such, never as zero posts */
  const walled = new Function("document", "window", "location", "Date", "setTimeout",
    body + "\n;return fbScrape(0, 1);")(
    { querySelectorAll: () => [], querySelector: s => (/pass|email/.test(s) ? {} : null), title: "Log in" },
    { scrollBy: () => {}, innerHeight: 900 },
    { pathname: "/login/", href: "https://www.facebook.com/login/" },
    FakeDate, fn => { fn(); return 0; });
  const w = await walled;
  check(w.loginWall === true && w.ok === false, "a login wall is flagged, not counted as empty");

  /* ── the caption scraper ────────────────────────────────────────────────
     Facebook's payload carries only the newest post — measured on a live page: three
     creation_time markers in 2.5 MB, one of them a real post time. Everything older needs the feed
     to actually load, which means scrolling a rendered tab.

     An earlier version stopped at the first successful harvest, so it never scrolled past the
     newest post and never reached yesterday's caption at all. That is exactly why a post sitting
     on the page was reported missing. This feeds it a page that reveals one more post per scroll
     and insists it reaches the end. */
  const cStart = src.indexOf("async function fbCaptionScrape");
  const cEnd = src.indexOf("/* ═══════════════════ facebook: the DOM fallback");
  const capBody = src.slice(cStart, cEnd);

  /* @param stream  true to reveal one more post per scroll, the way Facebook's feed behaves;
   *                false to show them all at once, for testing the filter rather than the scroll */
  /* A post is either a plain string of text, or { text, imgs, links } when the banner and the
     surrounding metadata are what is being exercised. */
  async function runCaptions(posts, want, stream, html) {
    let revealed = stream === false ? posts.length : 1;
    const art = p => {
      const o = typeof p === "string" ? { text: p } : p;
      const imgs = (o.imgs || []).map(i => ({ src: i.src, naturalWidth: i.w, naturalHeight: i.h, width: i.w, height: i.h }));
      const links = (o.links || []).map(l => ({
        getAttribute: k => (k === "href" ? l.href : null), innerText: l.text || "",
      }));
      return {
        innerText: o.text,
        querySelector: sel => (/video\[poster\]/.test(sel) && o.poster
          ? { getAttribute: () => o.poster } : null),
        querySelectorAll: sel => (/^img$/.test(sel) ? imgs : /a\[href\]/.test(sel) ? links : []),
      };
    };
    const doc = {
      querySelectorAll: sel => (sel === '[role="article"]' ? posts.slice(0, revealed).map(art) : []),
      querySelector: () => null,
      documentElement: { innerHTML: html || "", scrollTop: 0 },
    };
    const win = {
      innerHeight: 800,
      scrollBy() { revealed = Math.min(revealed + 1, posts.length); },
      dispatchEvent() {},
    };
    const fn = new Function("document", "window", "location", "setTimeout", "Event",
      capBody + `\n;return fbCaptionScrape(5000, 1, ${want});`);
    return fn(doc, win,
      { pathname: "/sportsfc.vn", origin: "https://www.facebook.com" },
      f => { f(); return 0; }, function () { return {}; });
  }

  const FEED = [
    "Hai huyen thoai. Mot de che. Mot cuoc tranh luan chua co hoi ket. Andres Iniesta tao nen",
    "DOAN TOI LA AI? Hay cung thu tai kien thuc bong da cua ban. Tung thi dau cung Lionel Messi",
    "Mot bai viet cu hon ve bong da voi noi dung hoan toan khac biet o day",
    "Bai viet thu tu hoan toan khac ve giai dau va cac cau thu noi bat",
  ];
  const cap = await runCaptions(FEED, 4);
  check(cap.captions.length === FEED.length,
    "it scrolls past the newest post to reach older ones",
    `${cap.captions.length}/${FEED.length} over ${cap.rounds} rounds, trace ${JSON.stringify(cap.trace)}`);
  check(cap.captions.some(t => /DOAN TOI LA AI/.test(t.text)),
    "the caption that was being reported missing is reached");

  /* it must also stop rather than scroll forever on a page that has nothing more to give */
  const short = await runCaptions(FEED.slice(0, 1), 10);
  check(short.captions.length === 1 && short.rounds <= 6,
    "a page with one post stops instead of scrolling to the budget",
    `${short.captions.length} caption(s) over ${short.rounds} rounds`);

  /* a bare link is not a caption — one of the two Pages showed exactly that, collapsed */
  const linky = await runCaptions(["https://sfc.my/r/jJcUoF5J", FEED[0]], 4);
  check(linky.captions.length === 1 && !linky.captions.some(t => /^https?:\/\//.test(t)),
    "a collapsed post that is only a link is not counted",
    JSON.stringify(linky.captions.map(t => t.text.slice(0, 30))));

  /* Interface text must never become a caption. It did: reading the whole page's HTML for
     anything shaped like "text":"…" produced sixteen "captions" from a page showing two posts,
     and being in English they were reported as English posts on a Vietnamese channel. */
  const chrome = await runCaptions([
    "Write a comment... and tell us what you think about this",
    "See All Photos from this page and all of its albums",
    "Not yet rated (0 reviews) — be the first to leave one",
    "Like  Comment  Share  ·  All reactions  ·  View more",
    "Find friends who also follow football pages like this",
    FEED[0],
  ], 6, false);
  check(chrome.captions.length === 1,
    "interface text is not mistaken for a post, even when long enough",
    `${chrome.captions.length} kept: ${JSON.stringify(chrome.captions.map(t => t.text.slice(0, 26)))}`);

  /* and anything too short to be one of these posts is dropped on length alone */
  const shorty = await runCaptions(["Messi vs Ronaldo", "🔥🐐 what a goal", FEED[1]], 3, false);
  check(shorty.captions.length === 1,
    "text too short to be a post is dropped",
    JSON.stringify(shorty.captions.map(t => t.text.slice(0, 26))));

  /* ── the page's own HTML ────────────────────────────────────────────────
     This is the source doing nearly all the work — reading only the DOM dropped a Page from 2/2 to
     1/2. What matters is the pattern: anchored on the message key it finds post bodies, while a
     bare "text":"…" swept up the interface and turned English labels into English posts on a
     Vietnamese channel. */
  const pageHtml =
    `{"message":{"text":"${FEED[2]}"},"other":1}` +
    `{"message":{"text":"${FEED[3]}"}}` +
    /* interface strings, which live under their own keys and must not be picked up */
    `{"text":"Write a comment and tell us what you think of this post"}` +
    `{"aria_label":{"text":"See All Photos from this page and its albums"}}` +
    `{"accessibility_caption":"Find friends who follow football pages"}`;
  const fromPage = await runCaptions([], 6, false, pageHtml);
  check(fromPage.captions.length === 2,
    "post bodies come out of the page HTML and interface strings do not",
    `${fromPage.captions.length} kept: ${JSON.stringify(fromPage.captions.map(t => t.text.slice(0, 26)))}`);
  check(fromPage.htmlFound === 2 && fromPage.domFound === 0,
    "and the run reports which source found them", `dom=${fromPage.domFound} html=${fromPage.htmlFound}`);

  /* both sources together, without double counting the same caption */
  const both = await runCaptions([FEED[0]], 6, false, `{"message":{"text":"${FEED[0]}"}}{"message":{"text":"${FEED[1]}"}}`);
  check(both.captions.length === 2,
    "a caption in both sources is counted once",
    `${both.captions.length} kept, dom=${both.domFound} html=${both.htmlFound}`);

  /* ── the banner and what else the post gives up ──────────────────────────
     The banner is the point of showing it: the same artwork should appear on every channel, and
     that is checkable at a glance in a way a caption is not. Avatars and reaction icons sit in the
     same article, so the largest image wins and anything small is skipped. */
  const rich = await runCaptions([{
    text: FEED[0] + "\n12 reactions · 3 comments · 1.2K views",
    imgs: [
      { src: "https://scontent.fb.com/avatar.jpg", w: 40, h: 40 },
      { src: "https://scontent.fb.com/banner.jpg", w: 1080, h: 1080 },
      { src: "https://scontent.fb.com/icon.png", w: 16, h: 16 },
    ],
    links: [{ href: "/sportsfc.vn/posts/pfbid0abc123", text: "23h" }],
  }], 2, false);
  check(rich.captions.length === 1 && rich.captions[0].thumb === "https://scontent.fb.com/banner.jpg",
    "the post's banner is taken, not an avatar or an icon",
    rich.captions[0] && rich.captions[0].thumb);
  check(rich.captions[0] && /\/posts\/pfbid0abc123$/.test(rich.captions[0].permalink || ""),
    "the permalink comes along", rich.captions[0] && rich.captions[0].permalink);
  check(rich.captions[0] && rich.captions[0].timeLabel === "23h",
    "so does the time Facebook prints", rich.captions[0] && rich.captions[0].timeLabel);
  check(rich.captions[0] && rich.captions[0].reactions === "12" &&
        rich.captions[0].comments === "3" && rich.captions[0].views === "1.2K",
    "and the engagement counts it shows",
    JSON.stringify(rich.captions[0] && { r: rich.captions[0].reactions, c: rich.captions[0].comments, v: rich.captions[0].views }));

  /* Without a message container the article's own text is all there is, and it opens with the page
     name and the timestamp. Those leading lines have to go or what follows is judged as chrome —
     a live run found nine captions from the HTML and only two from the DOM, and the banner comes
     only from the DOM. */
  const leading = await runCaptions([{
    text: "Sportsfc.vn\n23h\n" + FEED[0],
    imgs: [{ src: "https://scontent.fb.com/b3.jpg", w: 800, h: 800 }],
  }], 2, false);
  check(leading.captions.length === 1 && leading.captions[0].text.indexOf("Sportsfc.vn") === -1,
    "the page name and timestamp are stripped before the caption is judged",
    JSON.stringify(leading.captions.map(c => c.text.slice(0, 30))));
  check(leading.captions[0] && leading.captions[0].thumb === "https://scontent.fb.com/b3.jpg",
    "so the article's banner comes with it");
  check(leading.withBanner === 1, "and the run counts how many captions carry one",
    `withBanner=${leading.withBanner}`);

  /* A caption whose lines are short by design must survive the stripper. Judging leading lines on
     length alone ate this one whole — "🕵️ WHO AM I?" is thirteen characters and is the most
     distinctive thing in the post. */
  const shortLines = await runCaptions([{
    text: "Sportsfc.fans\n23h\n🕵️ WHO AM I?\nHere's your football challenge for today.\n" +
          "✅ I've played alongside Lionel Messi.\n✅ I've been managed by Pep Guardiola.",
  }], 2, false);
  check(shortLines.captions.length === 1 && /WHO AM I/.test(shortLines.captions[0].text),
    "a caption built from short lines keeps its distinctive opening",
    JSON.stringify(shortLines.captions.map(c => c.text.slice(0, 40))));
  check(shortLines.captions[0] && shortLines.captions[0].text.indexOf("Sportsfc.fans") === -1 &&
        shortLines.captions[0].text.indexOf("23h") === -1,
    "while the page name and timestamp still go");

  /* why a DOM article was passed over, counted — the banner depends on that path working.
     Counts accumulate over the poll rounds, so what matters is which reasons fired. */
  const rejected = await runCaptions([
    { text: "Like  Comment  Share  ·  All reactions  ·  View more" },
    { text: "Sportsfc.vn\n2h\nshort" },
  ], 4, false);
  check(rejected.rejects && rejected.rejects.chrome > 0 && rejected.rejects.short > 0 &&
        !rejected.rejects.empty,
    "each rejection is counted, by the reason that fired",
    JSON.stringify(rejected.rejects));

  /* the HTML finds the words, the DOM brings the picture for the same post */
  const lend = await runCaptions(
    [{ text: FEED[1], imgs: [{ src: "https://scontent.fb.com/b4.jpg", w: 700, h: 700 }] }],
    4, false, `{"message":{"text":"${FEED[1]}"}}`);
  check(lend.captions.length === 1 && lend.captions[0].thumb === "https://scontent.fb.com/b4.jpg",
    "a caption the HTML found first still gains the DOM article's banner",
    `n=${lend.captions.length} thumb=${lend.captions[0] && lend.captions[0].thumb}`);

  /* a video post shows its poster frame rather than nothing */
  const vid = await runCaptions([{ text: FEED[1], poster: "https://scontent.fb.com/poster.jpg", imgs: [] }], 2, false);
  check(vid.captions[0] && vid.captions[0].thumb === "https://scontent.fb.com/poster.jpg",
    "a video post uses its poster frame", vid.captions[0] && vid.captions[0].thumb);

  /* the payload knows the words, the page knows the picture — neither should lose to the other */
  const merged = await runCaptions(
    [{ text: FEED[0], imgs: [{ src: "https://scontent.fb.com/b2.jpg", w: 900, h: 900 }] }],
    4, false, `{"message":{"text":"${FEED[0]}"}}`);
  check(merged.captions.length === 1 && merged.captions[0].thumb === "https://scontent.fb.com/b2.jpg",
    "the same caption from both sources keeps the richer fields",
    JSON.stringify({ n: merged.captions.length, thumb: merged.captions[0] && merged.captions[0].thumb }));

  /* ── the HTML routes ────────────────────────────────────────────────────
     The primary path: the page's own payload carries real unix timestamps, so no rendering is
     needed and Facebook posts get exact instants instead of "2h". None of it can be checked
     against the live site — every route answers 400 to anything but a logged-in session — so the
     parser is pinned against synthetic payloads shaped like Facebook's own. */
  const pStart = src.indexOf("const FB_STAMP_RX");
  const pEnd = src.indexOf("/* Runs in the service worker: a plain credentialed fetch");
  const P = new Function(src.slice(pStart, pEnd) + "\n;return { fbParseHtml };")();
  const now = Date.now();
  const ago = h => Math.floor((now - h * 3600e3) / 1000);

  const htmlCases = [
    ["creation_time with post ids",
      `{"creation_time":${ago(2)},"post_id":"111111"} {"creation_time":${ago(30)}} <a href="/x/posts/pfbidAAA">`,
      r => r.stamps.length === 2 && r.ids.length === 2],
    ["data-utime, the older mobile markup",
      `<abbr data-utime="${ago(1)}">1 hr</abbr><abbr data-utime="${ago(26)}">Yesterday</abbr>`,
      r => r.stamps.length === 2],
    /* Facebook's payloads are littered with unrelated epochs — cache keys, config stamps */
    ["implausible epochs dropped",
      `{"creation_time":1}{"creation_time":99999999999}{"creation_time":${ago(3)}}`,
      r => r.stamps.length === 1],
    ["future stamps dropped",
      `{"creation_time":${Math.floor((now + 7 * 86400e3) / 1000)}}{"creation_time":${ago(5)}}`,
      r => r.stamps.length === 1],
    ["a login wall is recognised",
      `<form action="/login/?next"><input name="pass"></form>`,
      r => r.login === true && r.stamps.length === 0],
    ["newest first",
      `{"creation_time":${ago(20)}}{"creation_time":${ago(2)}}`,
      r => r.stamps[0] > r.stamps[1]],
    /* captions are paired positionally or not at all — a mismatched pairing would pin the wrong
       text to a post and invent a language fault */
    /* captions must clear the same length floor as the DOM path, so the fixtures are as long as
       the real posts are */
    ["a text count that does not match is left unpaired",
      `{"creation_time":${ago(2)}}{"creation_time":${ago(4)}}` +
      `{"message":{"text":"Hai huyen thoai. Mot de che. Mot cuoc tranh luan chua co hoi ket."}}`,
      r => r.stamps.length === 2 && r.texts.length === 1],
    ["escaped caption decodes",
      `{"creation_time":${ago(2)}}` +
      `{"message":{"text":"Two icons.\\nOne generation.\\nOne \\u0022impossible\\u0022 choice for the ages."}}`,
      r => r.texts.length === 1 && r.texts[0].indexOf('"impossible"') !== -1],
    ["a short label under the message key is not a caption",
      `{"creation_time":${ago(2)}}{"message":{"text":"See more"}}`,
      r => r.texts.length === 0],
  ];

  for (const [label, html, ok] of htmlCases) {
    const r = P.fbParseHtml(html, now);
    check(ok(r), label, `stamps=${r.stamps.length} ids=${r.ids.length} texts=${r.texts.length} login=${r.login}`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
