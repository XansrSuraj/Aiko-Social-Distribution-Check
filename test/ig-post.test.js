/**
 * extension/background.js — igPostRead, the per-post date reader.
 *
 * This exists because of a measured dead end. On a logged-in profile Instagram renders twelve posts
 * in the grid, carries a date for none of them, and refuses every background request for one — the
 * API answered 429 and so did each post's embed. The profile page itself rendered perfectly, which
 * is the tell: Instagram throttles this browser's FETCHES while serving its NAVIGATIONS normally.
 * So the reader navigates to each post instead, and this is what runs when it lands there.
 *
 * The rule these cases exist to hold: a date is either read from the page or the post is dropped.
 * Nothing here may ever invent, derive or approximate an instant — a plausible-looking wrong date
 * would silently match a post to the wrong drop, which is worse than reporting nothing.
 *
 *   node test/ig-post.test.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
const START = "function igPostRead() {";
const END = "/* one tab per account: the profile page IS the request that works";
const a = SRC.indexOf(START), b = SRC.indexOf(END);
if (a === -1 || b === -1) { console.error("FAIL  could not find igPostRead's bounds in background.js"); process.exit(1); }
const body = SRC.slice(a, b);

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

/* just enough page for igPostRead: the raw HTML it regexes, a <time> it may fall back to, and the
   meta description it may take a caption from */
function postPage(html, opts) {
  const o = opts || {};
  return {
    documentElement: { innerHTML: html },
    querySelector: sel => {
      if (sel === "time[datetime]") return o.datetime ? { getAttribute: () => o.datetime } : null;
      if (/meta\[/.test(sel)) return o.ogDescription ? { getAttribute: () => o.ogDescription } : null;
      return null;
    },
  };
}

function run(doc, pathname) {
  const fn = new Function("document", "location", body + "\n;return igPostRead();");
  return fn(doc, { pathname: pathname || "/p/ABC123/" });
}

const RECENT = Math.floor((Date.now() - 3 * 3600e3) / 1000);      // three hours ago

(async () => {
  /* the ordinary case: the page states the instant outright */
  {
    const r = run(postPage(
      `<html>{"taken_at_timestamp":${RECENT},"edge_media_to_caption":{"edges":[{"node":{"text":"Bàn thắng phút 90"}}]},` +
      `"edge_media_preview_like":{"count":420},"video_view_count":9001}</html>`));
    check(r.at === RECENT * 1000, "the post's own timestamp is read", new Date(r.at).toISOString());
    check(r.text === "Bàn thắng phút 90", "and its caption with it", r.text);
    check(r.likes === 420 && r.views === 9001, "counts the page states are kept",
      JSON.stringify({ likes: r.likes, views: r.views }));
  }

  /* the newer key spelling, which some builds use */
  {
    const r = run(postPage(`<html>{"taken_at":${RECENT}}</html>`));
    check(r.at === RECENT * 1000, "'taken_at' is accepted as well as 'taken_at_timestamp'", String(r.at));
  }

  /* no timestamp in the data — fall back to the one the post renders for a reader */
  {
    const iso = new Date(Date.now() - 2 * 3600e3).toISOString();
    const r = run(postPage("<html>nothing useful here</html>", { datetime: iso }));
    check(r.at === new Date(iso).getTime(), "a <time datetime> is used when the page data has none", iso);
  }

  /* THE RULE: no readable date means no date, never a guess */
  {
    const r = run(postPage("<html>a page with no date anywhere</html>"));
    check(r.at === null, "a post with no readable date reports null — it is dropped, never dated by guesswork",
      String(r.at));
  }

  /* and an implausible date is treated as no date rather than believed */
  {
    const ancient = run(postPage('<html>{"taken_at_timestamp":1000000000}</html>'));   // 2001
    check(ancient.at === null, "a date from before Instagram existed is refused, not filed", String(ancient.at));
    const future = run(postPage(`<html>{"taken_at_timestamp":${Math.floor(Date.now() / 1000) + 90000}}</html>`));
    check(future.at === null, "and so is one in the future", String(future.at));
  }

  /* the caption has a fallback of its own, but only for the words — never for the date */
  {
    const r = run(postPage(`<html>{"taken_at_timestamp":${RECENT}}</html>`, { ogDescription: "42 likes — the caption" }));
    check(r.text === "42 likes — the caption", "the meta description supplies a caption when the data has none", r.text);
    check(r.likes === null && r.views === null,
      "counts absent from the page stay null — never inferred from the description",
      JSON.stringify({ likes: r.likes, views: r.views }));
  }

  /* a login wall is reported so the caller can say so rather than calling the post undated */
  {
    const r = run(postPage("<html>please log in</html>"), "/accounts/login/");
    check(r.loginWall === true, "a login redirect is flagged", String(r.loginWall));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
