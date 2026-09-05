/**
 * extension/background.js — the TikTok parser (ttScrape), checked against realistic shapes of the
 * JSON blob TikTok embeds in a profile page (__UNIVERSAL_DATA_FOR_REHYDRATION__, with SIGI_STATE as
 * the older fallback). Written alongside the TikTok reader itself so its field-mapping and edge
 * cases (a related video riding along, a bot-check wall, a dead handle) are locked in from day one
 * rather than only ever being eyeballed live.
 *
 *   node test/tt-ext.test.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
const START = "function ttScrape(handle) {";
/* anchored on the name alone — the signature has already gained a parameter once, and a marker
   that pins the whole argument list turns an ordinary refactor into a mystery test failure */
const END = "async function ttCollect(";
const a = SRC.indexOf(START), b = SRC.indexOf(END);
if (a === -1 || b === -1) { console.error("FAIL  could not find ttScrape's bounds in background.js"); process.exit(1); }
const body = SRC.slice(a, b);

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

/* a stub document exposing the two script tags ttScrape reads, the rendered grid it falls back to,
   and body.innerText for the bot-check/dead-account diagnosis path */
function docWith(scripts, bodyText, gridHrefs, alts) {
  const links = (gridHrefs || []).map((h, i) => ({
    getAttribute: k => (k === "href" ? h : null),
    querySelector: () => ((alts && alts[i] !== undefined)
      ? { getAttribute: k => (k === "alt" ? alts[i] : k === "src" ? "https://p16/c" + i + ".jpg" : null) }
      : null),
  }));
  return {
    getElementById: id => (id in scripts ? { textContent: JSON.stringify(scripts[id]) } : null),
    querySelectorAll: sel => (/\/video\//.test(sel) ? links : []),
    body: { innerText: bodyText || "", innerHTML: (gridHrefs || []).join(" ") },
  };
}

function run(handle, doc) {
  const fn = new Function("document", "handle", body + "\n;return ttScrape(handle);");
  return fn(doc, handle);
}

(async () => {
  /* ── the current build's script tag ────────────────────────────────────────── */
  {
    const doc = docWith({
      __UNIVERSAL_DATA_FOR_REHYDRATION__: { __DEFAULT_SCOPE__: { "webapp.user-detail": { itemList: [
        {
          id: "7001", createTime: 1755000000, desc: "Bàn thắng phút 90",
          author: { uniqueId: "sportsfc.fans" },
          video: { duration: 15.6, cover: "https://p16/cover1.jpg" },
          stats: { playCount: 12000, diggCount: 900, commentCount: 30, shareCount: 5 },
        },
        {
          id: "7002", createTime: 1755001000, desc: "ảnh trận đấu",
          author: { uniqueId: "sportsfc.fans" },
          imagePost: { images: [{ imageURL: { urlList: ["https://p16/img1.jpg"] } }] },
        },
      ] } } },
    });
    const r = run("sportsfc.fans", doc);
    check(r.posts.length === 2, "both of this account's items became posts", r.posts.length);
    const [video, photo] = r.posts;
    check(video.kind === "video" && video.duration === 16, "a video item is kind video, duration rounded",
      JSON.stringify({ kind: video.kind, duration: video.duration }));
    check(video.views === 12000 && video.likes === 900 && video.comments === 30 && video.reposts === 5,
      "stats map to views/likes/comments/reposts", JSON.stringify({ v: video.views, l: video.likes, c: video.comments, r: video.reposts }));
    check(video.permalink === "https://www.tiktok.com/@sportsfc.fans/video/7001", "permalink is built from the handle and id", video.permalink);
    check(photo.kind === "carousel" && photo.views === null, "an imagePost item is a carousel, with no play count to report",
      JSON.stringify({ kind: photo.kind, views: photo.views }));
    check(photo.thumb === "https://p16/img1.jpg", "a photo post's thumbnail comes from its own image list", photo.thumb);
  }

  /* ── the older SIGI_STATE build, only reached when rehydration is absent ───── */
  {
    const doc = docWith({
      SIGI_STATE: { ItemModule: {
        "8001": { id: "8001", createTime: 1755002000, desc: "sigi build", author: "sportsfc.fans",
                  video: { duration: 8 }, stats: { playCount: 10 } },
      } },
    });
    const r = run("sportsfc.fans", doc);
    check(r.posts.length === 1 && r.posts[0].externalId === "8001", "SIGI_STATE's ItemModule is read when there is no rehydration script",
      JSON.stringify(r.tried));
  }

  /* ── a recommended/related video from another account does not count for this channel ── */
  {
    const doc = docWith({
      __UNIVERSAL_DATA_FOR_REHYDRATION__: { __DEFAULT_SCOPE__: { "webapp.user-detail": { itemList: [
        { id: "1", createTime: 1755000000, desc: "mine", author: { uniqueId: "sportsfc.fans" } },
        { id: "2", createTime: 1755000000, desc: "someone else's", author: { uniqueId: "unrelated_account" } },
      ] } } },
    });
    const r = run("sportsfc.fans", doc);
    check(r.posts.length === 1 && r.posts[0].text === "mine", "an item authored by a different account is filtered out",
      JSON.stringify(r.posts.map(p => p.text)));
  }

  /* ── an item missing an id or a real createTime is dropped, not filed half-formed ── */
  {
    const doc = docWith({
      __UNIVERSAL_DATA_FOR_REHYDRATION__: { __DEFAULT_SCOPE__: { "webapp.user-detail": { itemList: [
        { id: "", createTime: 1755000000, desc: "no id" },
        { id: "9", createTime: 0, desc: "no real time" },
        { id: "10", createTime: 1755000000, desc: "kept" },
      ] } } },
    });
    const r = run("sportsfc.fans", doc);
    check(r.posts.length === 1 && r.posts[0].text === "kept", "only the complete item survives",
      JSON.stringify(r.posts.map(p => p.text)));
  }

  /* ── the rendered grid, which is what a real browser actually gives ──────────
     TikTok commonly ships an EMPTY itemList and fills the grid from its own XHR after load — a
     probe from two networks measured exactly that, so a reader that only parsed the script tags
     returned nothing even when the network could reach TikTok perfectly well. The grid alone is
     enough, because a TikTok video id is a snowflake whose top 32 bits are the unix second it was
     created: the href IS the post and its instant. */
  {
    const doc = docWith(
      /* the script tag is present but empty, exactly as measured live */
      { __UNIVERSAL_DATA_FOR_REHYDRATION__: { __DEFAULT_SCOPE__: { "webapp.user-detail": { userInfo: { itemList: [] } } } } },
      "",
      ["/@sportsfc.fans/video/7300000000000000000",
       "/@sportsfc.fans/video/7460000000000000000",
       "/@sportsfc.fans/video/7300000000000000000",          // the same clip linked twice on the page
       "/@someone.else/video/7455555555555555555"],           // a recommended clip from another account
      ["bàn thắng đẹp", "highlight", "bàn thắng đẹp", "not ours"]);
    const r = run("sportsfc.fans", doc);
    check(r.posts.length === 2, "the grid is read when the embedded blob is empty", r.posts.length);
    check(r.posts.every(p => p.externalId !== "7455555555555555555"),
      "another account's recommended clip is not counted for this channel",
      JSON.stringify(r.posts.map(p => p.externalId)));
    check(r.posts[0].externalId === "7460000000000000000", "newest first", r.posts.map(p => p.externalId).join(","));
    check(r.posts[0].ts === "2025-01-15T04:50:01.000Z",
      "the instant is derived from the id's snowflake, so no API is needed for the date", r.posts[0].ts);
    check(r.posts[1].text === "bàn thắng đẹp", "the caption comes off the cover image's alt text", r.posts[1].text);
    check(r.posts[1].permalink === "https://www.tiktok.com/@sportsfc.fans/video/7300000000000000000",
      "and the permalink is rebuilt in full", r.posts[1].permalink);
    check(r.posts.every(p => p.views === null),
      "counts the grid does not carry stay null — never a fabricated zero");
  }

  /* the embedded blob still wins when it IS populated — it is strictly richer than the grid */
  {
    const doc = docWith(
      { __UNIVERSAL_DATA_FOR_REHYDRATION__: { __DEFAULT_SCOPE__: { "webapp.user-detail": { itemList: [
        { id: "7300000000000000000", createTime: 1755000000, desc: "from the blob",
          author: { uniqueId: "sportsfc.fans" }, stats: { playCount: 999 }, video: { duration: 9 } },
      ] } } } },
      "", ["/@sportsfc.fans/video/7460000000000000000"], ["from the grid"]);
    const r = run("sportsfc.fans", doc);
    check(r.posts.length === 1 && r.posts[0].text === "from the blob",
      "the richer embedded data is preferred over the grid", JSON.stringify(r.posts.map(p => p.text)));
    check(r.posts[0].views === 999, "so the counts it carries are kept", r.posts[0].views);
  }

  /* ── nothing embedded at all: named as a bot-check wall or a dead handle, not silence ── */
  {
    const wall = run("sportsfc.fans", docWith({}, "Verify to continue: select 2 objects that match"));
    check(!wall.posts.length && /bot-check wall/.test(wall.diag), "a captcha wall is named as such", wall.diag);

    const dead = run("nosuchaccount", docWith({}, "Couldn't find this account"));
    check(!dead.posts.length && /does not exist/.test(dead.diag), "a dead handle is named as such", dead.diag);

    const empty = run("sportsfc.fans", docWith({}, "just an ordinary empty page"));
    check(!empty.posts.length && /neither the embedded data nor the rendered grid/.test(empty.diag),
      "an unrecognised empty page still gets a plain, honest diagnostic naming BOTH routes tried",
      empty.diag);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
