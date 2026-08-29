/**
 * reconcile() and detectLang(), read straight out of index.html.
 *
 * The logic lives inline in the page, so this extracts the block rather than keeping a copy that
 * could drift from what ships.
 *
 * Several of these cases exist because of real failures:
 *
 *   - A Facebook page's visible-post count was allowed to set the day's target, so one misread
 *     page made an entire organisation "expected 6", marked healthy channels short and empty
 *     ones fine. A suggestion may be wrong about itself; never about everyone else.
 *
 *   - Language has to be read from the caption, because a Vietnamese reel on the English channel
 *     counts as delivered and no count will ever notice. The trap is European names: "Andrés
 *     Iniesta" in an English caption carries an accent that a naive diacritic count calls
 *     Vietnamese, which would flag correct posts.
 *
 *   node test/reconcile.test.js
 */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const marker = html.indexOf("daily check ═");
const uiStart = html.indexOf("/* ── report UI ──");
if (marker < 0 || uiStart < 0) {
  console.error("could not find the daily check block in index.html");
  process.exit(1);
}
const src = html.slice(html.lastIndexOf("/*", marker), uiStart);

/* Enough of a browser to let the block load. The extension bridge registers a message listener
   and pings for the extension at the top level, neither of which exists here — stubbing them is
   what keeps this test running against the real shipped code instead of a copy. */
const ST = {};
const boot = `
  const localStorage = { getItem:k=>(k in ST?ST[k]:null), setItem:(k,v)=>{ST[k]=String(v)}, removeItem:k=>{delete ST[k]} };
  const toast = () => {};
  const location = { protocol:"http:", origin:"http://localhost:3000" };
  const addEventListener = () => {};
  const postMessage = () => {};
  const setTimeout = (fn, ms) => 0;
  const clearTimeout = () => {};
  const platform = id => ({ name:id });
  const safeUrl = u => u;
  const pretty = u => u;
`;
const M = new Function("ST", boot + src +
  "\n;return { reconcile, detectLang, clusterSlots, mergeLate, sigScore, normLang, chanLabel," +
  " contentScore, capWords, captionOverlap, checks:()=>checks };")(ST);

let pass = 0, fail = 0;
const ok = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

/* ═══════════════════ language detection ═══════════════════ */
/* real captions, copied from the two live channels */
const VI = [
  "Hai huyền thoại của Tam Sư. Hai sự nghiệp phi thường. Một cuộc tranh luận chưa bao giờ hạ nhiệt.",
  "🐐 Tuổi tác chỉ là một con số với Cristiano Ronaldo. Từ đấu trường Saudi Pro League cho đến sân khấu World Cup.",
  "🕵️‍♂️ĐOÁN TÔI LÀ AI? Hãy cùng thử tài kiến thức bóng đá của bạn.",
  "Một đất nước. Hai tượng đài. 🐐 Lionel Messi vs Diego Maradona.",
];
const EN = [
  "Two England legends. Two incredible careers. One big question.",
  "🐐 Age is just a number when you're Cristiano Ronaldo. From the Saudi Pro League to the FIFA World Cup.",
  /* the accent trap — this must not read as Vietnamese */
  "Two icons. One generation. One impossible choice. Andrés Iniesta delivered football's most unforgettable goal for Spain.",
  "🕵️‍♂️ WHO AM I? Here's your football challenge for the day.",
];

console.log("── language of a caption");
for (const t of VI) {
  const d = M.detectLang(t);
  ok(d.lang === "vi", `vi: "${t.slice(0, 44)}…"`, d.lang || "(none)");
}
for (const t of EN) {
  const d = M.detectLang(t);
  ok(d.lang === "en", `en: "${t.slice(0, 44)}…"`, d.lang || "(none)");
}
ok(M.detectLang("ผลบอลวันนี้ ดูสดฟรี").lang === "th", "th: Thai script");
ok(M.detectLang("今天的足球比赛结果").lang === "zh", "zh: Chinese characters");
ok(M.detectLang("🔥🐐⚽️ #football #reels").lang === "", "no language from emoji and hashtags alone");
ok(M.detectLang("https://sfc.my/r/TYQDDcDN").lang === "", "a bare link carries no language");
/* hashtags are usually English even on a Vietnamese post, so they must not tip the balance */
ok(M.detectLang("Một cuộc tranh luận #football #match #the #and").lang === "vi",
  "English hashtags do not override Vietnamese body text");

/* ═══════════════════ reconcile ═══════════════════ */
const CHANNELS = [
  { id: "ytv", platform: "youtube",  name: "YouTube · vn",  lang: "vi" },
  { id: "tgv", platform: "telegram", name: "Telegram · vn", lang: "vi" },
  { id: "yte", platform: "youtube",  name: "YouTube · en",  lang: "en" },
  { id: "fbv", platform: "facebook", name: "Facebook · vn", lang: "vi" },
];
const OPT = { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 };

/* minutes ago, so every case sits inside the window without depending on the wall clock */
const ago = mins => new Date(Date.now() - mins * 60e3).toISOString();
const P = (id, mins, text) => ({ externalId: id, ts: ago(mins), kind: "video", text: text || "Two legends. One question." });
const VN_TEXT = "Hai huyền thoại. Một cuộc tranh luận.";

function run(setup) {
  const c = M.checks();
  c.posts = {}; c.counts = {}; c.meta = {};
  Object.assign(c, { tz: 7, win: 15, hours: 24, maxPer: 4 });
  setup(c);
  return M.reconcile(CHANNELS, OPT);
}
const row = (rep, id) => rep.rows.find(r => r.id === id);
const statusOf = rep => rep.rows.map(r => `${r.id}:${r.status}`).join(" ");

console.log("\n── counts and targets");

let rep = run(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT), P("b", 300, VN_TEXT)],
              tgv: [P("c", 61, VN_TEXT), P("d", 301, VN_TEXT)],
              yte: [P("e", 62), P("f", 302)] };
});
ok(rep.expected === 2 && rep.alerts.length === 0,
  "three channels, two drops each, no problems", `expected=${rep.expected} alerts=${rep.alerts.length}`);
ok(rep.slots.length === 2, "two drops detected", `${rep.slots.length}`);

rep = run(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT), P("b", 300, VN_TEXT)],
              tgv: [P("c", 301, VN_TEXT)],
              yte: [P("e", 62), P("f", 302)] };
});
ok(row(rep, "tgv").status === "short" && row(rep, "tgv").missedAt.length === 1,
  "a channel that missed one drop reads short and names the slot");
ok(rep.alerts.some(a => a.kind === "missing" && a.id === "tgv"), "the miss raises an alert");
/* Sources reach back different distances — Telegram hands over about twenty posts, Facebook's
   page embeds a handful. When a channel's oldest known post is itself inside the window, the
   window was never covered end to end, and a short count there could be a gap or could be
   something never looked at. The alert still fires; the caveat rides along so the reader knows. */
ok(rep.alerts.some(a => a.id === "tgv" && a.partial === true && /never seen/.test(a.text)),
  "a short count on partial coverage says so, without being downgraded",
  (rep.alerts.find(a => a.id === "tgv") || {}).text);
ok(row(rep, "tgv").cells.filter(x => x.state === "miss").length === 1,
  "its matrix row shows exactly one miss cell");

rep = run(c => { c.counts[require_date()] = { fbv: { n: 6, source: "suggested" } }; });
ok(rep.expected === null && row(rep, "fbv").status === "notarget",
  "a suggested count alone sets no target", `expected=${JSON.stringify(rep.expected)}`);

rep = run(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT), P("b", 300, VN_TEXT)] };
  c.counts[require_date()] = { fbv: { n: 6, source: "suggested" } };
});
ok(rep.expected === 2, "a suggestion cannot inflate a measured target", `expected=${rep.expected}`);

rep = run(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT)] };
  c.counts[require_date()] = { fbv: { n: 3, source: "manual" } };
});
ok(rep.expected === 3 && row(rep, "ytv").status === "short",
  "a hand-entered count is evidence and does set the target", `expected=${rep.expected}`);

/* ── one post, two readers ──────────────────────────────────────────────────
   The bug that shipped: the server API and the extension both read Instagram, keyed the same reel
   by a numeric id and by its shortcode, and mergePosts (de-duping by id) kept both. The channel
   counted 4 for a day it posted 2 — inflating the expected target so every OTHER channel read as
   "2 missing" on a day nothing was missing. The count must survive the same post arriving twice. */
console.log("\n── the same post from two readers counts once");
const dup = (id, mins, text) => ({ externalId: id, ts: ago(mins), kind: "reel", text, permalink: "" });
rep = run(c => {
  c.posts = { ytv: [
    dup("111", 60,  "Osasuna sẽ tận dụng lợi thế sân nhà tối nay"),
    dup("ABC", 60,  "Osasuna sẽ tận dụng lợi thế sân nhà tối nay"),   // same content, extension's id
    dup("222", 300, "GOAT vẫn chưa có hồi kết cuộc tranh luận"),
    dup("DEF", 300, "GOAT vẫn chưa có hồi kết cuộc tranh luận"),
  ] };
});
ok(row(rep, "ytv").count === 2, "four rows, two pieces of content → count 2", `count=${row(rep, "ytv").count}`);
ok(!rep.alerts.some(a => a.kind === "over"), "and no false over-count alert");

