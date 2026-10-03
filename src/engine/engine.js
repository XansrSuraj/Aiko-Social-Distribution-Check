/**
 * The daily-check engine — everything that is not drawing: the channel directory, the shared report
 * store (localStorage + the Supabase row via api/report), collection (api/collect, the extension
 * bridge, Apify cost settling), and the reconciliation that turns posts into drops, misses, late
 * posts and language flags.
 *
 * Lifted VERBATIM from the pre-React index.html (2026-10-03) — the engine's own lines are unchanged,
 * only wrapped in createEngine(env) so the React app owns it. The test suite reads its sections by
 * the same section markers it always did (the daily-check banner, the report-UI banner, collectServer).
 *
 *   const engine = createEngine({ toast, onChange });   // onChange: the report changed — redraw
 */
export function createEngine(env = {}) {
/* the bits of the page the engine used to reach for directly */
const toast = (msg, ic) => { if (env.toast) env.toast(msg, ic); };
const render = () => { if (env.onChange) env.onChange(); };
let dcRedraw = render;                        // "a channel arrived mid-run — repaint"
const cloud = { mode:"local", configured:false, updatedAt:null };
const adminKey = () => { try{ return sessionStorage.getItem("orghub.key") || ""; }catch(e){ return ""; } };

const DEF_PLATFORMS = [
  { id:"youtube",   name:"YouTube",     color:"#ff0033", icon:"si:youtube" },
  { id:"telegram",  name:"Telegram",    color:"#229ed9", icon:"si:telegram" },
  { id:"x",         name:"X (Twitter)", color:"#16181c", icon:"si:x" },
  { id:"facebook",  name:"Facebook",    color:"#1877f2", icon:"si:facebook" },
  { id:"instagram", name:"Instagram",   color:"#e1306c", icon:"si:instagram" },
  { id:"tiktok",    name:"TikTok",      color:"#00b8c4", icon:"si:tiktok" },
  { id:"tgbot",     name:"Telegram bot", color:"#229ed9", icon:"si:telegram" },
];
const platform = id => DEF_PLATFORMS.find(p => p.id === id) ||
  { id:"other", name:"Other channel", color:"#525252", icon:"lucide:at-sign" };

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
function safeUrl(u){
  const s = String(u || "").trim();
  if(!s) return "";
  if(/^https?:\/\//i.test(s)) return s;
  if(/^[a-z][a-z0-9+.-]*:/i.test(s)) return "";
  return "https://" + s.replace(/^\/+/, "");
}
function pretty(u){
  try{ const x = new URL(safeUrl(u)); return (x.host.replace(/^www\./, "") + x.pathname).replace(/\/$/, ""); }
  catch(e){ return String(u || ""); }
}

const SPORTSFC = {
  id: "sportsfc", name: "SportsFC",
  socials: [
    /* ytChannelId is the UC… id the YouTube API actually takes; a handle has to be looked up to
       reach it. Pinned here because the lookup is the one step that can fail on its own, and
       because skipping it saves a quota unit on every run. */
    { id:"yt-vn",   platform:"youtube",   url:"https://youtube.com/@SportsFC-vn",   handle:"@SportsFC-vn",   note:"vietnamese", ytChannelId:"UCOn89EhBv7qavXWvXFKw1FA" },
    { id:"yt-fans", platform:"youtube",   url:"https://youtube.com/@sportsfc_fans", handle:"@sportsfc_fans", note:"english",    ytChannelId:"UCbqnwmEMgqGH2WQ-UpbX2lA" },
    { id:"tg-vn",   platform:"telegram",  url:"https://t.me/sportsfc_vn",           handle:"sportsfc_vn",    note:"vietnamese" },
    { id:"tg-fans", platform:"telegram",  url:"https://t.me/sportsfc_fans",         handle:"sportsfc_fans",  note:"english" },
    { id:"x-vn",    platform:"x",         url:"https://x.com/Sportsfcvn",           handle:"Sportsfcvn",     note:"vietnamese" },
    { id:"fb-vn",   platform:"facebook",  url:"https://facebook.com/sportsfc.vn",   handle:"sportsfc.vn",    note:"vietnamese" },
    { id:"fb-fans", platform:"facebook",  url:"https://facebook.com/Sportsfc.fans", handle:"Sportsfc.fans",  note:"english" },
    { id:"ig-vn",   platform:"instagram", url:"https://instagram.com/sportsfc.vn",  handle:"sportsfc.vn",    note:"vietnamese" },
    { id:"ig-fans", platform:"instagram", url:"https://instagram.com/sportsfc.fans",handle:"sportsfc.fans",  note:"english" },
    /* @sportsfc.fans was this channel until it disappeared from TikTok (2026-10-02: TikTok answers
       statusCode 10221 for it, exactly as for a made-up handle). @sportsfc.vn carries the same drops
       at the same minutes as every other VN channel, sfc.my links included. */
    { id:"tt-vn",   platform:"tiktok",    url:"https://www.tiktok.com/@sportsfc.vn",   handle:"sportsfc.vn",   note:"vietnamese" },
    /* Brazil (added 2026-10-03): Portuguese, its own schedule — about two posts a day, some the same
       drop as VN/EN, some not — so it is reported as its own REGION (see REGIONS), never measured
       against the Vietnam/English drops. ytChannelId read off the channel page. */
    { id:"fb-br",   platform:"facebook",  url:"https://www.facebook.com/sportsfc.br", handle:"sportsfc.br", note:"portuguese", region:"br" },
    { id:"ig-br",   platform:"instagram", url:"https://www.instagram.com/sportsfc.br", handle:"sportsfc.br", note:"portuguese", region:"br" },
    { id:"yt-br",   platform:"youtube",   url:"https://www.youtube.com/@sfc-br",       handle:"@sfc-br",     note:"portuguese", region:"br",
      ytChannelId:"UCR6OeH8jO7RMFDkx0Rfdv0w" },
    { id:"tg-bot-vn", platform:"tgbot",   url:"https://t.me/SportsfcBot",              handle:"SportsfcBot",   note:"vietnamese" },
  ],
  websites: [], tags: [],
};

/* storage mode: cloud (a shared Supabase row) or this browser only */
async function pull(){
  const r = await fetch("api/data", { cache:"no-store" });
  const j = await r.json();
  if(!j.ok) throw new Error(j.error || "read failed");
  cloud.configured = !!j.configured;
  cloud.mode = j.configured ? "cloud" : "local";
  cloud.updatedAt = j.updatedAt || null;
}

/* ═══════════════════ daily check ═══════════════════
   Answers one question: did today's content reach every channel?

   Post data arrives from two places — api/collect for the channels a server can read (YouTube,
   Telegram, X, and Viber via the phone forwarder), and the browser extension for Facebook and
   Instagram (and X as a fallback, when a datacenter IP is refused what the browser's own IP can
   still fetch). Both land in the same store.

   That store lives in localStorage first, and — when cloud storage is configured — is mirrored to
   a shared Supabase row (api/report) so a check run on one device is the same "today" every other
   device sees. localStorage stays the fallback: an offline moment or an unconfigured deployment
   loses nothing, the report is simply not shared until the cloud is back.

   Runs accumulate. Each source returns only its most recent posts (Telegram ~20, YouTube 15,
   Instagram ~12, X as few as 3 and rarely more than ~10), so merging on every run builds a
   history none of them offer on their own. */
const CKEY = "orghub.checks";
const BRUN = "orghub.browserRun";       // handoff slot the extension writes into

let checks = { posts:{}, counts:{}, captions:{}, meta:{}, ytIds:{}, confirms:{}, tz:7, win:15,
               window:"today", date:null, maxPer:4, lastRun:null };
try{
  const c = JSON.parse(localStorage.getItem(CKEY) || "null");
  if(c && typeof c === "object") checks = { ...checks, ...c };
}catch(e){}
let reportUpdatedAt = null;          // instant the shared report row was last stored (concurrency)
let reportPushT = null;              // debounce handle for the cloud push

/* localStorage FIRST, always — that is the copy that survives an offline moment or an unconfigured
   deployment. Then, if cloud storage is on, share it so every other device sees the same report. */
const saveChecks = () => {
  try{ localStorage.setItem(CKEY, JSON.stringify(checks)); }catch(e){}
  pushReport();
};

/* Boot-time read of the shared report: a check someone ran on another device becomes visible here.
   Cloud is the source of truth for the shared fields; an empty cloud row leaves the local copy
   untouched. Never fatal — a failure just means this browser shows what it already had. */
async function pullReport(){
  if(cloud.mode !== "cloud") return;
  try{
    const r = await fetch("api/report", { cache:"no-store" });
    const j = await r.json();
    if(j && j.ok && j.data && typeof j.data === "object"){
      checks = { ...checks, ...j.data };
      reportUpdatedAt = j.updatedAt || null;
      saveLocalChecksOnly();                       // mirror the shared copy into localStorage too
    }
  }catch(e){ /* offline / not configured — the local copy stands */ }
}
const saveLocalChecksOnly = () => { try{ localStorage.setItem(CKEY, JSON.stringify(checks)); }catch(e){} };

/* Share the report after a check. Debounced, so the burst of saveChecks() a single run fires
   collapses into one write. Because localStorage already holds the copy, a failed push is silent:
   the next save retries and the browser never loses anything. On a 409 another device ran the
   check meanwhile — take theirs rather than clobber it. */
function pushReport(){
  if(cloud.mode !== "cloud") return;
  clearTimeout(reportPushT);
  reportPushT = setTimeout(async () => {
    try{
      const r = await fetch("api/report", {
        method:"PUT",
        headers:{ "Content-Type":"application/json", "x-admin-key":adminKey() },
        body:JSON.stringify({ data:checks, baseUpdatedAt:reportUpdatedAt })
      });
      const j = await r.json().catch(() => ({}));
      if(r.status === 409){ await pullReport(); render(); return; }
      if(j && j.ok && j.updatedAt) reportUpdatedAt = j.updatedAt;
    }catch(e){ /* stays in localStorage; the next save will try again */ }
  }, 400);
}

/* The whole store travels in one shared report row (capped at 2 MB server-side) and no window looks
   back more than a week, so posts older than this are dropped rather than kept for ever. */
const POST_KEEP_DAYS = 14;
function mergePosts(channelId, incoming){
  const have = checks.posts[channelId] || [];
  const byId = new Map(have.map(p => [p.externalId, p]));
  let added = 0;
  for(const p of (incoming || [])){
    if(!p || !p.externalId || !p.ts) continue;
    const old = byId.get(p.externalId);
    if(!old){ added++; byId.set(p.externalId, p); continue; }
    /* A post read again brings today's counters, and a newer reader may bring what an older one
       lacked (a thumbnail, hashtags). The fresh read wins field by field — but an empty field never
       wipes out a filled one. */
    const merged = { ...old };
    for(const [k, v] of Object.entries(p)) if(v !== null && v !== undefined && v !== "") merged[k] = v;
    byId.set(p.externalId, merged);
  }
  const keepFrom = Date.now() - POST_KEEP_DAYS * 86400e3;
  /* newest first, and capped so one busy channel cannot grow the store without bound */
  checks.posts[channelId] = [...byId.values()]
    .filter(p => !(new Date(p.ts).getTime() < keepFrom))
    .sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 400);
  return added;
}

/* ── language ──────────────────────────────────────────────────────────────
   Language lives in the channel's free-text note and is typo-prone ("chaina"), so match
   loosely onto ISO codes — otherwise a misspelling silently splits a language group. */
const LANGS = [["vi", /viet|\bvn\b|tiếng|tieng/i], ["th", /thai|\bth\b/i],
               ["zh", /chin|chai|\bcn\b|中文|mandarin/i], ["pt", /portug|brazil|brasil|\bpt\b|\bbr\b/i],
               ["en", /eng|\ben\b/i]];
function normLang(s){
  const t = String(s || "").trim();
  if(!t) return "";
  for(const [code, re] of LANGS) if(re.test(t)) return code;
  return t.toLowerCase().slice(0, 12);
}

/* ── time ──────────────────────────────────────────────────────────────────
   "Which day was this posted" has to be answered in one fixed zone, or the VN, TH and CN
   channels drop the same content into different buckets. Default UTC+7 (ICT). */
const contentDate = (ts, tz) => new Date(new Date(ts).getTime() + (tz || 0) * 3600e3)
  .toISOString().slice(0, 10);
const hhmm = (ts, tz) => new Date(new Date(ts).getTime() + (tz || 0) * 3600e3)
  .toISOString().slice(11, 16);
/* a span of minutes, said the way a person would say it */
const fmtGap = m => m >= 1440 ? Math.round(m / 1440) + "d"
  : m >= 60 ? Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "")
  : m + "m";

