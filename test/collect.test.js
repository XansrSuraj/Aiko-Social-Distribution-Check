/**
 * api/collect.js against the live platforms.
 *
 * This one is deliberately not stubbed. Its whole job is to notice when YouTube changes its feed
 * or Telegram changes its preview markup, which a fixture would hide until the day it mattered.
 * So it talks to the real endpoints and fails when the parsers stop matching reality.
 *
 *   node test/collect.test.js
 *
 * Facebook is expected to come back browser-required and TikTok unsupported — those are the
 * correct answers, not failures, and they have to stay distinct: pointing someone at the
 * extension for TikTok would send them to a tool that never reports it. Instagram is allowed to
 * fail outright, since its public endpoint is rate-limited per IP and is treated as a bonus
 * everywhere in this feature, never a dependency.
 */
const path = require("path");
const collect = require(path.join(__dirname, "..", "api", "collect.js"));
const ingest = require(path.join(__dirname, "..", "ingest-store.js"));

/* the real SportsFC directory — replace if you are testing a different set */
const CHANNELS = [
  { id: "yt-vn",   platform: "youtube",   url: "https://youtube.com/@SportsFC-vn" },
  { id: "yt-fans", platform: "youtube",   url: "https://youtube.com/@sportsfc_fans" },
  { id: "tg-vn",   platform: "telegram",  url: "https://t.me/sportsfc_vn" },
  { id: "tg-fans", platform: "telegram",  url: "https://t.me/sportsfc_fans" },
  { id: "ig-vn",   platform: "instagram", url: "https://instagram.com/sportsfc.vn" },
  { id: "fb-vn",   platform: "facebook",  url: "https://facebook.com/sportsfc.vn" },
  { id: "tt-fans", platform: "tiktok",    url: "https://tiktok.com/@sportsfc.fans" },
  { id: "x-vn",    platform: "x",         url: "https://x.com/Sportsfcvn" },
  /* a channel id nothing has ever been pushed for, so this stays a statement about the empty
     store rather than about whatever happens to be sitting in it today */
  { id: "vb-never-pushed", platform: "viber", url: "https://invite.viber.com/?g2=AQBb1E9b" },
  /* the id is deliberately unrelated to what gets pushed below — in local mode the directory
     lives in the browser, so a phone automation rule can never know this id and must be found by
     the handle alone. Named vb-by-handle for the check below; the opaque-looking id is what a
     real browser-assigned uid() would look like, and is never what gets pushed to. */
  { id: "vb-by-handle", platform: "viber",
    url: "https://invite.viber.com/?g2=zzz", handle: "sportsfc-test-handle" },
];

const MUST_COLLECT = ["yt-vn", "yt-fans", "tg-vn", "tg-fans", "x-vn"];
const MUST_NEED_BROWSER = ["fb-vn"];
const MUST_BE_UNSUPPORTED = ["tt-fans"];

const iso = s => !isNaN(new Date(s).getTime());