/* it must collapse only true duplicates — same words at the same minute — never distinct posts */
rep = run(c => {
  c.posts = { ytv: [
    dup("a", 60, "Match preview: who takes tonight's derby"),
    dup("b", 60, "Totally separate announcement about ticket sales"),
  ] };
});
ok(row(rep, "ytv").count === 2, "two different captions in the same minute are NOT merged", `count=${row(rep, "ytv").count}`);

/* and when there is too little text to be sure, ids are trusted rather than merged blindly */
rep = run(c => {
  c.posts = { ytv: [dup("a", 60, "🔥⚽️"), dup("b", 60, "🔥⚽️")] };
});
ok(row(rep, "ytv").count === 2, "two emoji-only posts keep their own ids, not merged on empty text", `count=${row(rep, "ytv").count}`);

/* ── a channel we could not read this run ────────────────────────────────────
   The false-alarm that shipped: Apify's free credits ran out, so Facebook/Instagram/TikTok could
   not be read; a stale snapshot (only the day's first post) was served as if current, and every
   later drop was crossed off as "missing" — when the posts had actually gone out. A channel whose
   latest collect FAILED (meta.ok === false) must have its stale posts ignored and read "unknown",
   never a cross. */
console.log("\n── a channel we could not read reads unknown, never a false miss");
rep = run(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT), P("b", 300, VN_TEXT)],   // two real drops, seen on ytv
              tgv: [P("c", 61, VN_TEXT)] };                        // tgv has only a stale first post…
  c.meta = { tgv: { ok: false, note: "Apify limit exceeded — could not read" } };  // …because its read FAILED
});
ok(row(rep, "tgv").status === "unknown", "a read-failed channel reads unknown, not short/missing", row(rep, "tgv").status);
ok(!rep.alerts.some(a => a.kind === "missing" && a.id === "tgv"), "and raises no missing alert for it");
ok(row(rep, "tgv").cells.every(x => x.state !== "miss"), "none of its cells is a cross",
  row(rep, "tgv").cells.map(x => x.state).join(","));
ok(rep.expected === 2, "the read-failed channel does not distort the expected count", `expected=${rep.expected}`);

console.log("\n── alerts");

rep = run(c => {
  c.posts = { ytv: Array.from({ length: 6 }, (_, i) => P("x" + i, 30 + i * 40, VN_TEXT)) };
});
ok(rep.alerts.some(a => a.kind === "over" && a.id === "ytv"),
  "more than the per-period maximum raises an over alert");

/* the whole reason captions are read: right count, right channel, wrong language */
rep = run(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT), P("b", 300, VN_TEXT)],
              yte: [P("e", 62, VN_TEXT), P("f", 302)] };
});
ok(rep.alerts.some(a => a.kind === "lang" && a.id === "yte"),
  "a Vietnamese caption on an English channel raises a language alert");
ok(row(rep, "yte").cells.some(x => x.state === "lang"),
  "and the matrix marks that cell, not the whole row");
ok(row(rep, "yte").status === "ok",
  "the count still reads ok — the post did go out, in the wrong language");

rep = run(c => { c.meta = { tgv: { dead: true } }; c.posts = { ytv: [P("a", 60, VN_TEXT)] }; });
ok(rep.alerts.some(a => a.kind === "dead"), "a dead channel link raises an alert");

console.log("\n── window");

rep = run(c => {
  c.posts = { ytv: [P("in", 60, VN_TEXT), P("out", 60 * 40, VN_TEXT)] };
});
ok(row(rep, "ytv").count === 1, "a post older than the window is excluded", `count=${row(rep, "ytv").count}`);

rep = run(c => { c.posts = { ytv: [P("a", 60, VN_TEXT)] }; });
ok(statusOf(rep).includes("tgv:unknown") && statusOf(rep).includes("fbv:unknown"),
  "channels with no data read unknown, never short", statusOf(rep));

/* ── calendar days ────────────────────────────────────────────────────────
   "How many went out today" cannot be answered from a rolling 24 h, which at midday straddles
   two dates. A day runs from midnight in the chosen zone and never past now. */
console.log("\n── calendar day windows");

const todayIn7 = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const yesterdayIn7 = new Date(Date.now() + 7 * 3600e3 - 86400e3).toISOString().slice(0, 10);

let dayRep = run(c => { c.posts = { ytv: [P("a", 30, VN_TEXT)] }; });
const dayOnly = M.reconcile(CHANNELS, { tz: 7, win: 15, mode: "day", date: todayIn7, maxPerPeriod: 4 });
ok(dayOnly.from === new Date(Date.parse(todayIn7 + "T00:00:00Z") - 7 * 3600e3).toISOString(),
  "a day starts at midnight in the chosen zone", dayOnly.from);
ok(new Date(dayOnly.to).getTime() <= Date.now() + 1000,
  "a day never runs past now", dayOnly.to);

/* One post on each of the two days, so each window picks up exactly its own.
   Anchored on the calendar, not on "N hours ago". "30 hours ago" only lands on yesterday when the
   suite is run after 06:00 in the chosen zone — run it at 02:00 and the same post is two days old
   and the assertion fails, which made this a coin toss decided by the clock rather than by the
   code. Noon of yesterday is unambiguous at every hour, and a post stamped exactly now is always
   inside today and never ahead of the window's end. */
const noonOf = d => new Date(Date.parse(d + "T12:00:00Z") - 7 * 3600e3).toISOString();
const c2 = M.checks();
c2.posts = { ytv: [
  { externalId: "recent", ts: new Date().toISOString(), kind: "video", text: VN_TEXT },
  { externalId: "old", ts: noonOf(yesterdayIn7), kind: "video", text: VN_TEXT },
] };
c2.counts = {}; c2.meta = {}; c2.captions = {};
const t2 = M.reconcile(CHANNELS, { tz: 7, win: 15, mode: "day", date: todayIn7, maxPerPeriod: 4 });
ok(row(t2, "ytv").count === 1, "only that day's posts are counted", `count=${row(t2, "ytv").count}`);
const y2 = M.reconcile(CHANNELS, { tz: 7, win: 15, mode: "day", date: yesterdayIn7, maxPerPeriod: 4 });
ok(row(y2, "ytv").count === 1, "yesterday picks up the older one", `count=${row(y2, "ytv").count}`);

/* ── matching on content instead of time ──────────────────────────────────
   Facebook cannot be matched on time: its HTML reaches back only a handful of posts, so a drop it
   did receive looked missing purely because the window was never fully read. What it does give is
   the words, and it clips them with its own "see more" — which is why the score is containment of
   character trigrams rather than Jaccard.

   The captions below are the real ones from the live channels. */
console.log("\n── matching on what the post said");

const VN_A = "Hai huyền thoại. Một đế chế. Một cuộc tranh luận chưa có hồi kết. Andrés Iniesta tạo nên khoảnh khắc bất tử";
const EN_A = "Two icons. One generation. One impossible choice. Andrés Iniesta delivered football's most unforgettable goal";
const VN_B = "🕵️ĐOÁN TÔI LÀ AI? Hãy cùng thử tài kiến thức bóng đá của bạn. Từng thi đấu cùng Lionel Messi";
const EN_B = "🕵️ WHO AM I? Here's your football challenge for today. I've played alongside Lionel Messi";
const clip = (s, n) => s.slice(0, n) + "… See more";

/* the metric, before the machinery that uses it */
ok(M.contentScore(VN_A, VN_A) === 1, "identical captions score 1");
ok(M.contentScore(VN_A, clip(VN_A, 60)) > 0.8,
  "a caption Facebook truncated still matches", M.contentScore(VN_A, clip(VN_A, 60)).toFixed(2));
ok(M.contentScore(VN_A, "https://sfc.my/r/abc " + VN_A) === 1,
  "a link prefix is ignored");
ok(M.contentScore(VN_A, VN_B) < 0.4,
  "two different posts in the same language do not match", M.contentScore(VN_A, VN_B).toFixed(2));
/* the two language variants of one drop are different text and must never match each other, or
   the language check would have nothing to say */
ok(M.contentScore(VN_A, EN_A) < 0.4,
  "the two language variants of a drop do not match each other", M.contentScore(VN_A, EN_A).toFixed(2));
ok(M.contentScore("🔥🐐", "🔥🐐") === 0, "too little text scores nothing");

const CC = [
  { id: "ytv", platform: "youtube",  name: "YT vn", lang: "vi" },
  { id: "yte", platform: "youtube",  name: "YT en", lang: "en" },
  { id: "fbv", platform: "facebook", name: "FB vn", lang: "vi" },
  { id: "fbe", platform: "facebook", name: "FB en", lang: "en" },
];

function contentRun(captions) {
  const c = M.checks();
  Object.assign(c, { tz: 7, win: 15, hours: 24, maxPer: 4 });
  c.counts = {}; c.meta = {}; c.captions = captions;
  c.posts = {
    ytv: [P("a", 60, VN_A), P("b", 300, VN_B)],
    yte: [P("c", 61, EN_A), P("d", 301, EN_B)],
  };
  return M.reconcile(CC, { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 });
}
const crow = (rep, id) => rep.rows.find(r => r.id === id);

let cr = contentRun({ fbv: [clip(VN_A, 60), clip(VN_B, 55)], fbe: [clip(EN_A, 58), clip(EN_B, 50)] });
ok(crow(cr, "fbv").mode === "content" && crow(cr, "fbv").count === 2,
  "captions alone account for both drops", `${crow(cr, "fbv").mode} ${crow(cr, "fbv").count}/2`);
ok(crow(cr, "fbv").cells.every(x => x.state === "okc"),
  "and they are marked as content matches, not timed ones",
  crow(cr, "fbv").cells.map(x => x.state).join(","));