/* ── one post per piece of content ───────────────────────────────────────────
   Two readers can hand the same post back under different ids. Instagram is the case that bit us:
   the server API keys a reel by its numeric id (permalink /p/CODE), the extension by its shortcode
   (permalink /reel/CODE) — same reel, two ids, so mergePosts (which de-dupes by id) kept both. A
   channel then counted 4 for a day it posted 2, which inflated the expected target and made every
   OTHER channel read as "2 missing" on a day nothing was actually missing.

   So collapse a channel's posts to one per piece of content before counting. A substantial caption
   at the same minute is the same content whichever reader found it — that is the signature used.
   When there is too little text to be sure, the post's own id is kept as the key instead, so two
   genuinely distinct short posts are never merged into one. */
function contentKey(p){
  /* A Facebook reel's own id is in its link whichever reader found it. The post timeline and the
     Reels tab read the same reel with different ids, a minute apart, one with a caption and one
     without — neither the id nor the caption signature would ever pair them. */
  const reel = String((p && p.permalink) || "").match(/facebook\.com\/reel\/(\d+)/);
  if(reel) return "r:" + reel[1];
  const min = p && p.ts ? new Date(p.ts).toISOString().slice(0, 16) : "";
  const txt = String((p && p.text) || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase().slice(0, 50);
  if(txt.length >= 12) return "c:" + min + "|" + txt;      // same words, same minute → same content
  return "i:" + ((p && p.externalId) || min);              // too little text — trust the id, don't merge
}
function dedupePosts(list){
  const seen = new Map();
  for(const p of (list || [])) { const k = contentKey(p); if(!seen.has(k)) seen.set(k, p); }
  return [...seen.values()];
}

/* ── slots ─────────────────────────────────────────────────────────────────
   The same reel lands on each channel a minute or two apart, while separate drops are hours
   apart, so a new slot starts wherever the gap to the previous post exceeds the window.
   Single-linkage rather than a fixed grid: a grid splits any slot that straddles a boundary. */
function clusterSlots(posts, winMin){
  const gap = (winMin || 15) * 60e3;
  const sorted = [...posts].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const out = [];
  for(const p of sorted){
    const last = out[out.length - 1];
    if(last && new Date(p.ts) - new Date(last.last) <= gap){ last.posts.push(p); last.last = p.ts; }
    else out.push({ first:p.ts, last:p.ts, posts:[p] });
  }
  return out;
}

/* ── language of a caption ──────────────────────────────────────────────────
   Catches the mistake a count can never catch: the right number of posts, on the right channel,
   in the wrong language. A Vietnamese reel on the English channel counts as delivered and reads
   as healthy, so the caption has to be read.

   Vietnamese is unusually easy to be sure about. đ ă ơ ư exist in no other Latin-script
   language, so a single one settles it. Tone marks alone are not enough — "Andrés Iniesta" in an
   English caption carries an acute accent, and counting that as Vietnamese would flag correct
   posts. Verified against 40 real captions from both channels: 40 right, 0 wrong. */
const VN_UNIQUE = /[đĐăĂơƠưƯ]/g;
const VN_TONES = /[àáảãạầấẩẫậằắẳẵặèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/gi;
const VN_WORDS = /\b(và|của|không|người|được|những|trong|cho|với|các|là|có|để|này|khi|một|đã|sẽ|từ|như|trận|xem|ngay|bóng|đá|cầu|thủ|huyền|thoại|miễn|phí|câu|lạc|bộ|hâm|mộ|nhất|rất|thể|sự|nghiệp|cuộc|tranh|luận|tuổi|tác|chỉ|con|số|đến|nên|bàn|thắng|mùa|giải|đấu|trường|thời|đại)\b/gi;
const EN_WORDS = /\b(the|and|for|with|this|that|your|you|are|our|from|all|new|watch|now|free|club|fans|match|his|her|was|were|has|have|one|two|three|four|five|when|what|who|how|but|not|more|most|just|about|into|over|after|before|only|than|then|them|they|their|there|been|being|would|could|should|will|can|did|does|goal|goals|team|game|season|player|players|legend|legends|career|careers|era|eras|question|choice|generation|generations|icons?|nation|whole|another|different|same|stage|number|age)\b/gi;
/* Portuguese shares á é í ó ú ã õ with Vietnamese's tone marks, so letters cannot tell them apart —
   its own function words can, plus ç, which Vietnamese never uses. Only words that are not also
   English ("do", "no", "as", "time" are left out). Letter-boundaries, not \b: \b is ASCII-only and
   would never match around "é" or "já". */
const PT_WORDS = /(?<!\p{L})(de|da|das|dos|que|não|vai|com|para|uma|um|os|contra|seu|sua|mais|jogo|jogos|melhor|quem|ataque|defesa|vitória|conseguir|ou|é|já|pelo|pela|entre|sobre|ritmo|buscar|seleção|gols|partida|então|isso|esse|essa|ele|ela|muito|hoje|onde|quando|como|também|está|são|vamos|nós|furar|vencer|impor)(?!\p{L})/giu;
const PT_ONLY = /[çÇ]/g;
const RX_THAI = /[฀-๿]/;
const RX_CJK = /[㐀-䶿一-鿿]/;
const hits = (s, re) => (s.match(re) || []).length;

function detectLang(text){
  const t = String(text || "");
  /* Drop URLs, hashtags and handles first. A short-link slug is not language, and hashtags are
     usually written in English even on a Vietnamese post — leaving them in tilts every caption
     toward English. */
  const body = t.replace(/https?:\/\/\S+/g, " ").replace(/#[\wÀ-ỹ]+/g, " ")
                .replace(/@[\w.]+/g, " ").trim();
  if(body.replace(/[^A-Za-zÀ-ỹ฀-๿一-鿿]/g, "").length < 4)
    return { lang:"", why:"too little text to tell" };

  if(RX_THAI.test(body)) return { lang:"th", why:"Thai script" };
  if(RX_CJK.test(body))  return { lang:"zh", why:"Chinese characters" };

  const letters = body.replace(/[^A-Za-zÀ-ỹ฀-๿一-鿿]/g, "").length || 1;
  const uniq = hits(body, VN_UNIQUE), tones = hits(body, VN_TONES);
  const vnw = hits(body, VN_WORDS), enw = hits(body, EN_WORDS);
  const vnLetters = uniq + tones;                              // Vietnamese-specific letters
  const vnPct = Math.round(vnLetters / letters * 100);
  /* Vietnamese is written mostly in plain Latin letters, so "50% of the letters carry a diacritic"
     is the wrong test — real Vietnamese captions would fail it. Instead weigh the Vietnamese signal
     (its own letters + its function words) against the English one, and only call a post Vietnamese
     when that signal clearly WINS. A couple of stray accented characters in an English caption
     (a player's name, a borrowed word) no longer flip the whole post — which is what was raising a
     false ⚠ on the English fans channels. The exact counts ride out in `why` so the report can show
     precisely what was seen ("3 VN letters — 4% of the text"), at the top, next to the flag. */
  const vnScore = vnw * 3 + vnLetters, enScore = enw * 3;
  const why = `${vnw} VN word(s) + ${vnLetters} VN letter(s) (${vnPct}% of the text) vs ${enw} EN word(s)`;
  const ptw = hits(body, PT_WORDS), ptc = hits(body, PT_ONLY);
  const out = extra => Object.assign({ vnPct, vnLetters, vnw, enw, ptw }, extra);

  /* Portuguese first: its accents would otherwise be counted as Vietnamese tone marks. Only when no
     Vietnamese-only letter is present, and its own words clearly outweigh both other signals. */
  if(uniq === 0 && ptw >= 2 && ptw * 3 + ptc > Math.max(vnw * 3, enScore))
    return out({ lang:"pt", why:`${ptw} PT word(s) + ${ptc} ç vs ${enw} EN word(s), ${vnw} VN word(s)` });

  if((vnw >= 1 || vnLetters >= 2) && vnScore > enScore) return out({ lang:"vi", why });
  if(enw >= 1 && enScore >= vnScore)                    return out({ lang:"en", why });
  if(vnLetters >= 3 && vnPct >= 12 && enw === 0)        return out({ lang:"vi", why });
  if(enw >= 2)                                          return out({ lang:"en", why });
  return out({ lang:"", why:"no clear signal" });
}

/* ── matching on what a post said ────────────────────────────────────────
   Facebook cannot be matched on time. Its HTML reaches back only a handful of posts and its
   timestamps do not cover a whole day, so a drop it did receive looks missing purely because the
   window was never fully read. What it does give reliably is the words.

   So for Facebook the question becomes: does any of its captions say the same thing as this drop?
   Compared within one language — the Vietnamese and English variants of a drop are different text
   and must not match each other, or the language check would be meaningless.

   Character trigrams, scored by containment rather than Jaccard, because Facebook clips long
   captions and appends its own "see more": a truncated caption is a subset of the original, which
   containment scores near 1 and Jaccard punishes. Measured on the real captions, a genuine match
   scores 0.84–1.00 and an unrelated post from the same day 0.09–0.21, so the threshold sits in a
   very wide gap rather than on a knife edge. */
const CONTENT_MATCH = 0.6;

function normText(s){
  return String(s || "").toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\wÀ-ỹ]+/g, " ")
    .replace(/(…|\.\.\.)?\s*(see more|xem thêm|more)\s*$/i, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function trigrams(s){
  const t = " " + normText(s).replace(/\s+/g, " ") + " ";
  const g = new Set();
  for(let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3));
  return g;
}
function contentScore(a, b){
  const A = trigrams(a), B = trigrams(b);
  if(A.size < 4 || B.size < 4) return 0;
  let inter = 0;
  for(const g of A) if(B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

/* WORD-level caption comparison — the transparent, strict test the report shows for the channels
   whose captions we read (Facebook, Instagram). It asks a plain question anyone can check: how many
   of THIS drop's words actually appear in that channel's caption? The same post across channels
   shares nearly all of its words (players, competition, date, the whole body); a different post —
   even the next day's same-competition one — shares only a handful. So a high overlap means the
   reel went out; a low one means it did not, and the count says exactly how sure we are. Words are
   normalised (lowercased, links/punctuation dropped) and 1-character noise removed. */
function capWords(s){
  return String(s || "").toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\wÀ-ỹ]+/g, " ")
    /* Facebook clips a long caption and appends its own "see more" — that is chrome on a button,
       not something anybody wrote. normText strips it for the trigram score and this did not, so
       every truncated caption carried two words the drop could never contain. Harmless while the
       only consumer was a 60% threshold; the moment one unmatched word raises an alert, it would
       have fired on every long Facebook post and taught the reader to ignore the alert. */
    .replace(/(…|\.\.\.)?\s*(see more|xem thêm|more)\s*$/i, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/).filter(w => w.length >= 2);
}
/* Facebook cuts a long caption at a fixed length before appending its "See more", and the cut
   lands mid-word about as often as not — "khoảnh" arrives as "kho". That fragment is not a word
   anybody wrote. It cost nothing while a caption only had to clear 60%, but now that every word
   has to match it would cross out captions that genuinely did go out, so a caption showing the
   truncation marker gives up its final token before being compared. */
const CLIPPED = /(…|\.\.\.)\s*(see more|xem thêm|more)?\s*$/i;

function captionOverlap(dropText, channelCaption){
  let capw = capWords(channelCaption);
  if(CLIPPED.test(String(channelCaption || "")) && capw.length) capw = capw.slice(0, -1);
  const A = [...new Set(capWords(dropText))], B = [...new Set(capw)];
  /* Compare against the SHORTER caption's words (containment), because Facebook clips long captions
     with a "see more" — the truncated text is a subset of the full one, and a subset should still
     read as the same post. A genuinely different post shares only a few words either way. */
  const small = A.length <= B.length ? A : B, bigSet = new Set(A.length <= B.length ? B : A);
  if(small.length < 3) return { ratio: 0, matched: 0, total: small.length, missing: small };
  const matched = small.filter(w => bigSet.has(w));
  return { ratio: matched.length / small.length, matched: matched.length, total: small.length,
           missing: small.filter(w => !bigSet.has(w)) };
}

/* A tick here means "this reel went out on this channel". It used to mean "60% of its words turned
   up in some caption", which is a different claim, and the gap between the two is where a post
   that never went out on sportsfc.vn came back delivered.

   So the bar is now every word. A drop is credited only when the shorter of the two texts is
   wholly contained in the longer — nothing left over, nothing unaccounted for. Anything short of
   that is a cross.

   This deliberately trades a false tick for a false cross, on the user's instruction and for a
   good reason: a cross is visible and gets checked, while a tick is never looked at again. The
   report must never claim delivery it cannot prove.

   CAPTION_NEAR no longer decides anything. It only marks a cross as CLOSE — most of the words
   matched, so it is probably the same post reworded and worth a human minute — which keeps the
   information the old threshold carried without letting it grant a tick. */
const CAPTION_NEAR = 0.6;
/* How many words of a drop may be absent from a channel's caption and the drop still count as
   delivered there. A word count rather than a percentage on purpose: a percentage scales with
   caption length, so a long caption could differ in a dozen words and still pass, while a short one
   could be crossed over a single article. Five is five either way.
   It exists because demanding every word crossed real posts for trivia — a shortened link, a stray
   "https", a per-platform tracking suffix — and those crosses buried the genuine misses. Whatever
   it lets through is still reported: an imperfect tick always raises an alert naming the words. */
const CAPTION_SLACK = 5;

/* How many words of the WRONG language a caption may carry before the matrix flags the cell.
   A Vietnamese channel legitimately carries English words — a competition name, a player, a
   borrowed football term — and flagging those put a ⚠ on correct posts, which teaches the reader
   to ignore the symbol. Above the allowance it is no longer a borrowed word or two, it is a post in
   the wrong language, and that is what the symbol is for.
   Below it the mismatch is NOT hidden: it is still listed in the problems section with the exact
   counts. The allowance decides whether a cell is marked, never whether a fact is reported. */
const LANG_SLACK = 5;
/* the words of the other language actually counted, so the allowance is measured, not guessed */
const offLangWords = d => (d && d.lang === "en" ? (d.enw || 0)
                        : d && d.lang === "vi" ? (d.vnw || 0)
                        : d && d.lang === "pt" ? (d.ptw || 0) : 0);
const langFlagged = d => offLangWords(d) > LANG_SLACK;

/* The one thing that separates two otherwise-identical templated posts is the fixture they name —
   its DATE. SportsFC captions carry it as "📅 28 August 2026" (and a kick-off time). Two posts a day
   apart share ~70% of their words but name different dates, so this is what stops yesterday's
   "EFL Cup … 27 August" caption from being credited for today's "EFL Cup … 28 August" drop. */
const MON3 = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
function fixtureDates(text){
  const out = new Set(); const t = String(text || ""); let m;
  const re = new RegExp("(\\d{1,2})\\s+(" + MON3 + ")", "gi");
  while((m = re.exec(t))) out.add(m[1] + m[2].slice(0, 3).toLowerCase());
  return out;
}
/* true when both captions name a date and NONE of them coincide → they are different fixtures */
function differentFixture(a, b){
  const A = fixtureDates(a), B = fixtureDates(b);
  if(!A.size || !B.size) return false;                    // at least one has no date → can't tell, don't block
  for(const d of A) if(B.has(d)) return false;            // a shared date → same fixture, allow
  return true;                                            // both dated, no overlap → different day's post
}
/* which channels are judged on content instead of time. X is deliberately not here even though it
   shares the "browser-hostile" reputation Facebook has — its collector reads a real per-post
   timestamp out of the profile page's own schema.org microdata, so it gets genuine instants and
   belongs on the timeline side, matched drop by drop like YouTube and Telegram, not on words. */
/* Facebook was put on content because no reader of it could prove absence: the extension gets
   captions without dependable times, and the post-timeline scraper skipped a whole day of posts on
   one run (2026-10-02). The Reels-tab reader (source "facebook-reels") lists a page's reels newest
   first with exact times — and no captions at all, so content matching would have nothing to work
   on. A Facebook channel whose latest read came from it is therefore matched on time, exactly like
   YouTube or TikTok, under the same covered-stretch rules; read any other way it stays on content.
   The assumption this rests on: SportsFC publishes to Facebook as reels. A photo post would not be
   on the Reels tab, and its drop would read as missing there. */
/* The free reader of the page's own Reels tab ("facebook-free", 2026-10-03) brings the same complete,
   newest-first list with exact times — and captions too — so it is matched on time as well. */
const fbByTime = c => { const m = (checks.meta || {})[c.id];
  return !!(m && m.ok !== false && (m.source === "facebook-reels" || m.source === "facebook-free")); };
const matchesByContent = c => c.platform === "facebook" && !fbByTime(c);
/* Viber reaches us only as forwarded phone notifications: real per-post timestamps, but coverage
   of the window that cannot be depended on (a killed listener, a collapsed "3 new messages"
   bundle), and video posts that arrive as a bare "Video message" placeholder rather than a caption.
   That is the same shape as Facebook — a notification proves a post was made, its silence proves
   nothing — so Viber must never anchor a drop or accuse one of a miss. Unlike Facebook it does
   carry instants, so it folds into a drop by TIME rather than by caption: a notification inside a
   drop's window is a ✓, and no notification is "·" (not seen forwarded), never "✗". */
const foldsByTime = c => c.platform === "viber";
/* a caption is an object; runs before that stored bare strings */
const capObj = t => (t && typeof t === "object" ? t : { text:String(t || "") });

/* ── one piece of content, two clocks ──────────────────────────────────────
   Clustering on time assumes the same content reaches every channel within minutes, which is
   normally true and was true for three of this day's four drops. It is not always: one clip went
   out on eight channels at 12:42 and on X at 14:43, two hours adrift. Single-linkage put that in
   two slots, and the report then claimed five drops on a day four things were published — marking
   X missing from the first, eight channels missing from the second, and pushing a Facebook page to
   5/4 because its captions answered both halves. Every one of those was false.

   So after clustering, fold together any two slots that are one drop arriving late. Two separate
   tests must agree, because merging drops is a far stronger claim than matching a caption:

     · the channel sets must be disjoint — a channel cannot be late to a drop it already made, so
       any overlap means these are two real posts rather than one arriving twice. This alone is
       what keeps a channel that genuinely posts the same thing twice from being quietly merged.
     · the words and the identifying tokens must both match.

   That second test needs more than the trigram score Facebook is matched on. These captions are
   templated — "Liệu {team} có thể giành chiến thắng? … {n}% khả năng…" — so two entirely
   different fixtures score as high as 0.84 against each other, well above the 0.6 caption
   threshold; merging on that alone would collapse a whole day into one drop. What actually
   separates them is the handful of tokens naming the fixture: the hashtags, the percentages, the
   proper nouns. Measured across a full day of both channels, that signature scored 1.00 for every
   same-content pair and at most 0.67 for every different one — a gap of 0.33 where the trigram
   score alone leaves 0.12. Both must pass. */
const DROP_MERGE = 0.8;

function contentSig(s){
  const t = String(s || "");
  const out = new Set();
  for(const m of t.match(/#[\wÀ-ỹ]+/g) || []) out.add("#" + m.slice(1).toLowerCase());
  const bare = t.replace(/https?:\/\/\S+/g, " ");
  for(const m of bare.match(/\d+(?:[.,]\d+)?/g) || []) out.add("n" + m.replace(",", "."));
  for(const m of bare.replace(/#[\wÀ-ỹ]+/g, " ").match(/\b[A-ZÀ-Ỹ][\wÀ-ỹ]{2,}\b/g) || [])
    out.add(m.toLowerCase());
  return out;
}
function sigScore(a, b){
  const A = contentSig(a), B = contentSig(b);
  /* a thin signature cannot carry a merge — containment across two tokens is far too easy to
     satisfy, and a wrong merge hides a real miss */
  if(A.size < 3 || B.size < 3) return 0;
  let inter = 0;
  for(const g of A) if(B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

/* is b the same drop as a, arriving late on channels a never had? */
function sameDrop(a, b){
  const seen = new Set(a.posts.map(p => p.channelId));
  for(const p of b.posts) if(seen.has(p.channelId)) return false;
  for(const pa of a.posts){
    const ta = (pa.text || "").trim();
    if(!ta) continue;
    const la = detectLang(ta).lang;
    if(!la) continue;                       // no language, no verdict — leave the slots apart
    for(const pb of b.posts){
      const tb = (pb.text || "").trim();
      if(!tb || detectLang(tb).lang !== la) continue;
      if(contentScore(ta, tb) >= CONTENT_MATCH && sigScore(ta, tb) >= DROP_MERGE) return true;
    }
  }
  return false;
}

function mergeLate(slots){
  const out = [];
  /* clusterSlots hands these over oldest first, so anything absorbed is always the later half */
  for(const s of slots){
    const hit = out.find(o => sameDrop(o, s));
    if(!hit){ out.push({ first:s.first, last:s.last, posts:s.posts.slice(), lateIds:[] }); continue; }
    hit.posts = hit.posts.concat(s.posts);
    /* Late means precisely "arrived in a time cluster of its own, well after this drop began" —
       which is exactly what a merge absorbs, and nothing else. Measuring lateness against the
       window instead would flag an ordinary slow fan-out: single-linkage lets one drop chain
       across far more than the window, so nine channels three minutes apart would have had the
       last of them accused of being late when nothing was wrong. */
    for(const p of s.posts) if(hit.lateIds.indexOf(p.channelId) === -1) hit.lateIds.push(p.channelId);
    if(new Date(s.first) < new Date(hit.first)) hit.first = s.first;
    if(new Date(s.last)  > new Date(hit.last))  hit.last  = s.last;
  }
  return out.sort((a, b) => new Date(a.first) - new Date(b.first));
}

/**
 * Reconcile one window — by default the last 24 hours, which is the question being asked.
 *
 * channels: [{ id, name, platform, lang }]
 * opt:      { hours, win, tz, maxPerPeriod }
 *
 * Each channel lands in one of four modes, and the difference decides whether silence means
 * failure or ignorance:
 *   timeline  real per-post timestamps — matched drop by drop, language checked
 *   content   captions but no dependable times (Facebook) — matched on what the post said
 *   count     a number only — compared, not matched
 *   none      nothing collected — reported unknown, never missing, because an uncollected
 *             channel is not a failed post and conflating them buries the real gaps
 */
/* The window can be a rolling stretch of hours or one calendar day in the chosen zone. The
   difference matters: at midday a rolling 24 h straddles two dates, so "how many went out today"
   cannot be answered from it. A day runs from midnight in that zone, and never past now. */
function windowBounds(opt){
  const tz = opt.tz || 0;
  if(opt.mode === "day" && opt.date){
    const start = Date.parse(opt.date + "T00:00:00Z") - tz * 3600e3;
    if(isFinite(start)) return { from:start, to:Math.min(start + 86400e3, Date.now()) };
  }
  const to = Date.now();
  return { from:to - (opt.hours || 24) * 3600e3, to };
}

function reconcile(channels, opt){
  const tz = opt.tz, win = opt.win;
  const maxPer = opt.maxPerPeriod || 4;
  const { from, to } = windowBounds(opt);
  const hours = Math.max(1, Math.round((to - from) / 3600e3));
  const inWindow = ts => { const t = new Date(ts).getTime(); return t >= from && t <= to + 60e3; };

  /* posts inside the window, per channel — de-duped so the same content found by two readers under
     two ids counts once (see contentKey), which is what keeps the expected target honest.
     If a channel's LATEST collect FAILED (meta.ok === false — an outage, a rate/credit limit, a
     timeout), its previously-stored posts are IGNORED here. Otherwise the reconcile would measure
     today against a stale snapshot and cross off every drop newer than it — inventing misses on a
     channel we simply could not read. A channel we could not read must read "unknown", never "✗". */
  const readFailed = c => { const m = (checks.meta || {})[c.id]; return !!(m && m.ok === false); };
  const posts = {};
  for(const c of channels)
    posts[c.id] = readFailed(c) ? [] : dedupePosts((checks.posts[c.id] || []).filter(p => p.ts && inWindow(p.ts)));

  /* Count-only data is filed per content date. Pull in any date the window touches — a 24 h
     window straddles two of them for all but one instant of the day. */
  const dates = new Set([contentDate(new Date(from).toISOString(), tz),
                         contentDate(new Date(to).toISOString(), tz)]);
  const countFor = id => {
    for(const d of dates){
      const e = ((checks.counts || {})[d] || {})[id];
      if(e && e.n !== "" && e.n != null) return e;
    }
    return null;
  };

  /* The captions a content channel (Facebook) is matched on. The extension files them in
     checks.captions. The server-side reader (Apify) instead returns whole posts — carrying the very
     same captions — into checks.posts, so when no extension captions exist, the posts' own text IS
     the caption bag. This is what lets Facebook match its drops from the server read alone, with no
     extension involved, while staying on the content side (it still never anchors a drop or accuses
     one of a miss — its unreliable coverage means silence still proves nothing). */
  const bagOf = c => {
    const caps = (checks.captions || {})[c.id] || [];
    if(caps.length) return caps.map(capObj);
    /* only posts that actually carry a caption become the bag — a timestamped but textless post is
       not something to match on, and turning it into an empty caption would read as a failed match
       (a false miss) rather than what it is: nothing to judge by, so the drop stays unknown */
    return (posts[c.id] || []).filter(p => String(p.text || "").trim())
      .map(p => capObj({ text:p.text, thumb:p.thumb, permalink:p.permalink }));
  };

  /* ── channels only a person can answer for ──────────────────────────────
     Viber is the case. It has no public post list, no web client for the extension, and an
     encrypted desktop store — every way of reading it is shut, and no amount of trying changes
     that. The choice is therefore between leaving the channel blank forever and letting the one
     source that does know answer: the person looking at the report, who has Viber on their phone.

     So its cells are tickable. A tick is stored against the drop it belongs to, which is what
     makes this worth more than a number typed into a box — it says *which* content reached the
     channel, drop by drop, exactly like every other row in the matrix. It stays visually distinct
     throughout, because a person's word and a measurement are different kinds of fact and this
     report has never pretended otherwise. */
  const confirmOf = (id, at) => ((checks.confirms || {})[id] || {})[at];
  const confirmsFor = id => Object.values((checks.confirms || {})[id] || {});
  /* Offered only where reading genuinely failed, never as a shortcut around a channel that can be
     read — a tick beside a collector that merely had a bad morning would paper over the outage
     this report exists to surface. */
  const canConfirm = c => !foldsByTime(c) && !posts[c.id].length && !bagOf(c).length && !countFor(c.id);

  /* A content-matched channel is never fallen back to timeline matching, even when it does have
     timestamps. Facebook's timestamps are real for the posts it hands over, but its coverage of a
     window is not — so they can prove a post was made and can never prove one was not. Matching
     on them produced exactly that false alarm: two Pages reported a missing drop that was sitting
     on both of them. With no captions to judge by, the honest answer is that we do not know. */
  /* "confirm" sits last: anything actually collected outranks a hand-tick, so a channel that
     starts reporting for itself is never held back by an old one. */
  const modeOf = c => matchesByContent(c)
    ? (bagOf(c).length ? "content" : (countFor(c.id) ? "count"
       : (confirmsFor(c.id).some(Boolean) ? "confirm" : "none")))
    : foldsByTime(c)
    ? "timefold"          /* Viber is ALWAYS auto: a notification confirms a drop, and any drop it
                             did not is assumed delivered (content goes out to every channel at
                             once). It never needs a hand-tick — the whole point of the phone
                             pipeline is that nothing here is manual. */
    : (posts[c.id].length ? "timeline" : (countFor(c.id) ? "count"
       : (confirmsFor(c.id).some(Boolean) ? "confirm" : "none")));
  const countOf = c => {
    const m = modeOf(c);
    if(m === "count") return Number(countFor(c.id).n);
    if(m === "confirm") return slots.filter(s => confirmOf(c.id, s.at) === true).length;
    return posts[c.id].length;
  };

  /* slots: the same drop reaching each channel a minute or two apart — then any drop that reached
     one of them hours later folded back in, so a late post reads as late rather than as missing */
  /* A channel judged on content contributes its captions, not its clock. Facebook hands over
     posts carrying a real instant but, whenever its payload cannot pair text to timestamps, no
     words at all — and a timestamped, textless post opened a drop of its own that nothing else
     could ever be part of. Every other channel then showed a cross against it: one Page's stray
     post invented a drop and accused eight healthy channels of missing it.

     That is the same false alarm content matching exists to prevent, arriving through a different
     door. Its timestamps were already declared unable to prove absence — so they must not be
     allowed to define what everyone else is measured against either. Content channels are folded
     back into the drops they match, by caption, further down. */
  const all = [];
  for(const c of channels){
    if(matchesByContent(c) || foldsByTime(c)) continue;
    for(const p of posts[c.id]) all.push({ ...p, channelId:c.id });
  }
  const timeline = channels.filter(c => modeOf(c) === "timeline");
  const slots = mergeLate(clusterSlots(all, win)).map(s => {
    const present = [...new Set(s.posts.map(p => p.channelId))];
    return {
      at:s.first, time:hhmm(s.first, tz),
      day:contentDate(s.first, tz),
      present, posts:s.posts,
      missing:timeline.filter(c => present.indexOf(c.id) === -1).map(c => c.id),
      /* the channels the merge pulled back in, and how far behind they were — the lateness is the
         useful half of what folding the slots together would otherwise hide */
      late:(s.lateIds || []).map(id => {
        const p = s.posts.find(q => q.channelId === id);
        return { id, mins:Math.round((new Date(p.ts) - new Date(s.first)) / 60e3) };
      }).filter(l => l.mins > 0),
      kinds:[...new Set(s.posts.map(p => p.kind))],
    };
  });

  /* Only measured evidence sets the target. A suggestion read off a Facebook page may be wrong
     about itself; it must not be able to be wrong about every other channel. */
  const evidence = channels.filter(c => {
    const m = modeOf(c);
    return m === "timeline" || (m === "count" && countFor(c.id).source !== "suggested");
  });
  /* Content-matched channels are deliberately not evidence for the target. They can only ever
     account for drops that some other channel already established, so they can confirm a drop
     but never reveal one — using them would make the target circular.

     Hand-ticked channels are left out for exactly the same reason, and it is not a judgement on
     whether a person is trustworthy: a tick is answered against a drop that already exists, so it
     is structurally incapable of revealing one. A Viber post that went out on a day nothing else
     did would leave no drop to tick, which is a real limit and the honest place to admit it. */
  const expected = evidence.length ? evidence.reduce((m, c) => Math.max(m, countOf(c)), 0) : null;

  /* the caption a drop should have on a channel of this language, for content matching */
  const refFor = (slot, lang) => {
    const texted = slot.posts.filter(p => (p.text || "").trim());
    const same = texted.find(p => detectLang(p.text).lang === lang);
    return same ? same.text : "";
  };

  const alerts = [];
  const rows = channels.map(c => {
    const mode = modeOf(c);
    const meta = checks.meta[c.id] || {};
    const bag = bagOf(c);

    /* one cell per drop, so the matrix can be read straight across a row */
    /* Viber is judged purely by COINCIDENCE with a real drop (see the timefold block below), so it
       needs no pre-computed count here. Its notifications are only ever read against the drops the
       other channels define — the ones that DON'T line up with a drop are Viber's repeat "you have
       a message" reminders, not new posts, and are ignored entirely. */

    /* ── how much of this window the read actually covered ──────────────────
       A cross says "this channel did not post". That claim is only honest for the stretch of time
       the read could actually see, and for a timeline channel that stretch has BOTH ends open:

         · the far end — sources reach back wildly different distances. Telegram hands over about
           twenty posts and YouTube fifteen, which span days; X gives as few as three. If the
           oldest post we hold is itself inside the window, we never looked past it, so a drop
           older than that was never examined.
         · the near end — the read happened at a moment. A drop that went out AFTER we looked
           cannot possibly be in it. This is the one that produced a live false cross: X was read,
           the day's last reel went out afterwards, and the report called it missing.

       Outside that stretch the answer is "not seen", never "✗". Note this only ever DEFERS the
       judgement — the next run reads again with the drop safely inside the covered span and
       judges it normally, so a real miss is delayed, never hidden. */
    const all = checks.posts[c.id] || [];
    const oldestRead = all.reduce((m, p) => Math.min(m, new Date(p.ts).getTime()), Infinity);
    /* content matching sidesteps this entirely — it never depended on covering the window */
    const partial = mode === "timeline" && all.length > 0 && oldestRead > from;
    const readAt = typeof meta.at === "number" ? meta.at
                 : (checks.lastRun ? new Date(checks.lastRun).getTime() : Date.now());
    /* A post is not always visible the instant it is published — feeds propagate, and some readers
       serve a short cache (X's is about ten minutes). Judging right up to the read time would turn
       that lag into a cross, so the last few minutes before the read are given the benefit of the
       doubt too. Kept deliberately small: it defers one run's verdict, nothing more. */
    const SETTLE_MS = 10 * 60e3;
    const coveredFrom = partial ? oldestRead : -Infinity;
    const coveredTo = readAt + SETTLE_MS;
    /* The reader can also say outright that it never saw the whole window — X's timeline is
       virtualised, and when the scroll stops yielding before reaching past the window it reports
       so. An incomplete read cannot prove absence ANYWHERE in the window, not merely before its
       oldest post: X once returned a single tweet and the report crossed the other six drops. */
    const readIncomplete = mode === "timeline" && meta.partialRead === true;
    const outsideRead = at => readIncomplete || at < coveredFrom || at > coveredTo;

    let cells;
    if(mode === "content"){
      /* Matched on words, not time. Only ever against a reference in this channel's own language:
         a drop's Vietnamese and English variants are different text, and letting them match each
         other would make the language check meaningless.

         One caption accounts for at most one drop. Scoring each drop independently let a single
         caption satisfy two of them whenever a day's posts were worded alike — the channel would
         read 2/2 having posted once, and a real miss would pass unnoticed. So: score every pairing,
         take them best-first, and never reuse a caption or fill a drop twice. */
      /* The match is WORD-LEVEL and shown in full, so nothing false can slip through unseen. For
         each drop, against every caption this channel gave, count how many of the drop's words the
         caption actually contains. Templated captions for DIFFERENT fixtures (even the next day's
         same-competition post) share only a handful of words, so they fall well below the bar; the
         SAME post shares nearly all of them. Best pairing wins, one caption per drop, never reused
         — and the winning overlap (matched / total words) rides on the cell so the report can say
         exactly "22 of 27 words matched" or, for a miss, "only 6 of 27 — reel did not go out". */
      const pairs = [];
      slots.forEach((s, i) => {
        const ref = refFor(s, c.lang);
        if(!ref) return;
        bag.forEach((cap, j) => {
          if(differentFixture(ref, cap.text)) return;     // same template, different day → not this drop
          const ov = captionOverlap(ref, cap.text);
          /* Up to CAPTION_SLACK words may differ and the drop still counts as delivered.
             Demanding EVERY word crossed real posts for trivia — a shortened link, a stray "https",
             a tracking suffix like "d6cnqrox" that differs per platform by design. Those are the
             same post, and crossing them buried the real misses in noise.
             The allowance is deliberately a WORD COUNT, not a percentage: a percentage scales with
             caption length, so a long caption could quietly differ in a dozen words and still pass.
             Five is five whether the caption is twelve words or two hundred.
             Nothing inside the allowance passes silently — every imperfect match still raises an
             alert naming the exact words, so a tick that was granted leniently always says so. */
          if(ov.total >= 3 && ov.missing.length <= CAPTION_SLACK) pairs.push({ i, j, ov });
        });
      });
      pairs.sort((a, b) => b.ov.ratio - a.ov.ratio);
      const taken = new Map(), usedCap = new Set();
      for(const p of pairs){
        if(taken.has(p.i) || usedCap.has(p.j)) continue;
        taken.set(p.i, { cap:bag[p.j], ov:p.ov });
        usedCap.add(p.j);
      }
      cells = slots.map((s, i) => {
        const ref = refFor(s, c.lang);
        if(!ref) return { state:"none", post:null, why:"no same-language caption to compare with" };
        const hit = taken.get(i);
        if(hit) return { state:"okc", score:hit.ov.ratio, match:hit.ov,
                         post:Object.assign({ ts:null }, hit.cap) };
        /* the closest SAME-fixture caption came, so a miss carries its own evidence — a caption from
           another day is not "close", it is a different post, so it does not count as the near-miss */
        let best = { ratio:0, matched:0, total:0, missing:[] };
        for(const cap of bag){
          if(differentFixture(ref, cap.text)) continue;
          const ov = captionOverlap(ref, cap.text); if(ov.ratio > best.ratio) best = ov;
        }
        return { state:"miss", score:best.ratio, match:best };
      });
    }else if(mode === "timeline"){
      cells = slots.map(s => {
        const mine = s.posts.filter(p => p.channelId === c.id);
        if(!mine.length){
          /* nothing here from this channel — but only call that a miss if the read could have
             seen it at all (see the coverage note above) */
          const at = new Date(s.at).getTime();
          /* How far away this channel's NEAREST post was. A cross says "nothing here"; this says
             whether nothing means nothing, or means "it went out fourteen minutes later and fell
             outside the ±10 min grouping". Those are completely different faults with completely
             different fixes, and the report could not tell them apart. */
          const near = (posts[c.id] || []).reduce((best, p) => {
            const gap = Math.abs(new Date(p.ts).getTime() - at);
            return (!best || gap < best.gap) ? { gap, ts:p.ts } : best;
          }, null);
          if(outsideRead(at))
            return { state:"unseen", post:null, near,
                     why: readIncomplete
                       ? "the reader could not see the whole window on this channel, so nothing in it can be called missing"
                       : at > coveredTo
                       ? "this drop went out after the channel was last read, so it could not have been seen yet"
                       : `the read reached back only to ${hhmm(new Date(oldestRead).toISOString(), tz)}, so this drop was never examined` };
          return { state:"miss", post:null, near };
        }
        /* Only a caption that is substantially in the wrong language marks the cell. A Vietnamese
           channel carrying an English competition name or a player's name is not an English post,
           and flagging those taught the reader to ignore the symbol. Every mismatch, however small,
           is still reported in the problems list — see langIssues below. */
        const bad = mine.find(p => {
          const d = detectLang(p.text);
          return c.lang && d.lang && d.lang !== c.lang && langFlagged(d);
        });
        /* the drop did arrive here, hours after the rest. Carried onto the cell so the matrix can
           say so on its own — otherwise the summary shows a plain tick and only the drops tab
           knows the post was two hours behind everybody else. */
        const l = (s.late || []).find(x => x.id === c.id);
        return bad ? { state:"lang", post:bad, detected:detectLang(bad.text) }
                   : { state:"ok", post:mine[0], extra:mine.length - 1,
                       lateBy:l ? l.mins : null };
      });
    }else if(mode === "timefold"){
      /* Viber, decided ONE drop at a time, purely by coincidence with the other channels:
           · a notification lands inside this drop's window          → ✓ confirmed (proof it arrived)
           · none does, but the phone was online then                → ⚠ not seen — a likely miss, flag
           · none does, and the phone was offline then               → assumed (dashed ✓), can't verify
         A notification that lines up with NO drop is Viber's repeat "you have a message" reminder,
         re-sent because the phone did not open it — never a new post. Because a drop is confirmed by
         PRESENCE of a nearby notification (not by any running total), those reminders are ignored
         outright: they can neither inflate the count nor hide a real miss. */
      const mine = posts[c.id] || [];
      const beatMs = (checks.beats || []).map(t => new Date(t).getTime()).filter(n => isFinite(n));
      const COVER = 25 * 60e3;             // a heartbeat within 25 min of a drop = phone online then
      const VB_ALIGN = 30 * 60e3;          // Viber notification times drift, so match generously — but a
                                           // notification an hour+ off a drop is a reminder, not that post
      cells = slots.map(s => {
        const start = new Date(s.at).getTime();
        const end = s.posts.reduce((m, p) => Math.max(m, new Date(p.ts).getTime()), start);
        const aligned = mine.some(p => { const t = new Date(p.ts).getTime(); return t >= start - VB_ALIGN && t <= end + VB_ALIGN; });
        if(aligned) return { state:"ok", post:null };
        const online = beatMs.some(b => b >= start - COVER && b <= end + COVER);
        return online ? { state:"maybe", post:null } : { state:"asm", post:null };
      });
    }else{
      /* Nothing collected. For a channel a person can still answer for, each drop carries whatever
         they ticked — yes, no, or not yet looked at — rather than a blank the report can do
         nothing with. `askable` is what turns the cell into a control in the matrix. */
      const askable = canConfirm(c);
      cells = slots.map(s => {
        const v = confirmOf(c.id, s.at);
        if(v === true)  return { state:"okh", post:null, at:s.at, askable };
        if(v === false) return { state:"miss", post:null, byHand:true, at:s.at, askable };
        /* Nobody has answered for this drop, so nothing is known about it. Blank, never a cross —
           and, just as importantly, never scored as one either: see the target below. */
        return { state:"none", post:null, at:s.at, askable };
      });
    }

    /* a content-matched channel's count is how many drops its captions accounted for; a
       time-folded one (Viber), how many drops a notification actually CONFIRMED (landed inside) —
       not how many notifications arrived, so repeat reminders never pad the number */
    const n = mode === "content" ? cells.filter(x => x.state === "okc").length
            : mode === "timefold" ? cells.filter(x => x.state === "ok").length
            : countOf(c);

    /* Language is checkable wherever there are words, whether or not the times are usable. */
    const langIssues = !c.lang ? []
      : mode === "timeline"
        ? posts[c.id].map(p => ({ post:p, d:detectLang(p.text) }))
            .filter(x => x.d.lang && x.d.lang !== c.lang)
        : mode === "content"
          ? bag.map(cap => ({ post:Object.assign({ ts:null }, cap), d:detectLang(cap.text) }))
              .filter(x => x.d.lang && x.d.lang !== c.lang)
        : mode === "count"
          ? (countFor(c.id).texts || []).map(t => ({ post:{ ts:null, text:t }, d:detectLang(t) }))
              .filter(x => x.d.lang && x.d.lang !== c.lang)
          : [];

    /* What this channel can fairly be held to.
       An earlier version of this deducted EVERY blank cell — "unseen" and "none" alike — from the
       target, and that was badly wrong. A count-mode channel has no cells of its own (it falls
       through to the hand-confirm branch, so every drop is "none"), which meant the deduction
       cancelled its entire target: a Facebook count of 5 against 5 drops went from a healthy "5/5"
       to a blank "—", and — far worse — a hand-typed count of 2 against 5 drops stopped reporting
       three missing posts at all. The rule that was supposed to stop the report inventing misses
       started erasing real ones, permanently rather than for one run.
       So the deduction is now narrow and only applies where the reasoning actually holds:
         timeline  one cell per expected post, so a drop the read could not cover (see the coverage
                   note above) genuinely cannot be judged and comes off the target
         confirm   only the drops a person has actually answered can be judged; the rest are not
                   failures, they are unanswered
         count     the number IS the evidence — it does not come from cells at all, so nothing about
                   the cells may touch it
         content   captions are matched against the whole window, never per covered drop */
    const unseenCount = cells.filter(x => x.state === "unseen").length;
    const answered = mode === "confirm"
      ? cells.filter(x => x.state === "okh" || x.state === "miss").length : null;
    const expectedHere = expected === null ? null
      : mode === "confirm" ? answered
      /* clamped at n so removing an unjudgeable drop can never push the target BELOW what was
         actually found and invent an "over" out of a measured, healthy run */
      : mode === "timeline" && unseenCount ? Math.max(n, Math.max(0, expected - unseenCount))
      : expected;

    /* Viber (timefold) never sets anyone's target and is never "over". But it CAN flag a real miss:
       a drop the phone was online for and still forwarded no post reads "review" and raises a
       maybe-alert. A drop the phone was offline for is "assumed", which is not a problem. */
    const maybeAt = mode === "timefold"
      ? cells.map((x, i) => x.state === "maybe" && slots[i] ? slots[i].time : null).filter(Boolean) : [];
    const status = mode === "none" ? "unknown"
      : mode === "timefold" ? (maybeAt.length ? "review" : (n ? "seen" : "unknown"))
      : expectedHere === null ? "notarget"
      /* Nothing here could be judged at all — that is ignorance, not a clean run, and calling it
         "ok" would be as false as calling it short. Guarded by n === 0: a row that demonstrably
         holds n posts knows something, and reporting it as knowing nothing is a contradiction that
         once swallowed a real hand-recorded shortfall. */
      : (expectedHere === 0 && n === 0 && (unseenCount > 0 || mode === "confirm")) ? "unknown"
      : n === expectedHere ? "ok" : n < expectedHere ? "short" : "over";

    if(maybeAt.length)
      alerts.push({ kind:"maybe", id:c.id, name:c.name,
        text:`no Viber post for the ${maybeAt.join(", ")} drop${maybeAt.length === 1 ? "" : "s"} ` +
             `while the phone was online — likely missing, worth a quick check` });

    /* A caption match is a judgement, not a measurement. It credits the drop once enough of its
       words turn up in the caption, and "enough" is CAPTION_MATCH — 60%. So a channel could be
       handed a clean ✓ on a caption that differed in a third of its words, with nothing anywhere
       saying so. That is exactly how a Facebook post that never went out came back delivered on
       sportsfc.vn, while the same day's fans channel was caught only because its wording happened
       to drift further below the bar.

       The threshold still decides the verdict — moving it would turn silent false ticks into
       silent false misses, which is the same disease. What changes is that nothing imperfect is
       allowed to pass quietly: ONE missing word raises this, it sorts above everything else, and
       it names the words that did not match so the reader can settle it by eye rather than trust
       a percentage. A ✓ this alert sits under has not been verified, only estimated. */
    if(mode === "content"){
      cells.forEach((x, i) => {
        const m = x.match;
        if(!m || !m.total || !m.missing || !m.missing.length) return;
        const when = slots[i] ? "the " + slots[i].time + " drop" : "a drop";
        /* capped so one long caption cannot bury the rest of the report, but the count is always
           exact — the cap only limits how many are spelled out */
        const shown = m.missing.slice(0, 15);
        const words = `${m.matched} of ${m.total} words match, ${m.missing.length} ` +
                      `do${m.missing.length === 1 ? "es" : ""} NOT: ${shown.join(", ")}` +
                      (m.missing.length > shown.length ? ` (+${m.missing.length - shown.length} more)` : "");

        /* TICKED, but not on a perfect match. The allowance let it through, so the report says so
           by name: a lenient tick that stayed silent would be indistinguishable from a verified one,
           and the whole point of the allowance is that it is visible rather than free. */
        if(x.state === "okc")
          return alerts.push({ kind:"verify", id:c.id, name:c.name,
            text:`${when} is TICKED but not word-perfect — ${words} · within the ` +
                 `${CAPTION_SLACK}-word allowance, so it counts as delivered — worth a glance in ` +
                 `case the wording drifted` });

        if(x.state !== "miss") return;
        if(m.ratio < CAPTION_NEAR) return;    // a distant miss is just a miss; the missing alert has it
        alerts.push({ kind:"verify", id:c.id, name:c.name,
          text:`${when} is CROSSED — ${words} · that is ${m.missing.length - CAPTION_SLACK} more ` +
               `than the ${CAPTION_SLACK}-word allowance, so it is counted as missing — check by ` +
               `hand and, if it did go out, this is the wording to fix` });
      });
    }

    const missedAt = slots.filter(s => s.missing.indexOf(c.id) !== -1).map(s => s.time);

    /* A gap inside the covered stretch is still reported as a gap — downgrading that would hide
       real misses, which is the whole point of the tool. What is no longer reported as a gap is a
       drop the read could not have seen; those were taken out of the target above and are named
       here instead, so the reader can tell "did not post" from "not looked at yet". */
    if(status === "short"){
      /* For a caption-matched channel (Facebook, Instagram) spell out the evidence the user asked
         for: which drop the reel did not go out on, and exactly how many of the drop's words its
         closest caption actually matched — so a miss is never a bare cross, it shows its working. */
      const wordDetail = mode === "content"
        ? cells.map((x, i) => (x.state === "miss" && slots[i] && x.match && x.match.total)
            ? `${slots[i].time}: reel not found — only ${x.match.matched}/${x.match.total} words matched` : null).filter(Boolean)
        : [];
      /* For a timed channel, say how close its nearest post was to each crossed drop. "nothing at
         19:00" and "nothing at 19:00, though it posted 14 min away" are different faults: the first
         is a post that never went out, the second is one that did and fell outside the grouping
         window. Without this the report kept reporting the second as the first. */
      const nearDetail = mode === "timeline"
        ? cells.map((x, i) => {
            if(x.state !== "miss" || !slots[i]) return null;
            if(!x.near) return `${slots[i].time}: nothing within the whole window`;
            const mins = Math.round(x.near.gap / 60e3);
            return `${slots[i].time}: nearest post ${fmtGap(mins)} away (${hhmm(x.near.ts, tz)})`;
          }).filter(Boolean)
        : [];
      alerts.push({ kind:"missing", id:c.id, name:c.name, partial,
        text:`${expectedHere - n} post${expectedHere - n === 1 ? "" : "s"} missing` +
             (missedAt.length ? ` — nothing at ${missedAt.join(", ")}` : "") +
             (wordDetail.length ? ` · ${wordDetail.join("; ")}` : "") +
             (nearDetail.length ? ` · ${nearDetail.join("; ")}` : "") +
             (partial ? ` · only ${all.length} post(s) could be read here and none predate the ` +
                        `window, so part of it was never seen` : "") });
    }
    /* Not an alarm — a note, so an unjudged drop is never silently mistaken for a clean run */
    if(unseenCount)
      alerts.push({ kind:"unseen", id:c.id, name:c.name,
        text:`${unseenCount} drop${unseenCount === 1 ? "" : "s"} could not be judged here — ` +
             cells.filter(x => x.state === "unseen" && x.why)
                  .map((x, i) => x.why).slice(0, 1).join("") +
             `. It will be checked on the next run rather than counted against this channel.` });
    if(mode !== "none" && !foldsByTime(c) && n > maxPer)
      alerts.push({ kind:"over", id:c.id, name:c.name,
        text:`${n} posts in ${hours}h — over the ${maxPer} you would expect at most` });
    /* EVERY mismatch is listed here, however small — the allowance decides whether the matrix marks
       the cell, never whether the fact is reported. The line says which of the two happened, so a
       reader can tell "this reel went out in the wrong language" from "this caption borrowed a
       couple of English words", without having to count them by eye. */
    for(const x of langIssues){
      const off = offLangWords(x.d), flagged = langFlagged(x.d);
      alerts.push({ kind:"lang", id:c.id, name:c.name,
        /* count-only channels carry captions but no instant, so there is no time to name */
        text:(x.post.ts ? hhmm(x.post.ts, tz) + " post" : "a post") +
             ` looks ${x.d.lang.toUpperCase()} on a ${c.lang.toUpperCase()} channel (${x.d.why})` +
             (flagged
               ? ` · ${off} ${x.d.lang.toUpperCase()} word(s) — past the ${LANG_SLACK}-word allowance, ` +
                 `so this reel is FLAGGED as the wrong language`
               : ` · only ${off} ${x.d.lang.toUpperCase()} word(s), inside the ${LANG_SLACK}-word ` +
                 `allowance — noted here but not flagged on the matrix`),
        post:x.post });
    }
    if(meta.dead)
      alerts.push({ kind:"dead", id:c.id, name:c.name, text:"channel not found — fix the link" });

    return { id:c.id, name:c.name, platform:c.platform, lang:c.lang, mode,
             /* `expected` is what this channel can fairly be held to — drops its read could not
                cover are not part of it, so the badge never reads "3/4" for a drop nobody looked
                at. `expectedAll` keeps the day's full target for anything that needs it. */
             count:n, expected:expectedHere, expectedAll:expected, unseenCount,
             status, cells, langIssues, missedAt, partial,
             suggested: mode === "count" && countFor(c.id).source === "suggested" };
  });

  /* A drop's present/missing lists are built from timestamps, so a content-matched channel never
     appeared in either — the matrix said Facebook got both drops while the drop itself reported
     four channels out of six, and both could not be true. Fold the content verdicts back in now
     that they are known. Kept separate as `byContent` so the report can still say which channels
     were confirmed by caption rather than by time. */
  for(const r of rows){
    /* A drop the channel's read could not cover is not a miss on that drop either. The lists were
       built from timestamps alone, before anything knew how far each read reached, so a channel
       that has just been excused from a cross has to be taken out of the drop's missing list too —
       otherwise the matrix says "not judged" while the drop below it still names the channel as
       one that failed, and only one of the two can be true. */
    r.cells.forEach((cell, i) => {
      const s = slots[i];
      if(!s || cell.state !== "unseen") return;
      const at = s.missing.indexOf(r.id);
      if(at !== -1) s.missing.splice(at, 1);
      (s.unseenBy = s.unseenBy || []).push(r.id);
    });

    /* Viber (timefold) folds in the same way, by time instead of caption: a drop it landed in is
       marked present, but it is NEVER added to `missing` — its silence is not a miss. That is what
       keeps a Viber-only notification from ever inventing a drop or crossing out healthy channels. */
    if(r.mode === "timefold"){
      r.cells.forEach((cell, i) => {
        const s = slots[i];
        if(s && (cell.state === "ok" || cell.state === "asm") && s.present.indexOf(r.id) === -1)
          s.present.push(r.id);
      });
      continue;
    }
    if(r.mode !== "content") continue;
    r.cells.forEach((cell, i) => {
      const s = slots[i];
      if(!s) return;
      if(cell.state === "okc"){
        if(s.present.indexOf(r.id) === -1) s.present.push(r.id);
        (s.byContent = s.byContent || []).push(r.id);
      }else if(cell.state === "miss" && s.missing.indexOf(r.id) === -1){
        s.missing.push(r.id);
      }
    });
  }

  /* A drop that reached a channel hours after the rest is not a miss, but it is not nothing
     either — it is the one thing merging the slots would otherwise bury. Raised once per late
     channel per drop, after the rows exist so it can be named properly. */
  const nameOfCh = id => (channels.find(c => c.id === id) || {}).name || id;
  for(const s of slots)
    for(const l of (s.late || []))
      alerts.push({ kind:"late", id:l.id, name:nameOfCh(l.id),
        text:`the ${s.time} drop landed here at ${hhmm(s.posts.find(p => p.channelId === l.id).ts, tz)}` +
             ` — ${fmtGap(l.mins)} behind the rest` });

  const langs = [...new Set(rows.map(r => r.lang || "—"))].sort();
  /* "verify" leads. Every other alert reports something the report already shows as wrong; this
     one says a ✓ on screen may not be true, which is the failure this tool least survives. */
  const order = { verify:0, dead:1, lang:2, missing:3, over:4, late:5, maybe:6 };
  alerts.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

  return { from:new Date(from).toISOString(), to:new Date(to).toISOString(),
    hours, tz, win, maxPer, expected, slots, rows, langs, alerts,
    sum:{ ok:rows.filter(r => r.status === "ok").length,
          short:rows.filter(r => r.status === "short").length,
          over:rows.filter(r => r.status === "over").length,
          notarget:rows.filter(r => r.status === "notarget").length,
          unknown:rows.filter(r => r.status === "unknown").length } };
}

/* ── all regions on one screen ───────────────────────────────────────────────
   Each region keeps its own schedule of drops, so each is reconciled ON ITS OWN — Brazil is never
   measured against a Vietnam-only drop, nor Vietnam against a Brazil-only one. The results are then
   laid side by side in one report: every drop of every region as a column, in time order, and a
   channel's cell under another region's drop is "na" — not its drop, never counted for or against
   it. Each drop also carries how many channels of ITS region could have had it (cov), so its
   "3/3" counts only those. */
function mergeReports(parts){
  parts = parts.filter(p => p && p.rep && p.rep.rows.length);
  if(parts.length === 1) return parts[0].rep;
  const slots = [];
  for(const p of parts){
    const cov = p.rep.rows.filter(r => r.mode !== "none").length;
    p.rep.slots.forEach((s, i) => slots.push({ ...s, region:p.region, regionName:p.name, cov, _i:i }));
  }
  slots.sort((a, b) => new Date(a.at) - new Date(b.at));
  const rows = [];
  for(const p of parts) for(const r of p.rep.rows) rows.push({ ...r, region:p.region,
    cells:slots.map(s => s.region === p.region ? r.cells[s._i] : { state:"na", post:null }) });
  const langs = [...new Set(parts.flatMap(p => p.rep.langs))];
  const order = { verify:0, dead:1, lang:2, missing:3, over:4, late:5, maybe:6 };
  const alerts = parts.flatMap(p => p.rep.alerts).sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  const first = parts[0].rep;
  const sum = {};
  for(const p of parts) for(const [k, v] of Object.entries(p.rep.sum)) sum[k] = (sum[k] || 0) + v;
  return { ...first, slots, rows, langs, alerts, sum,
    /* one number cannot describe two schedules: null only when no region measured anything */
    expected:parts.every(p => p.rep.expected === null) ? null : parts.map(p => p.rep.expected).find(x => x !== null),
    regions:parts.map(p => ({ id:p.region, name:p.name, expected:p.rep.expected })) };
}
/* ── collection ─────────────────────────────────────────────────────────── */

/* The report is useless without this. An org with four Facebook Pages and two Telegram channels
   produces "MISSING: Telegram, Telegram" if rows are labelled by platform alone — true, and no
   help at all. The handle field is optional in the directory (the tiles fall back to the URL), so
   fall back the same way here and pull the identifier out of the path. */
function chanLabel(s){
  if(s.handle && s.handle.trim()) return s.handle.trim();
  const u = safeUrl(s.url);
  let p = "";
  try{ p = new URL(u).pathname.replace(/^\/+|\/+$/g, ""); }catch(e){}
  p = p.replace(/^s\//, "");                            // t.me/s/<channel>
  const seg = p.split("/").filter(Boolean).pop();
  return seg || pretty(u) || "(no handle)";
}

/* A region is a set of channels that share ONE schedule of drops. Vietnam and English post the same
   drops in two languages; Brazil keeps its own. The report is drawn one region at a time — measured
   against each other's drops, every channel of the other region would read as missing — while a
   press still reads every channel of every region. */
const REGIONS = [["main", "Vietnam & English"], ["br", "Brazil"]];
const regionOf = s => s.region || "main";
/* which region is on screen — "all" (the default) draws every region at once, each judged on its own */
const regionSel = () => (REGIONS.some(r => r[0] === checks.regionView) ? checks.regionView : "all");

function dcChannels(o, region){
  return o.socials.filter(s => !region || regionOf(s) === region).map(s => ({
    id:s.id, platform:s.platform, lang:normLang(s.note), region:regionOf(s),
    name:platform(s.platform).name + " · " + chanLabel(s),
    url:safeUrl(s.url), handle:s.handle || "",
    /* the pinned id wins; a run-resolved one is only there for a channel without one */
    ytChannelId:s.ytChannelId || checks.ytIds[s.id] || undefined,
  }));
}

async function collectServer(o){
  if(!location.protocol.startsWith("http"))
    return toast("Collecting needs the server — run npx vercel dev", "info");

  const chans = dcChannels(o);
  toast(`Collecting ${chans.length} channel(s)…`, "loader");

  /* One request per SLOW channel, one shared request for the fast ones — never a single big batch.
     Facebook, Instagram, TikTok and X are each an Apify run, which cold-starts and can take tens of
     seconds; bundled with the rest, several in one request would push the whole call past the
     server's time limit and take the fast channels (YouTube, Telegram, Viber) down with it — which
     is exactly why a healthy day once showed every server channel as "no data". Split apart, each
     slow channel has its own time budget and a fast channel is never held hostage to it.
     Always pull a little wider than the window on screen (192 h) so a post on the boundary survives. */
  const SLOW = new Set(["facebook", "instagram", "tiktok", "x", "tgbot"]);
  const groups = [];
  const fast = chans.filter(c => !SLOW.has(c.platform));
  if(fast.length) groups.push(fast);
  for(const c of chans.filter(c => SLOW.has(c.platform))) groups.push([c]);

  const one = async batch => {
    try{
      const r = await fetch("api/collect", { method:"POST", headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ channels:batch, hours:192 }) });
      const j = await r.json();
      if(!j.ok) throw new Error(j.error || "collect failed");
      return j;
    }catch(e){ return { ok:false, results:[], error:String(e.message || e), _batch:batch }; }
  };

  const parts = await Promise.all(groups.map(one));

  let added = 0, ok = 0, browser = 0, unreached = 0, collectedAt = null;
  let spent = 0, runs = 0, cachedN = 0, unsettled = 0;
  const runIds = [];
  for(const j of parts){
    if((!j.results || !j.results.length) && j.error){ unreached += (j._batch || []).length; continue; }
    collectedAt = j.collectedAt || collectedAt;
    if(typeof j.apifyCostUsd === "number"){ spent += j.apifyCostUsd; runs += j.apifyRuns || 0; }
    for(const res of j.results){
      const cost = res.cost || null;
      if(cost && cost.cached) cachedN++;
      else if(cost && cost.settled === false) unsettled++;
      if(cost && !cost.cached && cost.runId) runIds.push(cost.runId);
      checks.meta[res.channelId] = { ok:res.ok, note:res.note, source:res.source,
        browserRequired:!!res.browserRequired, unsupported:!!res.unsupported,
        dead:!!res.dead, at:Date.now(),
        cost:cost && !cost.cached ? cost.usd : null, cached:!!(cost && cost.cached),
        /* the name reconcile() reads: an Apify run cut off by its time budget proves no absence */
        partialRead:!!res.partialRead };
      if(res.resolved && res.resolved.ytChannelId) checks.ytIds[res.channelId] = res.resolved.ytChannelId;
      if(res.ok){ ok++; added += mergePosts(res.channelId, res.posts); }
      else if(res.browserRequired) browser++;
    }
  }
  checks.lastRun = collectedAt || new Date().toISOString();

  /* What this press spent on Apify — the sum of each run's own billed figure, never an estimate.
     A press where every Apify channel ran fresh (nothing served from the 15-minute cache, no request
     lost) is what one daily check really costs, and is kept apart as the figure the panel divides
     the remaining credit by; a press that hit the cache would understate it. */
  const usd = Math.round(spent * 1e6) / 1e6;
  if(runs || cachedN){
    /* Apify fills in a run's bill some time after the run stops, so a figure the server could not
       confirm is provisional (it has read low by more than half). It is never taken as the price of
       a check; refreshApifyUsage asks for the same runs again until their bills have settled. */
    const full = !!(runs && !cachedN && !unreached);
    checks.apifyLast = { usd, runs, cached:cachedN, settled:!unsettled, full, ids:runIds, at:new Date().toISOString() };
    if(full && !unsettled) checks.apifyCheckUsd = usd;
  }
  saveChecks();
  toast(`${ok} channel(s) read, ${added} new post(s)`
        + (runs ? ` · Apify $${usd.toFixed(4)} for ${runs} run(s)${unsettled ? " so far — Apify is still settling the bill" : ""}`
                : cachedN ? " · Apify: cached, $0" : "")
        + (browser ? ` · ${browser} need the extension` : "")
        + (unreached ? ` · ${unreached} could not be reached (will use the extension / last read)` : ""),
        ok ? "check-check" : "triangle-alert");
  if(runs && typeof refreshApifyUsage === "function") refreshApifyUsage();
  return ok > 0;
}

/* ── the browser half ────────────────────────────────────────────────────
   The extension reaches the dashboard two ways, and both end up here:
     · its popup writes a run into localStorage on this origin, which absorbBrowserRun picks up
     · its bridge content script answers a request from this page, which hands the run over
       directly — that is what lets one button run both halves instead of two
   No write endpoint and no admin key are involved either way. */

let extReady = false;                       // set when the bridge announces itself
/* The bridge has always announced its version and the page has always discarded it. Knowing it
   matters more than it looks: the extension lives in the browser, not in this deployment, so a fix
   shipped here does nothing until that copy is reloaded — and "is the new code actually loaded?"
   was otherwise unanswerable from the report. EXT_WANT is the version this build expects. */
const EXT_WANT = "1.13.0";
/* The channels read through Apify server-side — and by the extension only when that read fails
   (credit used up, token not set). ONE list, used both to decide what to ask the extension for and
   to describe the split in the panel; keeping two copies is what once let the panel claim X was a
   server channel and forget TikTok entirely. */
const EXT_PLATFORMS = ["facebook", "instagram", "x", "tiktok"];

/* This month's Apify credit, from /api/apify-usage (read-only; it never starts a run). Fetched when
   the report opens and again after a press that spent something, then the open report repaints.

   It also settles the last press's bill. Apify fills a run's bill in some time after the run stops
   — a press measured at $0.098 first read $0.045 — so while the last press is still provisional its
   run ids are sent along, and once every run's bill has settled the press's cost is replaced with
   the exact sum. Retried with a growing gap (20 s, 40 s, … ~5 min in all) until it has. */
let apifyInfo = null;
let apifySettleTimer = null;
async function refreshApifyUsage(attempt){
  if(!location.protocol.startsWith("http")) return;
  const n = attempt || 0;
  const last = checks.apifyLast;
  const pending = last && last.settled === false && Array.isArray(last.ids) && last.ids.length ? last : null;
  try{
    const r = await fetch("api/apify-usage" + (pending ? "?runs=" + encodeURIComponent(pending.ids.join(",")) : ""));
    apifyInfo = await r.json();
  }catch(e){ apifyInfo = { ok:false, error:String(e.message || e) }; }

  if(pending){
    const st = (apifyInfo && apifyInfo.settle) || [];
    const done = st.length === pending.ids.length && st.every(s => !s.error && s.settled);
    /* matched by press time, not object identity — a cloud pull may have replaced checks since */
    if(done && checks.apifyLast && checks.apifyLast.at === pending.at){
      const usd = Math.round(st.reduce((t, s) => t + (s.usd || 0), 0) * 1e6) / 1e6;
      checks.apifyLast = { ...pending, usd, settled:true };
      if(pending.full) checks.apifyCheckUsd = usd;
      saveChecks();
    }else if(!done && n < 5){
      clearTimeout(apifySettleTimer);
      apifySettleTimer = setTimeout(() => refreshApifyUsage(n + 1), 20000 * (n + 1));
    }
  }
  if(dcRedraw){ try{ dcRedraw(); }catch(e){} }
}
let extVersion = null;
const extStale = () => !!(extVersion && extVersion !== EXT_WANT);
const extWaiters = new Map();               // request id -> resolve
let extSeq = 0;

addEventListener("message", ev => {
  if(ev.source !== window) return;
  const m = ev.data;
  if(!m || typeof m !== "object") return;
  if(m.__aiko === "ready"){ extReady = true; if(m.version) extVersion = String(m.version); return; }
  if(m.__aiko === "progress"){ if(m.text) toast(m.text, "loader"); return; }
  /* One channel, finished and handed over mid-run. Filed immediately and on its own, so the run's
     deadline can no longer destroy work that was already done: a slow or unreachable channel used
     to take every successfully-read channel down with it when the wait ran out — which is how a
     healthy Facebook read went blank because of TikTok. Whatever arrives is banked. */
  if(m.__aiko === "partial"){
    if(m.result && m.result.channelId){
      absorbRun({ collectedAt:new Date().toISOString(), results:[m.result] });
      if(dcRedraw){ try{ dcRedraw(); }catch(e){ /* a repaint failing must not lose the data */ } }
    }
    return;
  }
  if(m.__aiko === "result"){
    const done = extWaiters.get(m.id);
    if(done){ extWaiters.delete(m.id); done(m); }
  }
});
/* the bridge may have loaded before this listener existed, so ask */
try{ postMessage({ __aiko:"request", action:"ping" }, location.origin); }catch(e){}

/* Roughly what each platform can cost the extension in the worst case: Facebook opens several
   entry points and scrolls each until the captions stop coming, Instagram may fall back from its
   API to a full page navigation per account, X renders a real tab, TikTok is a short reachability
   probe. A flat budget gave six channels the same allowance as one, which is how the wait came to
   expire mid-run in the first place. */
const EXT_COST_MS = { facebook:110000, instagram:95000, x:90000, tiktok:35000 };
const extBudget = channels => 45000 +
  channels.reduce((t, c) => t + (EXT_COST_MS[c.platform] || 30000), 0);

function askExtension(channels, timeoutMs){
  return new Promise(resolve => {
    const id = "r" + (++extSeq);
    const timer = setTimeout(() => {
      /* Give up WAITING, but never stop listening. The waiter used to be deleted here, so when the
         extension finally answered — carrying every channel it had read, Facebook included — the
         page looked the id up, found nothing, and dropped the whole run on the floor. The caller
         is released so the UI is not stuck, and a late reply is still absorbed when it lands. */
      extWaiters.set(id, m => {
        extWaiters.delete(id);
        if(m && m.ok && m.run){
          const n = absorbRun(m.run);
          toast(`the extension finished late — filed ${n} late result(s)`, "check-check");
          if(dcRedraw){ try{ dcRedraw(); }catch(e){} }
        }
      });
      resolve({ ok:false, late:true,
                error:"the extension is still working — whatever it has already read has been filed, " +
                      "and the rest will be filed when it finishes" });
    }, timeoutMs || extBudget(channels || []));
    extWaiters.set(id, m => { clearTimeout(timer); extWaiters.delete(id); resolve(m); });
    postMessage({ __aiko:"request", action:"collect", id, channels }, location.origin);
  });
}

function absorbBrowserRun(){
  let run = null;
  try{ run = JSON.parse(localStorage.getItem(BRUN) || "null"); }catch(e){}
  if(!run || !Array.isArray(run.results)) return 0;
  localStorage.removeItem(BRUN);
  return absorbRun(run);
}

function absorbRun(run){
  if(!run || !Array.isArray(run.results)) return 0;
  let added = 0, counted = 0;
  const today = contentDate(run.collectedAt || new Date().toISOString(), checks.tz);
  for(const res of run.results){
    checks.meta[res.channelId] = { ok:res.ok, note:res.note, source:res.source,
      dead:!!res.dead, suggested:!!res.suggested, at:Date.now(),
      /* the reader itself saying it could not see the whole window — see reconcile */
      partialRead:!!res.partialRead,
      /* what each Facebook route answered — the only way to work out a failure from a pasted
         report, since none of those routes can be reached from outside this browser */
      routeLog:res.routeLog || null };
    /* Captions are kept whether or not the timestamps were usable — Facebook is matched on what
       its posts said, so the bag is the useful part and arrives even when the dates do not. */
    if(res.captions && res.captions.length){
      /* Captions arrive as objects carrying the banner and whatever else the post gave up, but
         older runs stored plain strings — accept both, and let a later run fill in fields an
         earlier one lacked rather than replacing what is already known. */
      const have = (checks.captions[res.channelId] || []).map(capObj);
      const byKey = new Map(have.map(c => [normText(c.text), c]));
      for(const raw of res.captions){
        const c = capObj(raw);
        if(!c.text) continue;
        const k = normText(c.text);
        const had = byKey.get(k);
        if(!had) byKey.set(k, c);
        else for(const f in c) if(c[f] && !had[f]) had[f] = c[f];
      }
      checks.captions[res.channelId] = [...byKey.values()].slice(0, 60);
    }

    if(res.posts && res.posts.length){ added += mergePosts(res.channelId, res.posts); }
    else if(res.ok && typeof res.todayCount === "number"){
      /* Facebook prints a relative time per post rather than an instant, so the extension
         classifies today against not-today and sends the today count. Filed against the run's
         own day and flagged suggested, which keeps it out of the expected-count inference until
         it is confirmed. A run that could not read most of the dates sends nothing at all —
         a blank asking to be filled is better than a number that looks measured. */
      /* A page that never finished loading has nothing to say. Filing its zero would put
         "0/2 — 2 posts missing" against a channel nobody has actually looked at, which is the one
         kind of wrong this report must never be. Same for a page whose dates could not be read. */
      const unreadable = res.stillLoading ||
        res.unknownCount > res.todayCount + (res.visibleCount - res.todayCount - res.unknownCount);
      if(!unreadable){
        checks.counts[today] = checks.counts[today] || {};
        const prev = checks.counts[today][res.channelId];
        if(!prev || prev.source === "suggested"){
          /* Facebook gives no timestamp to match a drop against, but it does give the words —
             so the language check still works even where slot matching cannot. */
          checks.counts[today][res.channelId] = { n:res.todayCount, source:"suggested",
                                                  texts:(res.todayTexts || []).slice(0, 12) };
          counted++;
        }
      }
    }
  }
  checks.lastRun = run.collectedAt || checks.lastRun;
  saveChecks();
  if(added || counted) toast(`Extension: ${added} post(s), ${counted} suggested count(s)`, "chrome");
  return added + counted;
}

/* One press for everything — the server reads every channel (YouTube and Telegram free; Facebook,
   Instagram, X and TikTok through Apify), and the extension is asked only for whichever of those
   the server could not read. Only the open organization's channels are sent, so a directory with
   several orgs never has the wrong pages opened. If the extension is not installed the report
   simply says which channels are still waiting. */
async function runEverything(o){
  await collectServer(o);

  /* anything the popup left behind still counts */
  absorbBrowserRun();

  /* The extension is the FALLBACK for Facebook, Instagram, X and TikTok — asked for a channel only
     when the server's Apify read failed (credit used up, token not set, a profile it cannot see). A server
     success (meta.ok) is left alone. The extension gives Facebook captions without a reliable
     per-post time, so the content match below is deliberately strict and WORD-LEVEL: a drop is only
     credited to a channel when most of the drop's words appear in that channel's caption — a stale,
     same-topic caption from another day no longer matches, and the report shows exactly how many
     words matched so a false "delivered" cannot slip through unseen. */
  const srvFailed = id => { const m = checks.meta[id]; return !m || !m.ok; };
  const browserChans = dcChannels(o)
    .filter(c => EXT_PLATFORMS.indexOf(c.platform) !== -1 && srvFailed(c.id))
    .map(c => ({ id:c.id, platform:c.platform, url:c.url,
                 handle:(c.handle || "").replace(/^@/, "").trim(),
                 username:(c.handle || "").replace(/^@/, "").trim() || chanLabelFromUrl(c.url) }));

  if(!browserChans.length) return;

  /* The bridge is injected at document_idle, so it can still be arriving when the modal opens.
     Ping and give it a moment before concluding it is not installed. */
  if(!extReady){
    postMessage({ __aiko:"request", action:"ping" }, location.origin);
    await new Promise(r => setTimeout(r, 700));
  }
  if(!extReady){
    const kinds = [...new Set(browserChans.map(c => platform(c.platform).name))].join(", ");
    toast(`Extension not detected — ${kinds} ${browserChans.length === 1 ? "was" : "were"} skipped`, "triangle-alert");
    return;
  }

  toast(`Asking the extension for ${browserChans.length} channel(s)…`, "loader");
  const res = await askExtension(browserChans);
  if(!res.ok){
    /* A run that overran its budget is not a failed run. Each channel was filed as it arrived, and
       a late reply is still absorbed when it lands, so this is a note rather than an alarm — it
       used to be the point at which every already-collected channel was thrown away. */
    toast("Extension: " + (res.error || "failed"), res.late ? "loader" : "triangle-alert");
    return;
  }
  absorbRun(res.run);
}

/* the username the platform knows this channel by, from its URL */
function chanLabelFromUrl(u){
  let p = "";
  try{ p = new URL(safeUrl(u)).pathname.replace(/^\/+|\/+$/g, ""); }catch(e){}
  return (p.split("/")[0] || "").replace(/^@/, "");
}

/* ── report UI ──────────────────────────────────────────────────────────── */
const TZS = [[0, "UTC"], [7, "UTC+7 · Vietnam / Thailand"], [8, "UTC+8 · China"], [5.5, "UTC+5:30 · India"],
             [-3, "UTC−3 · Brazil"]];
/* Calendar days first, because "how many went out today" is the question actually being asked and
   a rolling 24 h cannot answer it — at midday it straddles two dates. The rolling spans stay for
   looking across a boundary. */
const WINDOWS = [["today", "today"], ["yesterday", "yesterday"], ["date", "pick a date…"],
                 ["24", "last 24 hours"], ["48", "last 48 hours"], ["168", "last 7 days"]];

/* the selector's value turned into what reconcile needs */
function windowOpt(){
  const w = String(checks.window || "today");
  const tz = Number(checks.tz) || 0;
  if(w === "today")     return { mode:"day", date:contentDate(new Date().toISOString(), tz) };
  if(w === "yesterday") return { mode:"day", date:contentDate(new Date(Date.now() - 86400e3).toISOString(), tz) };
  if(w === "date")      return { mode:"day", date:checks.date || contentDate(new Date().toISOString(), tz) };
  return { mode:"roll", hours:Number(w) || 24 };
}
const tzLabel = tz => (TZS.find(t => t[0] === Number(tz)) || [0, "UTC+" + tz])[1];

/* A finished day covers all of it; one still running stops at now. Saying "00:00–00:00" for the
   first reads as an empty window. */
function dayRange(rep){
  const spanH = (new Date(rep.to) - new Date(rep.from)) / 3600e3;
  return spanH >= 23.9 ? "the whole day"
    : `00:00–${hhmm(rep.to, rep.tz)} so far`;
}
const fmtWhen = (iso, tz) => contentDate(iso, tz) + " " + hhmm(iso, tz);
const hhmmss = (iso, tz) => new Date(new Date(iso).getTime() + (tz || 0) * 3600e3)
  .toISOString().slice(11, 19);

const CELL = {
  ok:   { g:"✓", cls:"ok",   t:"posted" },
  /* matched on what the caption said rather than when it appeared — marked apart so a content
     match is never mistaken for a timed one */
  okc:  { g:"≈", cls:"okc",  t:"the same content is on this channel, matched by caption" },
  /* ticked by a person, for a channel nothing can read. A tick, because the post did go out — but
     never the same tick as a measured one. */
  okh:  { g:"✓", cls:"okh",  t:"confirmed by hand — nothing can read this channel automatically" },
  /* Viber posts alongside every other channel but cannot be read on its own, so a drop that reached
     the rest is assumed to have reached Viber too — a dashed ✓ that a forwarded notification, when
     one arrives, turns into a firm ✓. Never a ✗: a miss here cannot be proven, so it is never invented. */
  asm:  { g:"✓", cls:"okc",  t:"assumed delivered — the phone was offline at this drop, so Viber could not be verified; posted alongside the others" },
  /* Viber only: the phone WAS online at this drop but forwarded no post — a likely real miss,
     flagged for a quick check rather than assumed away or called a hard cross. */
  maybe:{ g:"?", cls:"maybe", t:"no Viber post seen while the phone was online — likely missing, worth verifying" },
  miss: { g:"✗", cls:"miss", t:"nothing posted in this drop" },
  lang: { g:"⚠", cls:"lang", t:"posted, but the caption is in the wrong language" },
  none: { g:"·", cls:"none", t:"no data for this channel" },
  /* The drop falls outside what this channel's read could see — it went out after the channel was
     last read, or further back than the read reached. Deliberately NOT a cross: the read never
     looked here, so it has nothing to say, and saying "missing" would be inventing a fact. The
     next run judges it normally. */
  unseen:{ g:"·", cls:"none", t:"outside what this channel's read covered — not judged, and not counted against it" },
  /* the all-regions view: a drop of ANOTHER region — this channel keeps its own schedule */
  na:{ g:"–", cls:"na", t:"another region's drop — this channel keeps its own schedule, so it is not judged here" },
};

const nn = v => (v === null || v === undefined || v === "" ? "—" : v);
const compact = n => n === null || n === undefined ? "—"
  : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n);
/* Facebook reports counts as the strings it printed ("1.2K"); everywhere else they are numbers.
   Shortening only the numbers keeps both readable instead of dropping the string form. */
const num2 = v => v == null || v === "" ? "—" : (typeof v === "number" ? compact(v) : String(v));
const dur = s => s === null || s === undefined ? "—"
  : s >= 60 ? Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s" : s + "s";
const clean = t => String(t || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
/* Thumbnails are drawn through this site (api/thumb): Instagram's image CDN tells browsers not to
   draw its pictures on any other site, so linked directly they came out blank. A picture that still
   fails (a signed link that has expired) is removed rather than left as a broken-image icon. */
const thumbSrc = u => /^https:\/\//i.test(String(u || "")) && location.protocol.startsWith("http")
  ? "api/thumb?u=" + encodeURIComponent(u) : String(u || "");

/* ── downloadable report card ────────────────────────────────────────────────
   A small, self-contained PNG of the day's check: every channel, each drop, what went out (a short
   caption), and which channel is missing which — a card you can save or share after a run. Drawn as
   pure SVG (no library) and rasterised through a canvas, so it works offline and taints nothing. */
const CARD_COLOR = { ok:"#3fb950", okc:"#2dd4bf", okh:"#3fb950", asm:"#2dd4bf",
                     maybe:"#e3b341", miss:"#f85149", lang:"#e3b341", none:"#6e7681",
                     unseen:"#6e7681" };
function downloadReportCard(rep, o, wo){
  try{
    const tz = rep.tz, slots = rep.slots, rows = rep.rows;
    const W = 860, P = 34, colW = 40, badgeW = 74;
    const gx = W - P - badgeW - slots.length * colW;   // where the per-drop glyph columns begin
    const centre = i => gx + i * colW + colW / 2;
    const esT = (x, y, s, o2) => { o2 = o2 || {};
      return `<text x="${x}" y="${y}" font-family="'Segoe UI',Roboto,Arial,sans-serif" ` +
        `font-size="${o2.size || 15}" fill="${o2.fill || '#e6edf3'}" font-weight="${o2.weight || 400}" ` +
        `text-anchor="${o2.anchor || 'start'}" opacity="${o2.op == null ? 1 : o2.op}">${esc(s)}</text>`; };
    const trunc = (s, n) => { s = String(s || ""); const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join("") + "…" : s; };
    const deliveredIn = i => rows.filter(r => ["ok","okc","okh","asm"].indexOf((r.cells[i]||{}).state) !== -1).length;
    const snip = s => { const t = (s.posts || []).map(p => clean(p.text || "")).find(x => x && x.length > 3) || ""; return trunc(t, 84); };

    const el = [];
    let y = P + 8;

    /* header */
    el.push(esT(P, y + 20, o.name || "SportsFC", { size: 30, weight: 800 }));
    const problems = rep.alerts.length;
    const pillC = problems ? "#f85149" : "#3fb950", pillBg = problems ? "#3a1113" : "#0f2a17";
    const pillTxt = problems ? problems + (problems === 1 ? " problem" : " problems") : "All clear";
    const pillW = 26 + pillTxt.length * 8.4;
    el.push(`<rect x="${W - P - pillW}" y="${y}" width="${pillW}" height="30" rx="15" fill="${pillBg}" stroke="${pillC}" stroke-opacity="0.5"/>`);
    el.push(esT(W - P - pillW / 2, y + 20, pillTxt, { size: 14, weight: 700, fill: pillC, anchor: "middle" }));
    y += 30;
    const when = wo.mode === "day" ? (wo.date || "") + "  ·  " + hhmm(rep.from, tz) + "–" + hhmm(rep.to, tz)
               : hhmm(rep.from, tz) + " → " + hhmm(rep.to, tz);
    el.push(esT(P, y + 16, "Daily check  ·  " + when + "  ·  " + tzLabel(tz), { size: 13.5, fill: "#8b949e" }));
    y += 34;
    el.push(`<line x1="${P}" y1="${y}" x2="${W - P}" y2="${y}" stroke="#21262d"/>`);
    y += 24;

    /* what went out — a short caption per drop */
    if(slots.length){
      el.push(esT(P, y + 12, "WHAT WENT OUT", { size: 12, weight: 700, fill: "#8b949e" }));
      y += 26;
      slots.forEach((s, i) => {
        el.push(esT(P, y + 13, hhmm(s.at, tz), { size: 14, weight: 700, fill: "#58a6ff" }));
        el.push(esT(P + 66, y + 13, deliveredIn(i) + "/" + rows.length, { size: 12.5, weight: 600, fill: "#8b949e" }));
        el.push(esT(P + 120, y + 13, snip(s) || "—", { size: 13.5, fill: "#c9d1d9" }));
        y += 24;
      });
      y += 8;
      el.push(`<line x1="${P}" y1="${y}" x2="${W - P}" y2="${y}" stroke="#21262d"/>`);
      y += 22;
    }

    /* column headers: the drop times over each glyph column, + Total */
    slots.forEach((s, i) => el.push(esT(centre(i), y + 10, hhmm(s.at, tz), { size: 11.5, weight: 600, fill: "#8b949e", anchor: "middle" })));
    el.push(esT(W - P, y + 10, "TOTAL", { size: 11.5, weight: 600, fill: "#8b949e", anchor: "end" }));
    y += 24;

    /* channels, grouped by language */
    const LGNAME = { vi: "Vietnamese", en: "English", th: "Thai", zh: "Chinese", pt: "Portuguese", "—": "Other" };
    for(const lg of rep.langs){
      const group = rows.filter(r => (r.lang || "—") === lg);
      if(!group.length) continue;
      el.push(esT(P, y + 12, (LGNAME[lg] || lg).toUpperCase() + "  ·  " + group.length, { size: 11.5, weight: 700, fill: "#6e7681" }));
      y += 26;
      for(const r of group){
        el.push(esT(P, y + 14, trunc(r.name, 34), { size: 14.5, weight: 500 }));
        r.cells.forEach((c, i) => {
          const st = c.state || "none", col = CARD_COLOR[st] || "#6e7681", g = (CELL[st] || CELL.none).g;
          el.push(esT(centre(i), y + 15, g, { size: 16, weight: 700, fill: col, anchor: "middle" }));
        });
        /* total badge */
        let tot, tc;
        if(r.mode === "timefold"){ tot = r.count + "/" + slots.length + " ✓"; tc = r.cells.some(x => x.state === "maybe") ? "#e3b341" : "#2dd4bf"; }
        else if(r.mode === "none" || r.status === "unknown"){ tot = "—"; tc = "#6e7681"; }
        else if(r.expected == null){ tot = String(r.count); tc = "#8b949e"; }
        else { tot = r.count + "/" + r.expected; tc = r.status === "ok" ? "#3fb950" : r.status === "short" ? "#f85149" : "#e3b341"; }
        el.push(esT(W - P, y + 14, tot, { size: 13.5, weight: 700, fill: tc, anchor: "end" }));
        y += 27;
      }
      y += 8;
    }

    /* legend + footer */
    y += 6;
    el.push(`<line x1="${P}" y1="${y}" x2="${W - P}" y2="${y}" stroke="#21262d"/>`);
    y += 22;
    el.push(esT(P, y + 8, "✓ posted    ≈ same content    ✗ missing    ⚠ wrong language    ? verify    · no data",
      { size: 12, fill: "#8b949e" }));
    y += 24;
    el.push(esT(P, y + 8, "Generated " + new Date().toLocaleString(), { size: 11.5, fill: "#6e7681" }));
    y += 26;

    const H = y + P - 8;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<rect width="${W}" height="${H}" rx="20" fill="#0d1117"/>` +
      `<rect x="0" y="0" width="${W}" height="5" fill="url(#g)"/>` +
      `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#a6171b"/><stop offset="1" stop-color="#e31f24"/></linearGradient></defs>` +
      el.join("") + `</svg>`;

    const scale = 2;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = W * scale; canvas.height = H * scale;
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(b => {
        if(!b) return toast("Could not build the image", "triangle-alert");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = "sportsfc-daily-" + (wo.date || contentDate(rep.to, tz)) + ".png";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast("Report card downloaded", "check-check");
      }, "image/png");
    };
    img.onerror = () => toast("Could not render the card — try again", "triangle-alert");
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
  }catch(e){ toast("Download failed: " + (e.message || e), "triangle-alert"); }
}


/* ── what the React app uses ── */
/* change the report (a control, a hand-confirmed cell, a typed count), save it, redraw */
function update(fn){ fn(checks); saveChecks(); render(); }
/* Delete report: posts, counts and notes go; answers a person gave (confirms) and pinned ids stay */
function resetReport(){
  checks = { posts:{}, counts:{}, captions:{}, meta:{}, ytIds:checks.ytIds,
             confirms:checks.confirms || {}, tz:checks.tz, win:checks.win,
             window:checks.window, date:checks.date, maxPer:checks.maxPer, lastRun:null,
             regionView:checks.regionView, apifyLast:checks.apifyLast, apifyCheckUsd:checks.apifyCheckUsd };
  try{ localStorage.removeItem(BRUN); }catch(e){}
  saveChecks(); render();
}
function pendingBrowserRuns(){
  try{ const p = JSON.parse(localStorage.getItem(BRUN) || "null"); return p && Array.isArray(p.results) ? p.results.length : 0; }
  catch(e){ return 0; }
}
async function boot(){
  try{ await pull(); }catch(e){ cloud.mode = "local"; }
  await pullReport();
  absorbBrowserRun();
  render();
}

return {
  get checks(){ return checks; }, get cloud(){ return cloud; }, get apifyInfo(){ return apifyInfo; },
  get extReady(){ return extReady; }, get extVersion(){ return extVersion; }, extStale, EXT_WANT, EXT_PLATFORMS,
  SPORTSFC, DEF_PLATFORMS, platform, safeUrl, pretty, chanLabel, REGIONS, regionOf, regionSel, dcChannels,
  reconcile, mergeReports, detectLang, normLang, contentDate, hhmm, hhmmss, fmtWhen, fmtGap, dayRange,
  windowOpt, tzLabel, TZS, WINDOWS, CELL, compact, num2, dur, clean, thumbSrc,
  collectServer, runEverything, absorbBrowserRun, refreshApifyUsage, downloadReportCard,
  saveChecks, update, resetReport, pendingBrowserRuns, boot,
};
}