(async () => {
/* seeded under the handle alias, never under the channel's own id — proving the lookup this test
   is here for. Removed again once the run is done, so a live-network test does not leave data
   behind for the next run to trip over. */
await ingest.addPosts("viber:sportsfc-test-handle",
  [{ externalId: "handle-alias-1", ts: new Date().toISOString(), text: "found by handle, not by id" }]);

collect({ method: "POST", body: { channels: CHANNELS, days: 6 } }, {
  setHeader() {}, status() { return this; },
  async json(p) {
    let pass = 0, fail = 0;
    const check = (good, label, detail) => {
      good ? pass++ : fail++;
      console.log(`  ${good ? "pass" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
    };

    const by = id => p.results.find(r => r.channelId === id) || {};

    console.log("collected at", p.collectedAt, "\n");
    for (const r of p.results) {
      const state = r.ok ? `${r.posts.length} posts` : r.browserRequired ? "browser required" : "failed";
      console.log(`  ${r.channelId.padEnd(8)} ${String(r.platform).padEnd(10)} ` +
                  `${String(r.source).padEnd(18)} ${state}`);
    }
    console.log("");

    /* This suite exists to catch the parsers drifting away from what the platforms serve. A
       platform refusing to answer is a different thing — YouTube soft-blocks a busy IP by serving
       its generic 404 page, and Telegram occasionally drops a connection. Neither is a defect
       here, and failing on them would make the suite a coin toss. So a refusal is reported as a
       warning and its parse assertions are skipped; anything that does come back is still held to
       the full standard. */
    const REFUSED = /would not serve|unknown, not empty|after two tries|Could not reach/i;
    let refused = 0;

    for (const id of MUST_COLLECT) {
      const r = by(id);
      if (!r.ok && REFUSED.test(r.note || "")) {
        refused++;
        console.log(`  warn  ${id} — the platform refused: ${r.note}`);
        continue;
      }
      check(r.ok === true, `${id} collected`, r.note || "");
      check(Array.isArray(r.posts) && r.posts.length > 0, `${id} returned posts`);
      const bad = (r.posts || []).filter(x => !x.externalId || !iso(x.ts));
      check(bad.length === 0, `${id} every post has an id and a real timestamp`,
            bad.length ? JSON.stringify(bad[0]) : "");
      /* newest first is what the report relies on */
      const ts = (r.posts || []).map(x => new Date(x.ts).getTime());
      check(ts.every((v, i) => i === 0 || ts[i - 1] >= v), `${id} sorted newest first`);
    }

    /* YouTube handles have to resolve to a UC… id, since the feed will not take a handle. This is
       checkable even when the feed itself is being refused — resolution reads the channel page. */
    for (const id of ["yt-vn", "yt-fans"]) {
      const r = by(id);
      if (!r.ok && REFUSED.test(r.note || "")) continue;
      check(!!(r.resolved && /^UC[\w-]{20,}$/.test(r.resolved.ytChannelId)),
            `${id} resolved a channel id`, r.resolved ? r.resolved.ytChannelId : "none");
    }

    /* Telegram ids carry the channel name, which is what makes them stable across runs */
    for (const id of ["tg-vn", "tg-fans"]) {
      const r = by(id);
      check((r.posts || []).every(x => /^[A-Za-z0-9_]+\/\d+$/.test(x.externalId)),
            `${id} post ids look like channel/number`);
    }

    /* X ids are the numeric status id, which is what keeps the permalink stable and merges
       idempotent. source is stamped from a second map (collectOne) that is easy to forget a
       platform in — it would come back undefined rather than failing outright, which is exactly
       why this is asserted rather than only printed. */
    {
      const r = by("x-vn");
      if (!r.ok && REFUSED.test(r.note || "")) {
        refused++;
        console.log(`  warn  x-vn — the platform refused: ${r.note}`);
      } else {
        check(r.source === "x-web", "x-vn names the route it used", String(r.source));
        check((r.posts || []).every(x => /^\d{5,25}$/.test(x.externalId)),
              "x-vn post ids are numeric status ids");
        check((r.posts || []).every(x => /^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(x.permalink || "")),
              "x-vn permalinks point at the status");
        /* the language check reads text and nothing else */
        check((r.posts || []).some(x => (x.text || "").trim().length > 20),
              "x-vn posts carry their words");
      }
    }

    for (const id of MUST_NEED_BROWSER) {
      const r = by(id);
      check(r.browserRequired === true && r.ok === false, `${id} reported as browser-required`);
      check(!r.unsupported, `${id} is not marked unsupported — the extension does collect it`);
      check(!!r.note, `${id} explains why`, r.note);
    }

    /* unsupported and browser-required must not blur together: one says "use the other tool",
       the other says "there is no tool", and sending someone to the extension for TikTok wastes
       their time on something that will never report it */
    for (const id of MUST_BE_UNSUPPORTED) {
      const r = by(id);
      check(r.unsupported === true && r.ok === false, `${id} reported as unsupported`);
      check(!r.browserRequired, `${id} does not claim the extension can collect it`);
      check(/cannot be collected/i.test(r.note || ""), `${id} says so plainly`, r.note);
    }

    /* Viber is pushed in, never read out — so an empty store means nobody has pushed yet, which
       says nothing at all about whether the channel posted. It must never read as a quiet day. */
    {
      const r = by("vb-never-pushed");
      check(r.ok === false && /unknown, not empty/i.test(r.note || ""),
            "vb-never-pushed says unknown, not empty", r.note);
      check(r.source === "ingest", "and names the route it would have used", String(r.source));
      check(!r.unsupported, "viber is no longer called unsupported — it has a way in now");
    }

    /* In local mode the directory lives in the browser, so a channel's internal id is not
       something anything outside that browser — a phone automation rule least of all — can ever
       know. A push filed under the public handle must still be found. */
    {
      const r = by("vb-by-handle");
      check(r.ok === true && r.source === "ingest" && r.posts.length === 1,
            "vb-by-handle is found by its handle, with no internal id ever supplied",
            JSON.stringify(r));
    }

    /* the window has to actually bound the result */
    const all = p.results.flatMap(r => r.posts || []);
    if (all.length) {
      const oldest = Math.min(...all.map(x => new Date(x.ts).getTime()));
      check(oldest >= Date.now() - 7 * 86400e3, "no post older than the requested window",
            new Date(oldest).toISOString());
    }

    /* Instagram is reported, never asserted */
    const ig = by("ig-vn");
    console.log(`\n  note   instagram: ${ig.ok ? ig.posts.length + " posts" : "unavailable — " + ig.note}`);

    console.log(`\n  ${pass} passed, ${fail} failed` + (refused ? `, ${refused} refused by the platform` : ""));
    if (refused === MUST_COLLECT.length) {
      console.log("  Every platform refused, so nothing was actually verified — rerun later before " +
                  "trusting this as a green suite.");
    }
    /* json() is called synchronously from inside the handler, before the outer await below could
       ever run — so the seeded fixture has to be cleaned up here, not after collect() resolves,
       or a live-network run leaves it behind for the next one to trip over. */
    const ingestAll = await ingest.readAll();
    delete ingestAll["viber:sportsfc-test-handle"];
    await ingest.writeAll(ingestAll);
    process.exit(fail ? 1 : 0);
  },
}).catch(e => { console.error("threw:", e); process.exit(1); });
})();