ok(cr.alerts.length === 0, "so nothing is reported missing",
  cr.alerts.map(a => a.name + ": " + a.text).join(" | "));

/* ── a ✓ that is not word-perfect must say so ──────────────────────────────
   The failure this guards against actually shipped. A caption is credited with a drop once 60% of
   the drop's words appear in it, and below that bar the report was loud — but between 60% and 100%
   it printed a clean tick and said nothing. So a Facebook post that never went out on sportsfc.vn
   came back "delivered", while the same day's fans channel was caught by luck: its wording drifted
   far enough to fall under the threshold.

   The threshold still decides. Moving it would only trade silent false ticks for silent false
   misses. What must never happen again is the SILENCE: one unmatched word has to raise an alert
   that names the words and asks for a human to look. */
{
  /* a caption that says the same thing but not in the same words — comfortably over the bar, so
     the old code called it delivered and moved on */
  const NEARLY = VN_A.replace("bất tử", "để đời").replace("chưa có hồi kết", "không dứt");
  let vr = contentRun({ fbv: [NEARLY, clip(VN_B, 55)], fbe: [clip(EN_A, 58), clip(EN_B, 50)] });
  const cell = crow(vr, "fbv").cells.find(x => x.match && x.match.missing && x.match.missing.length);
  ok(cell && cell.state === "miss",
    "a caption missing even a few words is CROSSED, never ticked",
    JSON.stringify(crow(vr, "fbv").cells.map(x => [x.state, x.match && x.match.matched + "/" + x.match.total])));
  ok(crow(vr, "fbv").count === 1 && crow(vr, "fbv").status === "short",
    "so the channel is short a post rather than reading complete",
    `${crow(vr, "fbv").count}/2 ${crow(vr, "fbv").status}`);

  const v = vr.alerts.filter(a => a.kind === "verify" && a.id === "fbv");
  ok(v.length === 1, "a near-miss raises exactly one verify alert",
    vr.alerts.map(a => a.kind).join(","));
  ok(/CROSSED/.test(v[0].text) && /\d+ of \d+ words match/.test(v[0].text),
    "which says it was crossed and how many words matched", v[0].text);
  ok(/do NOT/i.test(v[0].text) && cell.match.missing.every(w => v[0].text.indexOf(w) !== -1),
    "and names every word that did not match", v[0].text);
  ok(/check by hand/i.test(v[0].text),
    "and asks for a human, since a near-miss may be the same post reworded");
  ok(vr.alerts[0].kind === "verify",
    "it sorts above every other alert", vr.alerts.map(a => a.kind).join(","));

  /* a distant miss is an ordinary miss — the verify alert is for the close ones, or it stops
     meaning "look at this specifically" */
  const far = contentRun({ fbv: [clip(VN_A, 60), EN_B], fbe: [clip(EN_A, 58), clip(EN_B, 50)] });
  ok(far.alerts.filter(a => a.kind === "verify" && a.id === "fbv").length === 0,
    "an unrelated caption is just a miss, not a near-miss worth flagging",
    far.alerts.filter(a => a.id === "fbv").map(a => a.kind).join(","));

  /* the other half of the contract: a word-perfect match must stay silent, or the alert becomes
     noise and gets ignored — which would be worse than the bug it replaces */
  const clean2 = contentRun({ fbv: [VN_A, VN_B], fbe: [EN_A, EN_B] });
  ok(clean2.alerts.filter(a => a.kind === "verify").length === 0,
    "a word-perfect match raises nothing",
    clean2.alerts.map(a => a.kind + ":" + a.text).join(" | "));

  /* Facebook's own "see more" is chrome on a button, not words anybody wrote. capWords used to
     leave it in while normText stripped it, so every truncated caption carried two words the drop
     could not contain — which would have fired this alert on essentially every long post. */
  ok(M.capWords("Xin chào các bạn… See more").indexOf("see") === -1 &&
     M.capWords("Hello everyone... see more").indexOf("more") === -1,
    "a truncation marker is not counted as an unmatched word",
    JSON.stringify(M.capWords("Hello everyone... see more")));
  const clipped = contentRun({ fbv: [clip(VN_A, 60), clip(VN_B, 55)], fbe: [clip(EN_A, 58), clip(EN_B, 50)] });
  ok(clipped.alerts.filter(a => a.kind === "verify").length === 0,
    "so a caption Facebook truncated is still a clean match",
    clipped.alerts.map(a => a.text).join(" | "));
}

/* one caption absent must still read as a gap — the whole point is catching that */
cr = contentRun({ fbv: [clip(VN_A, 60)], fbe: [clip(EN_A, 58), clip(EN_B, 50)] });
ok(crow(cr, "fbv").count === 1 && crow(cr, "fbv").status === "short",
  "a drop whose content is absent is still a gap", `${crow(cr, "fbv").count}/2`);
ok(crow(cr, "fbv").cells.some(x => x.state === "miss" && x.score < 0.4),
  "and the miss records how poor the best match was",
  JSON.stringify(crow(cr, "fbv").cells.map(x => [x.state, +(x.score || 0).toFixed(2)])));

/* the wrong language variant on a channel must not pass as a match */
cr = contentRun({ fbv: [clip(EN_A, 58), clip(EN_B, 50)], fbe: [clip(EN_A, 58), clip(EN_B, 50)] });
ok(crow(cr, "fbv").count === 0,
  "English captions do not satisfy a Vietnamese channel", `${crow(cr, "fbv").count}/2`);
ok(cr.alerts.some(a => a.kind === "lang" && a.id === "fbv"),
  "and that raises a language alert");

/* Captions carry the banner and whatever else the post gave up, so the report can show what
   matched rather than a bare timestamp. Older runs stored plain strings; both shapes must work. */
cr = contentRun({
  fbv: [{ text: clip(VN_A, 60), thumb: "https://fb/banner1.jpg", permalink: "https://fb/p/1",
          timeLabel: "23h", reactions: "12", comments: "3" },
        { text: clip(VN_B, 55), thumb: "https://fb/banner2.jpg" }],
  fbe: [clip(EN_A, 58)],                       // the old shape, still accepted
});
ok(crow(cr, "fbv").count === 2, "caption objects match the same as plain text",
  `${crow(cr, "fbv").count}/2`);
ok(crow(cr, "fbe").count === 1, "a plain string caption still matches", `${crow(cr, "fbe").count}/2`);
{
  /* the drop matched by the fully-populated caption, not whichever comes first */
  const cell = crow(cr, "fbv").cells.find(x => x.state === "okc" && x.post &&
    x.post.thumb === "https://fb/banner1.jpg");
  ok(cell && cell.post.permalink === "https://fb/p/1",
    "the matched cell carries the banner and the link through to the report",
    JSON.stringify(cell && { thumb: cell.post.thumb, link: cell.post.permalink }));
  ok(cell && cell.post.reactions === "12" && cell.post.timeLabel === "23h",
    "and the counts Facebook printed, in the form it printed them",
    JSON.stringify(cell && { r: cell.post.reactions, t: cell.post.timeLabel }));
  /* every matched cell keeps at least its banner, which is the point of showing them */
  ok(crow(cr, "fbv").cells.filter(x => x.state === "okc").every(x => x.post.thumb),
    "every matched drop keeps its banner");
}

/* A drop's present/missing lists are built from timestamps, so a content-matched channel appeared
   in neither: the matrix said Facebook got both drops while the drop itself reported four channels
   out of six. Both could not be true. */
cr = contentRun({ fbv: [clip(VN_A, 60), clip(VN_B, 55)], fbe: [clip(EN_A, 58)] });
{
  const late = cr.slots[cr.slots.length - 1];      // the drop every channel received
  ok(late.present.indexOf("fbv") !== -1 && late.present.indexOf("fbe") !== -1,
    "a drop counts the channels confirmed by caption", `present=${late.present.join(",")}`);
  ok((late.byContent || []).length === 2,
    "and keeps them separate, so it can still say which were confirmed by caption not by time",
    JSON.stringify(late.byContent));
  const early = cr.slots[0];                       // fbe has no caption for this one
  ok(early.missing.indexOf("fbe") !== -1,
    "a content channel that did not match is listed as missing on that drop",
    `missing=${early.missing.join(",")}`);
  ok(early.present.indexOf("fbv") !== -1 && early.missing.indexOf("fbv") === -1,
    "and one that did match is not");
}

/* One caption accounts for at most one drop. Scoring each drop independently let a single caption
   satisfy two of them whenever a day's posts were worded alike — the channel would read 2/2 having
   posted once, and a genuine miss would pass unnoticed. That matters for a daily check, where
   tomorrow's two posts may well be near-identical. */
{
  const c = M.checks();
  Object.assign(c, { tz: 7, win: 15, hours: 24, maxPer: 4 });
  c.counts = {}; c.meta = {};
  /* two drops whose captions are nearly the same sentence */
  const NEAR_A = "Messi hay Ronaldo? Cuộc tranh luận vĩ đại nhất của bóng đá hiện đại vẫn chưa kết thúc";
  const NEAR_B = "Messi hay Ronaldo? Cuộc tranh luận vĩ đại nhất của bóng đá hiện đại vẫn chưa dứt";
  c.posts = { ytv: [P("a", 60, NEAR_A), P("b", 300, NEAR_B)] };
  c.captions = { fbv: [NEAR_A] };                 // Facebook posted only the first
  const rep = M.reconcile(CC, { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 });
  const r = rep.rows.find(x => x.id === "fbv");
  ok(M.contentScore(NEAR_A, NEAR_B) >= 0.6,
    "the two captions really are similar enough to be confused",
    M.contentScore(NEAR_A, NEAR_B).toFixed(2));
  ok(r.count === 1, "one caption cannot account for two similar drops", `${r.count}/2`);
  ok(r.cells.filter(x => x.state === "okc").length === 1 &&
     r.cells.filter(x => x.state === "miss").length === 1,
    "so the drop it did not cover still reads as a miss",
    r.cells.map(x => x.state).join(","));
}

