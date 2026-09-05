/**
 * extension/background.js — igTabScrape, the Instagram profile-PAGE reader.
 *
 * Why this route exists at all: the API route (igScrape) is a background fetch, and a background
 * fetch carries Sec-Fetch-Dest: empty — the exact request shape X was found to answer with an
 * empty shell, and Instagram throttles it the same way. A real navigation gets the profile AND its
 * first page of posts embedded in the document. This reads those.
 *
 * The parser deliberately does NOT follow a fixed path into Instagram's JSON — it walks every
 * embedded block and keeps whatever carries both a shortcode and a taken_at instant. These fixtures
 * therefore nest the posts differently on purpose: if a future Instagram build moves them again,
 * the walk should still find them, and this test is what proves the walk is doing the work rather
 * than a lucky path.
 *
 *   node test/ig-tab.test.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
const START = "function igTabScrape(handle, maxWaitMs, pollMs) {";
const END = "/* one tab per account: the profile page IS the request that works";
const a = SRC.indexOf(START), b = SRC.indexOf(END);
if (a === -1 || b === -1) { console.error("FAIL  could not find igTabScrape's bounds in background.js"); process.exit(1); }
const body = SRC.slice(a, b);

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

/* a stub of just the page surface igTabScrape touches */
function pageWith(jsonBlocks, opts) {
  const o = opts || {};
  const scripts = jsonBlocks.map(j => ({ textContent: typeof j === "string" ? j : JSON.stringify(j) }));
  const gridLinks = (o.gridHrefs || []).map((h, i) => ({
    getAttribute: k => (k === "href" ? h : null),
    /* the grid's thumbnail carries the alt text the reader falls back to for a caption */
    querySelector: sel => (/img/.test(sel)
      ? { getAttribute: k => (k === "alt" ? ((o.gridAlts || [])[i] || "")
                            : k === "src" ? "https://scontent/g" + i + ".jpg" : null) }
      : null),
  }));
  return {
    querySelectorAll: sel => {
      if (sel === 'script[type="application/json"]') return scripts;
      if (/a\[href/.test(sel)) return gridLinks;
      return [];
    },
    querySelector: sel => (o.loginInputs && /password|username/.test(sel) ? {} : null),
    body: { innerText: o.bodyText || "" },
  };
}

/* `embeds` maps a shortcode to the HTML its /p/<code>/embed/ page would return, standing in for
   the per-post date lookup. Absent, every embed fetch simply fails, which is itself a case worth
   covering: no date must ever be invented for a post whose date could not be read. */
function run(handle, doc, location, embeds) {
  const fetchStub = async url => {
    const m = String(url).match(/\/p\/([\w-]+)\/embed/);
    const html = m && embeds && embeds[m[1]];
    if (!html) throw new Error("no embed stub for " + url);
    return { ok: true, text: async () => html };
  };
  const fn = new Function("document", "location", "setTimeout", "fetch", "handle",
    body + "\n;return igTabScrape(handle, 3000, 1);");
  return fn(doc, location || { pathname: "/" + handle + "/", href: "https://www.instagram.com/" + handle + "/" },
            (f, ms) => setTimeout(f, 0), fetchStub, handle);
}

(async () => {
  /* ── posts buried at different depths, as Instagram's builds actually vary ─── */
  {
    const doc = pageWith([
      /* a config block with no posts in it — must be skipped without throwing */
      { config: { csrf: "abc" }, viewer: { id: "1" } },
      /* posts nested under one shape */
      { require: [["ProfilePage", "init", [{ data: { user: { edge_owner_to_timeline_media: { edges: [
        { node: { code: "DAA111", taken_at: 1755000000, media_type: 2, product_type: "clips",
                  caption: { text: "Bàn thắng phút 90" }, play_count: 5000, like_count: 120,
                  comment_count: 8, video_duration: 14.4,
                  owner: { username: "sportsfc.vn" },
                  image_versions2: { candidates: [{ url: "https://scontent/a.jpg" }] } } },
      ] } } } }]]] },
      /* and a second, differently-shaped block */
      { items: [ { code: "DAA222", taken_at: 1755001000, media_type: 8,
                   caption: { text: "chùm ảnh" }, like_count: 40, owner: { username: "sportsfc.vn" } } ] },
    ], { gridHrefs: ["/p/DAA111/", "/reel/DAA222/", "/p/DAA333/"] });

    const r = await run("sportsfc.vn", doc);
    check(r.posts.length === 2, "posts are found at two different nesting depths", r.posts.length);
    const reel = r.posts.find(p => p.externalId === "DAA111");
    const car = r.posts.find(p => p.externalId === "DAA222");
    check(reel && reel.kind === "reel", "product_type clips wins over media_type — it is a reel", reel && reel.kind);
    check(reel && reel.views === 5000 && reel.likes === 120 && reel.comments === 8,
      "counts come across", reel && JSON.stringify({ v: reel.views, l: reel.likes, c: reel.comments }));
    check(reel && reel.duration === 14, "duration is rounded to seconds", reel && reel.duration);
    check(reel && reel.permalink === "https://www.instagram.com/reel/DAA111/", "a reel gets a /reel/ permalink",
      reel && reel.permalink);
    check(car && car.kind === "carousel" && car.views === null,
      "media_type 8 is a carousel and reports null views, not 0",
      car && JSON.stringify({ kind: car.kind, views: car.views }));
    check(r.posts[0].externalId === "DAA222", "newest first — the report relies on it",
      r.posts.map(p => p.externalId).join(","));
    check(r.gridCodes === 3, "the grid's own links are counted as corroboration", r.gridCodes);
  }

  /* ── Meta's real envelope: the post is SIXTEEN levels down ──────────────────
     Instagram does not ship a shallow blob. Its profile page wraps the timeline in the Polaris
     streaming envelope, which burns ten or eleven levels before any payload — and the walk charges
     a level per array element as well as per key. An earlier depth cap of 14 meant this reader
     could never reach a single real post on a live profile, while every fixture here (all about
     ten levels deep) passed. That is the exact shape of bug a test suite is supposed to catch, so
     the envelope is reproduced faithfully rather than approximated. */
  {
    const node = {
      code: "DEEP01", taken_at: 1755003000, media_type: 2, product_type: "clips",
      caption: { text: "buried sixteen levels down" }, play_count: 77, like_count: 5,
      owner: { username: "sportsfc.vn" },
    };
    const envelope = {
      require: [["ScheduledServerJS", "handle", null, [
        { __bbox: { require: [["RelayPrefetchedStreamCache", "next", [], [
          "adp_PolarisProfilePostsQueryRelayPreloader",
          { __bbox: { result: { data: {
            xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [{ node }] },
          } } } },
        ]]] } },
      ]]],
    };
    const r = await run("sportsfc.vn", pageWith([envelope]));
    check(r.posts.length === 1 && r.posts[0].externalId === "DEEP01",
      "a post inside Meta's real streaming envelope is still found",
      JSON.stringify(r.posts.map(p => p.externalId)) + " diag=" + (r.diag || "-"));
    check(r.posts.length === 1 && r.posts[0].kind === "reel",
      "and it is still classified correctly at that depth", r.posts[0] && r.posts[0].kind);
  }

  /* ── the grid renders posts but the page carries no dates ───────────────────
     Measured live on a logged-in profile: twelve posts on screen, and not one date anywhere in the
     page's JSON. Without an instant a post cannot be matched to a drop, so the channel reported
     nothing while a dozen posts sat plainly visible. Each post is therefore asked for its own date
     via its public embed — and only a date Instagram actually returns is ever used. */
  {
    const embedFor = (unix, caption) =>
      `<html><body><script>window.__d=({"taken_at_timestamp":${unix},` +
      `"edge_media_to_caption":{"edges":[{"node":{"text":"${caption}"}}]}})</script></body></html>`;
    const doc = pageWith([], { gridHrefs: ["/p/AAA111/", "/reel/BBB222/", "/p/CCC333/"] });
    const r = await run("sportsfc.vn", doc, null, {
      AAA111: embedFor(1755000000, "first post"),
      BBB222: embedFor(1755009000, "the reel"),
      /* CCC333 has no embed available — it must simply be left out, never dated by guesswork */
    });
    check(r.posts.length === 2, "a post whose date the embed returned is recovered", r.posts.length);
    check(r.posts[0].externalId === "BBB222" && r.posts[0].kind === "reel",
      "a /reel/ link keeps its kind and the newest sorts first",
      r.posts.map(p => p.externalId + ":" + p.kind).join(","));
    check(r.posts[0].ts === new Date(1755009000 * 1000).toISOString(),
      "the instant is the one Instagram gave, not one derived from the shortcode", r.posts[0].ts);
    check(r.posts.find(p => p.externalId === "AAA111").text === "first post",
      "the caption comes from the embed");
    check(!r.posts.some(p => p.externalId === "CCC333"),
      "a post whose date could NOT be read is left out rather than dated by guesswork",
      JSON.stringify(r.posts.map(p => p.externalId)));
    check(r.posts.every(p => p.likes === null && p.views === null),
      "counts the embed does not carry stay null — never a fabricated zero");
  }

  /* and when no embed answers at all, the channel still reports unknown rather than empty */
  {
    const doc = pageWith([], { gridHrefs: ["/p/ZZZ999/"] });
    const r = await run("sportsfc.vn", doc, null, {});
    check(!r.posts.length && /neither the page's own data nor asking each post/.test(r.diag),
      "with no date obtainable anywhere, it says so plainly instead of reporting nothing posted",
      r.diag);
  }

  /* ── someone else's post riding along in the same payload ──────────────────── */
  {
    const doc = pageWith([
      { any: [
        { code: "MINE01", taken_at: 1755000000, owner: { username: "sportsfc.vn" }, caption: { text: "mine" } },
        { code: "THEIR1", taken_at: 1755000000, owner: { username: "some_other_acct" }, caption: { text: "theirs" } },
        /* a suggested post with the user nested under `user` rather than `owner` */
        { code: "THEIR2", taken_at: 1755000000, user: { username: "another_one" }, caption: { text: "also theirs" } },
      ] },
    ]);
    const r = await run("sportsfc.vn", doc);
    check(r.posts.length === 1 && r.posts[0].text === "mine",
      "a tagged or suggested post from another account is not counted for this channel",
      JSON.stringify(r.posts.map(p => p.text)));
  }

  /* ── things that look like posts but are not ───────────────────────────────── */
  {
    const doc = pageWith([
      { junk: [
        { code: "TOOOLD", taken_at: 100 },                       // not a plausible instant
        { code: "!!bad!!", taken_at: 1755000000 },                // not a shortcode
        { code: "NOTIME" },                                       // no instant at all
        { code: "GOOD01", taken_at: 1755000000, caption: { text: "kept" } },
      ] },
    ]);
    const r = await run("sportsfc.vn", doc);
    check(r.posts.length === 1 && r.posts[0].externalId === "GOOD01",
      "only a real shortcode with a plausible instant is kept", JSON.stringify(r.posts.map(p => p.externalId)));
  }

  /* ── the empty cases each say WHY, so the report never guesses ─────────────── */
  {
    const loggedOut = await run("sportsfc.vn", pageWith([], { loginInputs: true }),
      { pathname: "/accounts/login/", href: "https://www.instagram.com/accounts/login/" });
    check(!loggedOut.posts.length && /not logged into instagram/.test(loggedOut.diag),
      "a login page is named as such", loggedOut.diag);

    const gone = await run("sportsfc.vn", pageWith([], { bodyText: "Sorry, this page isn't available." }));
    check(!gone.posts.length && /does not exist/.test(gone.diag), "a missing profile is named as such", gone.diag);

    const priv = await run("sportsfc.vn", pageWith([], { bodyText: "This account is private" }));
    check(!priv.posts.length && /private/.test(priv.diag), "a private account is named as such", priv.diag);

    const dateless = await run("sportsfc.vn", pageWith([], { gridHrefs: ["/p/AAA/", "/p/BBB/"] }));
    check(!dateless.posts.length && /grid shows 2 post\(s\)/.test(dateless.diag),
      "posts visible but undated is reported as exactly that — never as 'nothing posted'", dateless.diag);

    const nothing = await run("sportsfc.vn", pageWith([]));
    check(!nothing.posts.length && /no post data was embedded/.test(nothing.diag),
      "an unrecognised empty page still gets a plain, honest diagnostic", nothing.diag);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