/* a content-matched channel must not be able to set the target: it can only ever confirm drops
   another channel already established, so letting it would make the target circular */
cr = contentRun({ fbv: [clip(VN_A, 60), clip(VN_B, 55), "Một bài viết thứ ba hoàn toàn khác về bóng đá"], fbe: [] });
ok(cr.expected === 2, "content matches never raise the target", `expected=${cr.expected}`);

/* The false alarm that prompted all of this. Facebook had real timestamps and no captions, was
   matched on time, and reported a drop missing that was sitting on the page. Its timestamps are
   honest about the posts it hands over but say nothing about the ones it does not, so they can
   prove presence and never absence. With no captions the answer has to be "unknown". */
(() => {
  const c = M.checks();
  Object.assign(c, { tz: 7, win: 15, hours: 24, maxPer: 4 });
  c.counts = {}; c.meta = {}; c.captions = {};
  c.posts = {
    ytv: [P("a", 60, VN_A), P("b", 300, VN_B)],
    yte: [P("c", 61, EN_A), P("d", 301, EN_B)],
    /* one Facebook post carrying a real timestamp but genuinely no caption (built directly, since
       the P() helper substitutes a default caption for an empty one) */
    fbv: [{ externalId: "f", ts: ago(62), kind: "video", text: "" }],
  };
  const rep = M.reconcile(CC, { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 });
  const r = rep.rows.find(x => x.id === "fbv");
  ok(r.mode === "none" && r.status === "unknown",
    "Facebook with timestamps but no captions reads unknown, not short", `${r.mode}/${r.status}`);
  ok(!rep.alerts.some(a => a.id === "fbv"),
    "and raises no missing-post alarm",
    rep.alerts.filter(a => a.id === "fbv").map(a => a.text).join(" | "));
  ok(r.cells.every(x => x.state === "none"),
    "its cells stay blank rather than showing a cross",
    r.cells.map(x => x.state).join(","));
})();

/* The server-side reader (Apify) returns whole Facebook posts — timestamp AND caption — into
   checks.posts, with nothing in checks.captions. Those captions must feed the content match exactly
   as the extension's did, so Facebook reports itself from the server read alone, no extension. */
(() => {
  const c = M.checks();
  Object.assign(c, { tz: 7, win: 15, hours: 24, maxPer: 4 });
  c.counts = {}; c.meta = {}; c.captions = {};
  c.posts = {
    ytv: [P("a", 60, VN_A), P("b", 300, VN_B)],
    yte: [P("c", 61, EN_A), P("d", 301, EN_B)],
    /* both drops, as real posts (the shape Apify hands back), no checks.captions entry at all */
    fbv: [{ externalId: "s1", ts: ago(60), kind: "video", text: clip(VN_A, 60), permalink: "https://fb/p/1", thumb: "https://fb/b1.jpg" },
          { externalId: "s2", ts: ago(300), kind: "video", text: clip(VN_B, 55), permalink: "https://fb/p/2" }],
  };
  const rep = M.reconcile(CC, { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 });
  const r = rep.rows.find(x => x.id === "fbv");
  ok(r.mode === "content" && r.count === 2,
    "Facebook read server-side matches both drops from its posts' own captions", `${r.mode} ${r.count}/2`);
  ok(r.cells.every(x => x.state === "okc"),
    "and they show as content matches", r.cells.map(x => x.state).join(","));
  ok(!rep.alerts.some(a => a.id === "fbv"), "nothing reported missing for it");
  const cell = r.cells.find(x => x.post && x.post.permalink === "https://fb/p/1");
  ok(cell && cell.post.thumb === "https://fb/b1.jpg",
    "the matched cell carries the post's banner and link through", JSON.stringify(cell && cell.post.permalink));
})();

/* ── the fixture DATE separates two identical-template posts ─────────────────
   The real bug: SportsFC's captions are templated, so yesterday's "EFL Cup … 27 August" post and
   today's "EFL Cup … 28 August" post share ~70% of their words. A Facebook page whose scraped
   captions still held YESTERDAY's post was falsely credited for TODAY's drop. The date named in the
   caption is what tells them apart, and a caption-match must respect it. */
(() => {
  const today = "NHẬN ĐỊNH EFL CUP LALIGA SPORTSFC FANS EFL Cup 26/27 📅 28 August 2026 1:30 ICT Xem ngay dự đoán Cole Palmer Enzo Fernandez Joao Pedro";
  const yday  = "Góc nhìn về EFL Cup SPORTSFC FANS EFL Cup 26/27 📅 27 August 2026 1:45 ICT Xem ngay dự đoán Cole Palmer Enzo Fernandez Joao Pedro";
  const run = fbCaps => {
    const c = M.checks();
    Object.assign(c, { tz: 7, win: 15, hours: 24, maxPer: 4 });
    c.counts = {}; c.meta = {}; c.captions = { fbv: fbCaps };
    c.posts = { ytv: [P("a", 60, today)] };            // the drop: today's EFL post
    return M.reconcile(CC, { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 });
  };
  /* first, prove the two captions really are ~identical on words alone (so only the date can split them) */
  ok(M.contentScore(today, yday) >= 0.6, "the two days' EFL captions score as a match on words alone",
    M.contentScore(today, yday).toFixed(2));
  /* Facebook holding ONLY yesterday's caption must NOT be credited for today's drop */
  let cr = run([yday]);
  ok(crow(cr, "fbv").count === 0 && crow(cr, "fbv").cells[0].state === "miss",
    "yesterday's identical-template caption does NOT match today's drop (different date)",
    `${crow(cr, "fbv").count} ${crow(cr, "fbv").cells[0].state}`);
  ok(cr.alerts.some(a => a.id === "fbv" && a.kind === "missing"), "and the miss is reported");
  /* the SAME post (today's date) does match */
  cr = run([today]);
  ok(crow(cr, "fbv").count === 1 && crow(cr, "fbv").cells[0].state === "okc",
    "the same-day caption matches", `${crow(cr, "fbv").count} ${crow(cr, "fbv").cells[0].state}`);
})();

/* ── X as a timeline channel ────────────────────────────────────────────────
   X hands over a real per-post timestamp for everything it renders, so — unlike Facebook — it is
   matched drop by drop, on time, the same as YouTube and Telegram. That distinction is the whole
   contract: a timeline channel's silence on a drop is a miss; a content channel's silence is only
   ever unknown. Its own channel list, for the same reason the content section above has one —
   adding a row to CHANNELS or CC would move `expected` and every slot's present/missing list
   under every case already checked against those fixtures. */
console.log("\n── X as a timeline channel");

const XC = [
  { id: "ytv", platform: "youtube", name: "YouTube · vn", lang: "vi" },
  { id: "xvn", platform: "x",       name: "X · vn",       lang: "vi" },
  { id: "xen", platform: "x",       name: "X · en",       lang: "en" },
];

function xRun(setup) {
  const c = M.checks();
  c.posts = {}; c.counts = {}; c.meta = {}; c.captions = {};
  Object.assign(c, { tz: 7, win: 15, hours: 24, maxPer: 4 });
  setup(c);
  return M.reconcile(XC, { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 });
}
const xrow = (rep, id) => rep.rows.find(r => r.id === id);

let xr = xRun(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT), P("b", 300, VN_TEXT)],
              xvn: [P("x1", 61, VN_TEXT), P("x2", 301, VN_TEXT)],
              xen: [P("x3", 62), P("x4", 302)] };
});
ok(xrow(xr, "xvn").mode === "timeline",
  "X with timestamps is matched on time, not on words", xrow(xr, "xvn").mode);
ok(xrow(xr, "xvn").cells.every(x => x.state === "ok"),
  "so its cells are timed matches, never the ≈ of a content match",
  xrow(xr, "xvn").cells.map(x => x.state).join(","));
ok(xr.expected === 2 && xr.alerts.length === 0,
  "three channels, two drops each, no problems", `expected=${xr.expected} alerts=${xr.alerts.length}`);
ok((xr.slots[0].byContent || []).length === 0,
  "and it never lands among the caption-confirmed channels",
  JSON.stringify(xr.slots[0].byContent || []));

/* a timeline channel is evidence: it can reveal a drop, not merely confirm one */
xr = xRun(c => { c.posts = { xvn: [P("x1", 61, VN_TEXT), P("x2", 301, VN_TEXT)] }; });
ok(xr.expected === 2, "X alone can set the day's target", `expected=${xr.expected}`);
ok(xr.slots.length === 2, "its posts cluster into drops like any other", `${xr.slots.length}`);

/* the point of being a timeline channel: silence on a drop is a miss, not a shrug */
xr = xRun(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT), P("b", 300, VN_TEXT)],
              xvn: [P("x2", 301, VN_TEXT)] };
});
ok(xrow(xr, "xvn").status === "short" && xrow(xr, "xvn").missedAt.length === 1,
  "a drop X did not receive reads short and names the slot",
  `${xrow(xr, "xvn").status} missedAt=${xrow(xr, "xvn").missedAt.join(",")}`);
ok(xr.alerts.some(a => a.kind === "missing" && a.id === "xvn"), "the miss raises an alert");
ok(xr.slots[1].missing.indexOf("xvn") !== -1,
  "and the drop itself lists X among the channels it did not reach",
  `missing=${xr.slots[1].missing.join(",")}`);
ok(xrow(xr, "xvn").cells.filter(x => x.state === "miss").length === 1,
  "its matrix row shows exactly one miss cell",
  xrow(xr, "xvn").cells.map(x => x.state).join(","));

/* the mistake a count can never catch, on X as everywhere else */
xr = xRun(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT), P("b", 300, VN_TEXT)],
              xen: [P("x3", 62, VN_TEXT), P("x4", 302)] };
});
ok(xr.alerts.some(a => a.kind === "lang" && a.id === "xen"),
  "a Vietnamese post on the English X account raises a language alert");
ok(xrow(xr, "xen").cells.some(x => x.state === "lang"),
  "and the matrix marks that cell, not the whole row",
  xrow(xr, "xen").cells.map(x => x.state).join(","));
ok(xrow(xr, "xen").status === "ok",
  "the count still reads ok — the post did go out, in the wrong language");

/* an X account nobody collected is not an X account that posted nothing */
xr = xRun(c => { c.posts = { ytv: [P("a", 60, VN_TEXT)] }; });
ok(xrow(xr, "xvn").mode === "none" && xrow(xr, "xvn").status === "unknown",
  "an X account with no data reads unknown, never short",
  `${xrow(xr, "xvn").mode}/${xrow(xr, "xvn").status}`);

/* Captions must not drag X onto the Facebook path. That path exists because Facebook's coverage of
   a window cannot be trusted; X's can, and routing it through content matching would throw away
   the only channel-level evidence that can reveal a drop rather than confirm one. */
xr = xRun(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT), P("b", 300, VN_TEXT)] };
  c.captions = { xvn: [VN_TEXT] };
});
ok(xrow(xr, "xvn").mode === "none",
  "captions alone do not put X into content mode — that path is Facebook's",
  xrow(xr, "xvn").mode);

/* a hand-entered or suggested count still works for an X row that could not be collected */
xr = xRun(c => {
  c.posts = { ytv: [P("a", 60, VN_TEXT)] };
  c.counts[require_date()] = { xvn: { n: 3, source: "manual" } };
});
ok(xrow(xr, "xvn").mode === "count" && xr.expected === 3,
  "an uncollected X row still accepts a hand-entered count",
  `${xrow(xr, "xvn").mode} expected=${xr.expected}`);

/* over-posting is per channel and platform-blind */
xr = xRun(c => {
  c.posts = { xvn: Array.from({ length: 6 }, (_, i) => P("x" + i, 30 + i * 40, VN_TEXT)) };
});
ok(xr.alerts.some(a => a.kind === "over" && a.id === "xvn"),
  "more than the per-period maximum raises an over alert on X too");

/* ── one drop, arriving late ───────────────────────────────────────────────
   Clustering on time split a real day in two: the same clip went out on eight channels at 12:42
   and on X at 14:43. The report then showed five drops on a day four things were published, put a
   cross against X on the first and against eight channels on the second, and pushed a Facebook
   page to 5/4 because its captions answered both halves.

   The captions below are the real ones, verbatim, because the trap only shows up in real text:
   this account's posts are templated, so two entirely different fixtures score 0.79 against each
   other — above the 0.6 a caption match needs. Merging on that score alone would fold a whole day
   into a single drop. The identifying tokens are what actually separate them. */
console.log("\n── one drop, arriving late");

const ALAVES_TG = "https://sfc.my/r/c6DglRH5\n\nLiệu Alavés có thể giành chiến thắng? ⚔️\n📊 SPORTSFC.FANS\n🏆 LaLiga 26/27\n📅 16 August 2026\n🕢 00:30 AM ICT\n📍 Estadio de Mendizorroza\n🔮 Alaves có 51% cơ hội giành chiến thắng\n⚽ 42% khả năng cả hai đội cùng ghi bàn\n📈 53% khả năng trận đấu có dưới 2,5 bàn thắng\n👉 Xem ngay dự đoán và thống kê chi tiết tại sportsfc.fans. Nhấn vào link trên để biết thêm 👆\n#LaLiga #bongda #AlavesvsGetafe #Alaves #getafe";
const ALAVES_X  = "https://t.co/aL67cK0weo\n\nLiệu Alavés có thể giành chiến thắng? ⚔️\n🔮 Alaves - 51% cơ hội chiến thắng\n⚽ 42% khả năng cả hai đội ghi bàn\n📈 53% khả năng dưới 2,5 bàn thắng\n👉 https://t.co/ew1ProH9UD\n#LaLiga #bongda #AlavesvsGetafe";
const SEVILLA_TG = "https://sfc.my/r/chiRoXBO\n\nLiệu Sevilla có thể khẳng định sức mạnh trên sân nhà? ⚔️\n📊 SPORTSFC.FANS\n🏆 LaLiga 26/27\n📅 16 August 2026\n🕢 02:30 AM ICT \n📍 Ramon Sanchez Pizjuan\n🔮 Sevilla có 51% cơ hội giành chiến thắng\n⚽ 48% khả năng cả hai đội cùng ghi bàn\n📈 52% khả năng trận đấu có trên 2,5 bàn thắng\n👉 Xem ngay dự đoán và thống kê chi tiết tại sportsfc.fans.\n Nhấn vào link trên để biết thêm 👆\n#bongda #Laliga #SevillavsVallecano #rayovallecano #sevilla";

/* the measurement the whole design rests on */
ok(M.contentScore(ALAVES_TG, SEVILLA_TG) >= 0.6,
  "two different fixtures score above the caption threshold — trigrams alone cannot separate them",
  M.contentScore(ALAVES_TG, SEVILLA_TG).toFixed(3));
ok(M.sigScore(ALAVES_TG, ALAVES_X) >= 0.8,
  "the same fixture matches on its identifying tokens", M.sigScore(ALAVES_TG, ALAVES_X).toFixed(3));
ok(M.sigScore(ALAVES_TG, SEVILLA_TG) < 0.8,
  "two different fixtures do not", M.sigScore(ALAVES_TG, SEVILLA_TG).toFixed(3));

const at = (id, ch, mins, text) => ({ externalId:id, channelId:ch, ts:ago(mins), kind:"video", text });
const slotsOf = (...posts) => M.mergeLate(M.clusterSlots(posts, 15));

/* the real shape: everyone at 12:42, X two hours behind, on a channel the first slot never had */
let ms = slotsOf(at("a","tgv",300,ALAVES_TG), at("b","tgf",300,ALAVES_TG), at("x","xvn",180,ALAVES_X));
ok(ms.length === 1, "the same clip arriving two hours late is one drop, not two", `${ms.length} slot(s)`);
ok(ms[0].posts.length === 3, "and it carries every channel that ran it", `${ms[0].posts.length} post(s)`);

/* the failure the signature exists to prevent */
ms = slotsOf(at("a","tgv",300,ALAVES_TG), at("s","xvn",180,SEVILLA_TG));
ok(ms.length === 2, "two different fixtures stay two drops, however alike the template",
  `${ms.length} slot(s)`);

/* a channel cannot be late to a drop it already made — the same channel posting the same thing
   twice is a real double-post and must survive as one */
ms = slotsOf(at("a","tgv",300,ALAVES_TG), at("b","tgv",180,ALAVES_X));
ok(ms.length === 2, "the same channel posting twice is never merged away", `${ms.length} slot(s)`);

/* and end to end, through reconcile: late reads as late, never as missing */
const LC = [
  { id:"tgv", platform:"telegram", name:"Telegram · vn", lang:"vi" },
  { id:"xvn", platform:"x",        name:"X · vn",        lang:"vi" },
];
const lateRep = (() => {
  const c = M.checks();
  c.posts = { tgv:[at("a","tgv",300,ALAVES_TG)], xvn:[at("x","xvn",180,ALAVES_X)] };
  c.counts = {}; c.meta = {}; c.captions = {};
  Object.assign(c, { tz:7, win:15, maxPer:4 });
  return M.reconcile(LC, { tz:7, win:15, mode:"roll", hours:24, maxPerPeriod:4 });
})();
ok(lateRep.slots.length === 1, "one drop", `${lateRep.slots.length}`);
ok(lateRep.expected === 1 && lateRep.rows.every(r => r.status === "ok"),
  "and both channels read ok — nothing is missing",
  lateRep.rows.map(r => `${r.id}:${r.status}`).join(" "));
ok(!lateRep.alerts.some(a => a.kind === "missing"), "no missing-post alarm is raised");
ok(lateRep.alerts.some(a => a.kind === "late" && a.id === "xvn" && /2h/.test(a.text)),
  "the delay is reported as its own finding, with how far behind",
  (lateRep.alerts.find(a => a.kind === "late") || {}).text);
ok((lateRep.slots[0].late || []).length === 1,
  "and the drop records which channel was late", JSON.stringify(lateRep.slots[0].late));

/* Single-linkage lets one drop chain well past the window — nine channels three minutes apart
   span half an hour and are still one ordinary fan-out. Lateness is what a merge absorbed, never
   just distance from the drop's first post, or the slowest channel in a healthy day is accused. */
const fan = (() => {
  const c = M.checks();
  c.posts = {}; c.counts = {}; c.meta = {}; c.captions = {};
  Object.assign(c, { tz:7, win:15, maxPer:4 });
  c.posts = { tgv:[at("a","tgv",300,ALAVES_TG)], xvn:[at("b","xvn",288,ALAVES_TG)] };
  return M.reconcile(LC, { tz:7, win:15, mode:"roll", hours:24, maxPerPeriod:4 });
})();
ok(fan.slots.length === 1 && (fan.slots[0].late || []).length === 0,
  "a slow fan-out inside one cluster is not late",
  `${fan.slots.length} slot(s), late=${JSON.stringify(fan.slots[0].late)}`);
ok(!fan.alerts.some(a => a.kind === "late"), "and raises no late alert");

/* Lateness is not an X feature and must never become one. The case it exists for happens
   anywhere: a drop fails to go out on some channel, and the content team reposts it hours later.
   So every channel whose posts carry real timestamps is folded and flagged the same way. Facebook
   is the one exception and cannot be otherwise — it is matched on captions precisely because its
   timestamps cannot be trusted to cover a window, so it has no instant to be late against. */
console.log("\n── late belongs to every channel, not just X");

for(const plat of ["telegram", "youtube", "instagram", "x"]){
  const CH2 = [
    { id:"on1",  platform:"telegram", name:"on time · tg", lang:"vi" },
    { id:"on2",  platform:"youtube",  name:"on time · yt", lang:"vi" },
    { id:"slow", platform:plat,       name:"slow · " + plat, lang:"vi" },
  ];
  const r = (() => {
    const c = M.checks();
    c.posts = { on1:[at("a","on1",300,ALAVES_TG)], on2:[at("b","on2",299,ALAVES_TG)],
                slow:[at("c","slow",180,ALAVES_X)] };
    c.counts = {}; c.meta = {}; c.captions = {};
    Object.assign(c, { tz:7, win:15, maxPer:4 });
    return M.reconcile(CH2, { tz:7, win:15, mode:"roll", hours:24, maxPerPeriod:4 });
  })();
  const lateAlert = r.alerts.find(a => a.kind === "late");
  ok(r.slots.length === 1 && lateAlert && lateAlert.id === "slow" && /2h/.test(lateAlert.text),
    `a late ${plat} post is folded in and named late, with the gap`,
    `${r.slots.length} slot(s) — ${lateAlert ? lateAlert.text : "NO late alert"}`);
  ok(r.rows.find(x => x.id === "slow").status === "ok" &&
     !r.alerts.some(a => a.kind === "missing"),
    `  and ${plat} is not marked short or missing`,
    r.rows.map(x => `${x.id}:${x.status}`).join(" "));
  /* the matrix has to say it too, or only the drops tab knows */
  ok((r.rows.find(x => x.id === "slow").cells[0] || {}).lateBy === 120,
    `  and its matrix cell carries the delay`,
    String((r.rows.find(x => x.id === "slow").cells[0] || {}).lateBy));
}

/* the exact shape the content team hits: the drop failed on one channel and was reposted later,
   while a second channel never got it at all. One is late, the other is genuinely missing, and
   the report has to tell them apart rather than calling both the same thing. */
const mixed = (() => {
  const CH3 = [
    { id:"a", platform:"telegram",  name:"tg", lang:"vi" },
    { id:"b", platform:"youtube",   name:"yt", lang:"vi" },
    { id:"c", platform:"instagram", name:"ig", lang:"vi" },
  ];
  const cc = M.checks();
  cc.posts = { a:[at("1","a",300,ALAVES_TG)], b:[at("2","b",180,ALAVES_X)], c:[] };
  cc.counts = {}; cc.meta = {}; cc.captions = {};
  Object.assign(cc, { tz:7, win:15, maxPer:4 });
  return M.reconcile(CH3, { tz:7, win:15, mode:"roll", hours:24, maxPerPeriod:4 });
})();
ok(mixed.alerts.some(x => x.kind === "late" && x.id === "b"),
  "the channel that reposted hours later reads late");
ok(mixed.rows.find(x => x.id === "c").status === "unknown",
  "and the channel that never got it stays unknown, not late",
  mixed.rows.find(x => x.id === "c").status);

/* ── a content channel's clock must not define anyone else's drops ─────────
   Facebook hands over posts that carry a real instant but, whenever its payload cannot pair text
   to timestamps, no words at all. Such a post opened a drop of its own that nothing else could be
   part of, and every other channel took a cross for it — one Page's stray post inventing a drop
   and accusing eight healthy channels of missing it. Seen live: a day with a single post reported
   two drops, the second at 1/9.

   Facebook is matched on captions precisely because its timestamps cannot prove absence. The same
   reasoning forbids them from defining what everyone else is measured against. */
console.log("\n── a content channel's timestamps never invent a drop");

const PH = [
  { id: "tgv", platform: "telegram", name: "Telegram · vn", lang: "vi" },
  { id: "ytv", platform: "youtube",  name: "YouTube · vn",  lang: "vi" },
  { id: "fbv", platform: "facebook", name: "Facebook · vn", lang: "vi" },
];
const phantom = (() => {
  const c = M.checks();
  c.posts = { tgv: [P("t", 60, VN_TEXT)], ytv: [P("y", 60, VN_TEXT)],
              /* the textless, timestamped post — exactly what fbFetchPosts emits unpaired */
              fbv: [{ externalId: "fb-textless", ts: ago(5), kind: "post", text: "" }] };
  c.counts = {}; c.meta = {}; c.captions = { fbv: [{ text: VN_TEXT }] };
  Object.assign(c, { tz: 7, win: 15, maxPer: 4 });
  return M.reconcile(PH, { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 });
})();
ok(phantom.slots.length === 1,
  "a textless Facebook post does not open a drop of its own", `${phantom.slots.length} drop(s)`);
ok(phantom.rows.filter(r => r.mode === "timeline").every(r => r.cells.every(x => x.state === "ok")),
  "so no healthy channel takes a cross for it",
  phantom.rows.map(r => r.id + ":" + r.cells.map(x => x.state).join("/")).join(" "));
ok(!phantom.alerts.some(a => a.kind === "missing"), "and no missing alarm is raised");
ok(phantom.rows.find(r => r.id === "fbv").cells[0].state === "okc",
  "Facebook is still credited for the drop, by caption",
  phantom.rows.find(r => r.id === "fbv").cells[0].state);
/* the fold-back must still list it as present, or the drop under-reports its reach */
ok(phantom.slots[0].present.indexOf("fbv") !== -1,
  "and the drop still counts it among the channels it reached",
  phantom.slots[0].present.join(","));

/* ── the channel only a person can answer for ──────────────────────────────
   Viber has no public post list, no web client for the extension, and an encrypted desktop store.
   Every way of reading it is shut, so its cells are ticked by hand instead — against the drop they
   belong to, which is what makes this worth more than a number in a box: it says *which* content
   reached the channel. A tick is a person's word and stays marked as such, and it can never set
   the day's target, because it is answered against a drop that already exists and so is incapable
   of revealing one. */
console.log("\n── a channel answered by hand");

/* Facebook is the hand-confirm case now: when its extension has not run it has no captions to
   match on, so it falls to "answer by hand". (Viber used to sit here, but it is automatic now —
   fed by the phone pipeline — so it is never answered by hand; that is covered in its own block.) */
const HC = [
  { id: "tgv", platform: "telegram", name: "Telegram · vn", lang: "vi" },
  { id: "ytv", platform: "youtube",  name: "YouTube · vn",  lang: "vi" },
  { id: "fbv", platform: "facebook", name: "Facebook · vn", lang: "vi" },
];
/* built once and reused: P() stamps "N minutes before now", so rebuilding them per run would move
   every drop and the ticks — which are keyed on the drop's instant — would land on nothing */
const HAND_POSTS = { tgv: [P("t1", 300, VN_TEXT), P("t2", 60, VN_TEXT)],
                     ytv: [P("y1", 299, VN_TEXT), P("y2", 59, VN_TEXT)] };
const handRun = confirms => {
  const c = M.checks();
  c.posts = HAND_POSTS;
  c.counts = {}; c.meta = {}; c.captions = {}; c.confirms = confirms || {};
  Object.assign(c, { tz: 7, win: 15, maxPer: 4 });
  return M.reconcile(HC, { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 });
};

let hr = handRun();
const drops = hr.slots.map(s => s.at);
ok(hr.slots.length === 2, "two drops from the channels that can be read", `${hr.slots.length}`);
ok(hr.rows.find(r => r.id === "fbv").mode === "none",
  "an unread Facebook reads no-data, never missing", hr.rows.find(r => r.id === "fbv").mode);
ok(hr.rows.find(r => r.id === "fbv").cells.every(x => x.askable === true),
  "and every one of its cells offers to be answered",
  JSON.stringify(hr.rows.find(r => r.id === "fbv").cells.map(x => x.askable)));
ok(!hr.alerts.some(a => a.id === "fbv"), "it raises no alarm while nobody has looked");

/* the reader ticks the first drop as delivered and marks the second as genuinely absent */
hr = handRun({ fbv: { [drops[0]]: true, [drops[1]]: false } });
const vrow = hr.rows.find(r => r.id === "fbv");
ok(vrow.mode === "confirm", "once ticked it is answered, not blank", vrow.mode);
ok(vrow.cells[0].state === "okh" && vrow.cells[1].state === "miss",
  "a tick reads as posted and a cross as missing",
  vrow.cells.map(x => x.state).join(","));
ok(vrow.count === 1, "and the count is how many drops were confirmed", `${vrow.count}`);
/* the tick is a tick, but never the same mark as a measured one */
ok(vrow.cells[0].state !== "ok",
  "a hand tick is kept visually apart from a measured one", vrow.cells[0].state);

/* the target is set by what was measured. A tick answers a drop that already exists, so letting
   it set the target would be circular — and a channel ticked on every drop must not raise the bar
   for everybody else. */
ok(hr.expected === 2, "a hand tick never sets the day's target", `expected=${hr.expected}`);
hr = handRun({ fbv: { [drops[0]]: true, [drops[1]]: true } });
ok(hr.expected === 2 && hr.rows.find(r => r.id === "fbv").status === "ok",
  "ticking every drop reads ok without moving the target",
  `expected=${hr.expected} ${hr.rows.find(r => r.id === "fbv").status}`);

/* a channel that CAN be read must never be answered by hand — that would paper over an outage */
ok(hr.rows.find(r => r.id === "tgv").cells.every(x => !x.askable),
  "a channel that reports for itself is never offered a tick",
  JSON.stringify(hr.rows.find(r => r.id === "tgv").cells.map(x => !!x.askable)));

/* ── the working loop ──────────────────────────────────────────────────────
   This is the sequence the report is actually used in, and both halves have to hold or the tool
   is no use in it:

     1. run the check — a drop never reached one channel, so it reads MISSING and names which
     2. take that to distribution, who fix it and repost
     3. run the check again — the repost must now read LATE, with how far behind, and the channel
        must stop reading short

   Step 3 is the one that is easy to get wrong: the repost lands hours from the original, so
   without the merge it would open a drop of its own and the channel would still look short while
   seven others looked missing from a drop that never existed. Runs accumulate into checks.posts,
   so the second run still has the first run's posts to fold against. */
console.log("\n── the working loop: missing, fixed, then late");

const LOOP = [
  { id:"a", platform:"telegram",  name:"tg",  lang:"vi" },
  { id:"b", platform:"youtube",   name:"yt",  lang:"vi" },
  { id:"c", platform:"instagram", name:"ig",  lang:"vi" },
];
const loopRun = posts => {
  const cc = M.checks();
  cc.posts = posts; cc.counts = {}; cc.meta = {}; cc.captions = {};
  Object.assign(cc, { tz:7, win:15, maxPer:4 });
  return M.reconcile(LOOP, { tz:7, win:15, mode:"roll", hours:24, maxPerPeriod:4 });
};

/* run one — the second drop never reached ig */
const before = loopRun({
  a:[at("a1","a",300,ALAVES_TG), at("a2","a",200,SEVILLA_TG)],
  b:[at("b1","b",299,ALAVES_TG), at("b2","b",199,SEVILLA_TG)],
  c:[at("c1","c",298,ALAVES_TG)],
});
ok(before.slots.length === 2, "run 1: two drops", `${before.slots.length}`);
ok(before.rows.find(r => r.id === "c").status === "short",
  "run 1: the channel that missed one reads short — this is the bug report",
  `ig ${before.rows.find(r => r.id === "c").count}/${before.expected}`);
ok(before.alerts.some(x => x.kind === "missing" && x.id === "c"),
  "run 1: and it is raised as missing, naming the drop",
  (before.alerts.find(x => x.kind === "missing") || {}).text);
ok(before.slots[1].missing.indexOf("c") !== -1,
  "run 1: the drop itself lists it as not reached", before.slots[1].missing.join(","));
ok(before.rows.find(r => r.id === "c").cells[1].state === "miss",
  "run 1: and its matrix cell is a cross");

/* run two — distribution reposted it, 1h 40m behind. Same posts as before, plus the repost. */
const after = loopRun({
  a:[at("a1","a",300,ALAVES_TG), at("a2","a",200,SEVILLA_TG)],
  b:[at("b1","b",299,ALAVES_TG), at("b2","b",199,SEVILLA_TG)],
  c:[at("c1","c",298,ALAVES_TG), at("c2","c",100,SEVILLA_TG)],
});
ok(after.slots.length === 2,
  "run 2: still two drops — the repost did not invent a third", `${after.slots.length}`);
ok(after.rows.find(r => r.id === "c").status === "ok",
  "run 2: the channel is no longer short",
  `ig ${after.rows.find(r => r.id === "c").count}/${after.expected}`);
ok(!after.alerts.some(x => x.kind === "missing"),
  "run 2: and the missing alarm is gone");
ok(after.alerts.some(x => x.kind === "late" && x.id === "c" && /1h 40m/.test(x.text)),
  "run 2: it reads late instead, with exactly how far behind",
  (after.alerts.find(x => x.kind === "late") || {}).text);
ok(after.rows.find(r => r.id === "c").cells[1].lateBy === 100,
  "run 2: and the matrix cell carries the delay rather than a cross",
  String(after.rows.find(r => r.id === "c").cells[1].lateBy));
ok(after.slots[1].missing.indexOf("c") === -1,
  "run 2: the drop no longer lists it as missing", after.slots[1].missing.join(",") || "(none)");
/* the other channels must not be dragged into the repost's own slot as missing */
ok(after.slots.every(s => s.missing.length === 0),
  "run 2: and nobody else is accused of missing the repost",
  after.slots.map(s => s.missing.join("/")).join(" | ") || "(none)");

console.log("\n── slots and labels");
const s1 = M.clusterSlots([P("a", 300), P("b", 296), P("c", 60), P("d", 58)], 15);
ok(s1.length === 2 && s1.every(s => s.posts.length === 2),
  "minutes apart groups, hours apart splits", `${s1.length} slots of ${s1.map(s => s.posts.length)}`);
ok(M.clusterSlots([P("a", 300), P("b", 296)], 2).length === 2,
  "a narrower window splits a slow fan-out");

for (const [inp, want] of [["vietnamese", "vi"], ["English", "en"], ["Thai", "th"],
                            ["chaina", "zh"], ["", ""]])
  ok(M.normLang(inp) === want, `normLang(${JSON.stringify(inp)}) = ${JSON.stringify(want)}`);

for (const [s, want] of [
  [{ handle: "", url: "https://facebook.com/Sportsfc.thai" }, "Sportsfc.thai"],
  [{ handle: "", url: "https://t.me/s/sportsfc_vn" }, "sportsfc_vn"],
  [{ handle: "", url: "https://youtube.com/@SportsFC-vn" }, "@SportsFC-vn"],
  [{ handle: " @typed ", url: "https://facebook.com/other" }, "@typed"],
]) ok(M.chanLabel(s) === want, `chanLabel(${s.url}) = ${want}`, M.chanLabel(s));

/* counts are filed against the content date, which is what the window's end resolves to */
function require_date() {
  const tz = 7;
  return new Date(Date.now() + tz * 3600e3).toISOString().slice(0, 10);
}

/* ═══════════════════ viber: notification-sourced, never accuses ═══════════════════
   Viber reaches the report only through forwarded phone notifications — real timestamps, but
   unreliable window coverage and video posts that arrive as a bare "Video message" placeholder.
   Two real failures this pins:
     · a Viber notification that lines up with no real drop must NOT invent a drop of its own and
       cross out every healthy channel (the "17:18" phantom the report showed on a day nothing
       went out then);
     · a Viber notification inside a real drop's window is a ✓, but its ABSENCE is "·" — not seen
       forwarded — never a ✗, because the forwarder dropping a notification is not a real miss. */
console.log("\n── viber never invents a drop and never accuses");
{
  const VBCH = [
    { id: "ytv", platform: "youtube",  name: "YouTube · vn", lang: "vi" },
    { id: "tgv", platform: "telegram", name: "Telegram · vn", lang: "vi" },
    { id: "vbv", platform: "viber",    name: "Viber · vn",   lang: "vi" },
  ];
  const runV = setup => {
    const c = M.checks();
    c.posts = {}; c.counts = {}; c.meta = {}; c.confirms = {}; c.captions = {}; c.beats = [];
    Object.assign(c, { tz: 7, win: 15, hours: 24, maxPer: 4 });
    setup(c);
    return M.reconcile(VBCH, { tz: 7, win: 15, mode: "roll", hours: 24, maxPerPeriod: 4 });
  };
  const rowOf = (rep, id) => rep.rows.find(r => r.id === id);

  /* THE case the whole design turns on: the phone was ONLINE at a drop (a heartbeat near it) and
     still forwarded no Viber post — that is a real miss, and must be flagged, not assumed away. */
  {
    const rep = runV(c => {
      c.posts.ytv = [P("y1", 60, VN_TEXT)];
      c.posts.tgv = [P("t1", 61, VN_TEXT)];
      c.posts.vbv = [];                              // Viber forwarded nothing for this drop
      c.beats = [ago(60), ago(45), ago(30)];         // but the phone was heartbeating right then
    });
    const r = rowOf(rep, "vbv");
    ok(r.cells[0].state === "maybe",
      "phone ONLINE + no Viber post → ⚠ 'not seen' (a real miss), never a silent assumed ✓",
      r.cells[0].state);
    ok(r.status === "review", "the row reads 'review', not a clean 'seen'", r.status);
    ok(rep.alerts.some(a => a.kind === "maybe" && a.id === "vbv"),
      "and it raises a maybe-alert so the reader is told to check",
      JSON.stringify(rep.alerts.filter(a => a.id === "vbv")));
  }

  /* contrast: same missing post, but the phone was OFFLINE then (no heartbeat) → we cannot verify,
     so it is assumed, not flagged — no crying wolf for a window the phone could not report on */
  {
    const rep = runV(c => {
      c.posts.ytv = [P("y1", 60, VN_TEXT)];
      c.posts.tgv = [P("t1", 61, VN_TEXT)];
      c.posts.vbv = [];
      c.beats = [ago(600)];                          // last heartbeat 10h ago — phone was offline at the drop
    });
    const r = rowOf(rep, "vbv");
    ok(r.cells[0].state === "asm", "phone OFFLINE + no post → assumed (dashed ✓), not flagged", r.cells[0].state);
    ok(!rep.alerts.some(a => a.id === "vbv"), "and no false alarm is raised");
  }

  /* one real drop (YT + TG together), plus a lone Viber notification two hours off on its own */
  let rep = runV(c => {
    c.posts.ytv = [P("y1", 60, VN_TEXT)];
    c.posts.tgv = [P("t1", 61, VN_TEXT)];
    c.posts.vbv = [{ externalId: "v-stray", ts: ago(180), kind: "video", text: "Sportsfc.vn: Video message" }];
  });
  ok(rep.slots.length === 1, "a lone Viber notification does not become a drop of its own",
    `${rep.slots.length} slot(s)`);
  ok(!rep.alerts.some(a => a.kind === "missing"),
    "and it raises no 'missing' against the channels that were quiet then",
    JSON.stringify(rep.alerts.map(a => a.kind)));
  ok(rowOf(rep, "vbv").mode === "timefold" && rowOf(rep, "vbv").status !== "short",
    "Viber is never marked short", `${rowOf(rep, "vbv").mode}:${rowOf(rep, "vbv").status}`);

  /* the Viber notification lands inside the real drop's window → it folds in as a ✓, not a new drop */
  rep = runV(c => {
    c.posts.ytv = [P("y1", 60, VN_TEXT)];
    c.posts.tgv = [P("t1", 61, VN_TEXT)];
    c.posts.vbv = [{ externalId: "v-in", ts: ago(58), kind: "video", text: "Sportsfc.vn: Video message" }];
  });
  ok(rep.slots.length === 1, "a Viber notification inside a drop folds in, not out",
    `${rep.slots.length} slot(s)`);
  ok(rep.slots[0].present.indexOf("vbv") !== -1, "the drop credits Viber as present",
    rep.slots[0].present.join(","));
  ok(rep.slots[0].missing.indexOf("vbv") === -1, "and Viber is never in a drop's missing list",
    rep.slots[0].missing.join(","));
  ok(rowOf(rep, "vbv").cells[0].state === "ok", "its cell is ✓, not ✗", rowOf(rep, "vbv").cells[0].state);

  /* a real drop that Viber never forwarded a notification for → Viber cell is "·" (no data),
     never "✗", and no missing alert is raised for it */
  rep = runV(c => {
    c.posts.ytv = [P("y1", 60, VN_TEXT)];
    c.posts.tgv = [P("t1", 61, VN_TEXT)];
    c.posts.vbv = [];                                  // nothing forwarded from Viber at all
  });
  ok(rowOf(rep, "vbv").mode === "timefold",
    "Viber is ALWAYS automatic (timefold) — never a manual hand-confirm row",
    rowOf(rep, "vbv").mode);
  ok(rowOf(rep, "vbv").cells.every(c => c.state === "asm"),
    "with nothing forwarded, its drops are assumed delivered (✓), not crosses and not blanks-to-tick",
    rowOf(rep, "vbv").cells.map(c => c.state).join(","));
  ok(!rowOf(rep, "vbv").cells.some(c => c.askable),
    "no cell is a hand-confirm control — nothing here is ever manual");
  ok(!rep.alerts.some(a => a.id === "vbv"), "no alert accuses Viber of a miss",
    JSON.stringify(rep.alerts.filter(a => a.id === "vbv")));

  /* Viber must not set the expected target either — a channel this unreliable deciding everyone
     else's number is exactly the Facebook-suggestion failure in another guise */
  rep = runV(c => {
    c.posts.ytv = [P("y1", 60, VN_TEXT), P("y2", 300, VN_TEXT)];
    c.posts.tgv = [P("t1", 61, VN_TEXT), P("t2", 301, VN_TEXT)];
    c.posts.vbv = [{ externalId: "v1", ts: ago(58), kind: "video", text: "Sportsfc.vn: Video message" }];
  });
  ok(rep.expected === 2, "the reliable channels set the target; Viber's single notification does not",
    String(rep.expected));
  ok(rowOf(rep, "vbv").status !== "short", "Viber at 1 of 2 drops is still not short",
    rowOf(rep, "vbv").status);
  /* content goes out to every channel together, so a real drop Viber forwarded no notification for
     is ASSUMED delivered (a dashed ✓), never a miss — and the one it did forward is a firm ✓ */
  {
    const cells = rowOf(rep, "vbv").cells.map(c => c.state).sort().join(",");
    ok(cells === "asm,ok", "one drop is confirmed (✓), the other assumed (✓) — neither is a miss", cells);
  }

  /* THE bug the user hit: Viber re-sends "you have a message" REMINDERS for a post the phone never
     opened — minutes, then hours, apart. Those are not new posts. Judging Viber by COINCIDENCE with
     a real drop (not by how many notifications arrived) makes them harmless: several notifications
     around ONE drop still confirm exactly one drop, and a reminder that lines up with no drop is
     ignored outright — it can neither pad the count nor invent a delivery. */
  {
    const rep = runV(c => {
      c.posts.ytv = [P("y1", 60, VN_TEXT)];
      c.posts.tgv = [P("t1", 61, VN_TEXT)];                 // one real drop, ~60 min ago
      c.posts.vbv = [
        { externalId:"v-post", ts:ago(59), kind:"video", text:"Sportsfc.vn: Video message" },  // the real post, in the drop
        { externalId:"v-rem1", ts:ago(50), kind:"video", text:"Sportsfc.vn: Video message" },  // a reminder, still near the drop
        { externalId:"v-rem2", ts:ago(220), kind:"video", text:"Sportsfc.vn: Video message" }, // a reminder hours off, no drop there
      ];
      c.beats = [ago(60), ago(45)];
    });
    const r = rowOf(rep, "vbv");
    ok(r.count === 1, "one post + two reminders confirm ONE drop, not three",
      `count=${r.count} states=${r.cells.map(x => x.state).join(",")}`);
    ok(rep.slots.length === 1, "and the far-off reminder never becomes a drop of its own", `${rep.slots.length} slot(s)`);
    ok(!rep.alerts.some(a => a.id === "vbv"), "no false alarm — the drop that happened was confirmed");
  }

  /* The flip side of coincidence-based judging: a drop the phone was online for but no notification
     landed near IS a likely miss (⚠). Content went out on the other channels and the phone was up,
     yet no Viber post came — worth a check, not a silent pass. */
  {
    const rep = runV(c => {
      c.posts.ytv = [P("y1", 300, VN_TEXT), P("y2", 40, VN_TEXT)];
      c.posts.tgv = [P("t1", 301, VN_TEXT), P("t2", 41, VN_TEXT)];       // two drops
      c.posts.vbv = [{ externalId:"v1", ts:ago(299), kind:"video", text:"Sportsfc.vn: Video message" }];  // only the first aligns
      c.beats = [300, 200, 100, 40].map(m => ago(m));                     // phone online throughout
    });
    const r = rowOf(rep, "vbv");
    ok(r.count === 1 && r.cells.filter(x => x.state === "maybe").length === 1,
      "one drop confirmed, the other (online, no aligned notification) flagged ⚠",
      `count=${r.count} states=${r.cells.map(x => x.state).join(",")}`);
  }

  /* contrast: a GENUINE shortage — only 2 posts for 4 broadcasts, phone online → 2 flagged */
  {
    const rep = runV(c => {
      c.posts.ytv = [P("y1", 300, VN_TEXT), P("y2", 200, VN_TEXT), P("y3", 100, VN_TEXT), P("y4", 40, VN_TEXT)];
      c.posts.tgv = [P("t1", 301, VN_TEXT), P("t2", 201, VN_TEXT), P("t3", 101, VN_TEXT), P("t4", 41, VN_TEXT)];
      c.posts.vbv = [{ externalId:"v1", ts:ago(300), kind:"video", text:"x" }, { externalId:"v2", ts:ago(200), kind:"video", text:"x" }];
      c.beats = [300, 200, 100, 40].map(m => ago(m));
    });
    const r = rowOf(rep, "vbv");
    ok(r.count === 2 && r.cells.filter(x => x.state === "maybe").length === 2,
      "2 of 4 delivered → exactly 2 drops flagged ⚠ (the real shortfall)",
      `count=${r.count} states=${r.cells.map(x => x.state).join(",")}`);
    ok(rep.alerts.some(a => a.kind === "maybe" && a.id === "vbv"), "and a maybe-alert names the likely-missing drops");
  }

  /* duplicate notifications ("Unknown" + the name, same minute) are ONE post, not two */
  {
    const rep = runV(c => {
      c.posts.ytv = [P("y1", 60, VN_TEXT)];
      c.posts.tgv = [P("t1", 61, VN_TEXT)];
      c.posts.vbv = [{ externalId:"a", ts:ago(58), kind:"video", text:"Unknown: Video message" },
                     { externalId:"b", ts:ago(58), kind:"video", text:"Sportsfc.vn: Video message" }];
      c.beats = [ago(60)];
    });
    ok(rowOf(rep, "vbv").count === 1, "two notifications one minute apart count as a single delivered post",
      String(rowOf(rep, "vbv").count));
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
