/**
 * POST /api/collect  { channels:[{id,platform,url,handle,ytChannelId?}], days? }
 *   -> { ok, collectedAt, results:[ { channelId, platform, source, ok, posts:[…], note, resolved } ] }
 *
 * Reads the recent post list of every channel, server-side:
 *
 *   youtube   — the official Data API when YOUTUBE_API_KEY is set, else the channel page (free)
 *   telegram  — t.me/s/<channel>, the server-rendered preview Telegram ships for public channels (free)
 *   facebook  — Apify (apify/facebook-posts-scraper)        } paid per post returned, needs
 *   instagram — Apify (apify/instagram-post-scraper)        } APIFY_TOKEN; each result carries
 *   tiktok    — Apify (clockworks/tiktok-scraper)           } its own exact cost — see the Apify
 *   x         — Apify (xquik/x-tweet-scraper), then twitterapi.io, then the free page read
 *   tgbot     — a Telegram user-session reading the bot's DMs (TG_SESSION)
 *   viber     — nothing to read: no public post list, no web client, and an encrypted local
 *               store. So it is pushed in instead — whatever publishes to Viber posts to
 *               /api/ingest and this reads that back. See ingest-store.js.
 *
 * A channel that fails comes back ok:false with a note. One dead channel must never take the
 * others down with it, because the whole point is spotting the one channel that is behaving
 * differently from the rest.
 *
 * No npm packages — same constraint as the rest of api/. XML and HTML are pulled apart with
 * regexes, which is safe here because we only ever read a handful of well-known attributes.
 */

const ingest = require("../ingest-store.js");

const TIMEOUT = 12000;
const MAX_CHANNELS = 40;
const DEFAULT_DAYS = 8;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* the public web app id instagram.com sends on its own profile requests */
const IG_APP_ID = "936619743392459";

/* ═══════════════════ fetch helper ═══════════════════ */

async function once(url, extraHeaders, timeout) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: Object.assign({ "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, extraHeaders || {}),
    });
    return { status: r.status, body: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

/* Retried once, with a longer leash. A blip must not be allowed to look like an empty channel:
   the report would then say a post never went out when in truth it was never fetched.
   Two kinds of blip qualify. A connection that fails outright — t.me answers in about three
   seconds but does spike. And a server that answers but says it is having trouble: YouTube's feed
   endpoint hands back 500 intermittently for a channel that is perfectly fine, which cost this a
   channel until it was caught. A 404 or a 403 is a real answer about a real state and is reported
   as it stands; 429 and 5xx are the server asking to be asked again. */
const RETRY_STATUS = [429, 500, 502, 503, 504, 522, 524];

async function get(url, extraHeaders, alsoRetry) {
  const retryable = s => RETRY_STATUS.indexOf(s) !== -1 ||
                         (alsoRetry && alsoRetry.indexOf(s) !== -1);
  let first = null;
  try {
    first = await once(url, extraHeaders, TIMEOUT);
    if (!retryable(first.status)) return first;
  } catch (err) { /* fall through to the retry */ }

  await new Promise(r => setTimeout(r, 700));
  try {
    const second = await once(url, extraHeaders, TIMEOUT * 2);
    /* if the retry is no better, the first answer is the one to report */
    if (!retryable(second.status) || !first) return second;
    return first;
  } catch (err2) {
    if (first) return first;
    const aborted = err2 && (err2.name === "AbortError" || /abort/i.test(String(err2)));
    throw new Error(aborted
      ? `No answer from ${new URL(url).hostname} after two tries — treat this channel as unknown, not empty`
      : `Could not reach ${new URL(url).hostname}: ${err2.message || err2}`);
  }
}

/* ═══════════════════ Apify ═══════════════════ */
/* Facebook, Instagram, TikTok and X are all read through Apify, which runs a scraper ("actor") on
   its own infrastructure and hands back a dataset. Every one of those platforms refuses a plain fetch
   from a datacenter IP, and a headless browser running on Vercel itself was tried (2026-10-01) and
   was refused too — every attempt quietly fell back to Apify.

   All four actors bill PER EVENT (per post returned, plus a $0.001 start fee for some), never per
   minute, so the run options below exist to bound SPEND and to stay under the free plan's 8 GB
   concurrent-memory cap, not to save compute:
     · memory is pinned per actor. Their defaults add up to 14.6 GB for one daily check, and the
       dashboard fires every slow channel in parallel — the free plan refuses whichever run would
       cross 8 GB, which reads as a channel that "could not be read" for no visible reason.
     · maxTotalChargeUsd caps what any single run may cost, so a misbehaving actor cannot drain the
       month's credit in one click.
     · a run that overruns the time budget is aborted (billing stops) and whatever it had already
       pushed is still used — those items were paid for.
   Runs are started asynchronously rather than through run-sync so the run id is known, which is
   what lets every result report its own exact cost, read back from Apify's own run record.

   How many posts each run asks for is the single knob that sets the cost of a daily check:
   APIFY_MAX_POSTS (default 6) — about two days at SportsFC's ~3 posts per channel per day, which
   covers the "today" and "yesterday" windows. No actor's date filter is used: on Facebook and
   TikTok it is a paid add-on, and on all of them an EMPTY filtered result cannot tell "posted
   nothing" from "the scraper got nothing" — the newest N posts let the report see that for itself. */
const APIFY_API = "https://api.apify.com/v2";
const APIFY_BUDGET_MS = 95000;          // run + dataset read; vercel.json gives api/collect 120 s
const APIFY_MAX_POSTS = Math.max(1, Math.min(50, Math.floor(Number(process.env.APIFY_MAX_POSTS)) || 6));

/* Free-plan ("FREE" tier) event prices, read from each actor's own pricing on 2026-10-02 — used only
   to set a per-run spending cap at twice the expected charge. The cost actually REPORTED for a run
   is Apify's own figure from the run record, never this estimate.
     minCap    — the lowest maxTotalChargeUsd the actor accepts (its minimalMaxTotalChargeUsd). The
                 TikTok actor refuses to start below $0.50 outright; that is only a ceiling, the run
                 is still billed per video.
     itemEvent — the event the actor bills once per dataset item; how a settled run is recognised. */
const APIFY_ACTORS = {
  instagram: { id: "apify~instagram-post-scraper", memory: 512,  start: 0,     perPost: 0.0017,  minCap: 0.005,  itemEvent: "post" },
  facebook:  { id: "apify~facebook-posts-scraper", memory: 2048, start: 0.001, perPost: 0.005,   minCap: 0.0062, itemEvent: "post" },
  tiktok:    { id: "clockworks~tiktok-scraper",    memory: 2048, start: 0.001, perPost: 0.0037,  minCap: 0.5,    itemEvent: "result" },
  x:         { id: "xquik~x-tweet-scraper",         memory: 256,  start: 0,     perPost: 0.00015, minCap: 0,      itemEvent: "apify-default-dataset-item" },
};
const apifyExpectedUsd = platform => {
  const a = APIFY_ACTORS[platform];
  return a.start + a.perPost * APIFY_MAX_POSTS;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TERMINAL = /^(SUCCEEDED|FAILED|ABORTED|TIMED-OUT)$/;

async function apifyCall(method, path, params, body, ms) {
  const u = new URL(APIFY_API + path);
  u.searchParams.set("token", process.env.APIFY_TOKEN || "");
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 20000);
  try {
    const r = await fetch(u.toString(), {
      method, signal: ctl.signal,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* reported below from the raw text */ }
    return { status: r.status, json, text };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e)));
    throw new Error(aborted ? "Apify did not answer in time — treat this channel as unknown, not empty"
                            : "Could not reach Apify: " + (e.message || e));
  } finally { clearTimeout(timer); }
}

const apifyMessage = res => String((((res.json || {}).error) || {}).message || res.text || ("HTTP " + res.status));

/* An exhausted monthly credit, a refused token and a plain failure have completely different fixes
   (wait for the cycle / add credit, re-check the key, look at the run) — so they are named apart. */
function apifyError(res) {
  const msg = apifyMessage(res);
  if (/usage hard limit|monthly usage|usage limit|not enough credit|insufficient/i.test(msg))
    return new Error("Apify's monthly credit is used up — these channels can't be read until the cycle " +
                     "resets or credit is added (" + msg.slice(0, 160) + ")");
  if (res.status === 401 || res.status === 403)
    return new Error("Apify refused the token (HTTP " + res.status + ") — check APIFY_TOKEN");
  return new Error("Apify answered HTTP " + res.status + ": " + msg.slice(0, 200));
}

/* The cost of one run, from Apify's own run record. usageTotalUsd is what Apify bills for the run;
   chargedEventCounts says what it was for (e.g. { post: 6, "actor-start": 1 }). */
function apifyCost(run, settled) {
  return {
    runId: run.id, status: run.status,
    usd: typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null,
    events: run.chargedEventCounts || null,
    settled: !!settled,
    cached: false,
  };
}

/* Start an actor, wait for it inside the time budget, read its dataset. Returns { items, cost,
   partial }. Throws only when nothing usable came back. */
async function apifyRun(platform, input) {
  const a = APIFY_ACTORS[platform];
  const deadline = Date.now() + APIFY_BUDGET_MS;
  const left = () => deadline - Date.now();
  let cap = Math.max(0.01, a.minCap, Math.round(apifyExpectedUsd(platform) * 2 * 10000) / 10000);

  /* Started with a bounded retry while the account's concurrent-memory cap is momentarily full —
     another channel's run from the same daily check may still be finishing. An actor that raises its
     minimum cap later says so in the refusal ("less than the allowed minimum of $0.50"); that is
     accepted once, up to $1, rather than the channel going unread until the code is changed. */
  let start, raised = false;
  for (let attempt = 0; ; attempt++) {
    start = await apifyCall("POST", `/acts/${a.id}/runs`, {
      memory: a.memory,
      timeout: Math.floor(APIFY_BUDGET_MS / 1000) - 10,
      maxTotalChargeUsd: cap,
      waitForFinish: Math.max(1, Math.min(60, Math.floor(left() / 1000) - 10)),
    }, input, Math.min(left(), 75000));
    if (start.status === 200 || start.status === 201) break;
    const msg = apifyMessage(start);
    const min = Number((msg.match(/allowed minimum of \$\s*([\d.]+)/i) || [])[1]);
    if (!raised && min > cap && min <= 1) { cap = min; raised = true; continue; }
    if (/memory limit|concurrent/i.test(msg) && attempt < 4 && left() > 40000) {
      await sleep(5000 + attempt * 3000);
      continue;
    }
    throw apifyError(start);
  }

  let run = start.json && start.json.data;
  if (!run || !run.id) throw new Error("Apify started a run but returned no run record");
  while (!TERMINAL.test(run.status) && left() > 10000) {
    const r = await apifyCall("GET", `/actor-runs/${run.id}`,
      { waitForFinish: Math.max(1, Math.min(60, Math.floor(left() / 1000) - 8)) }, null, Math.min(left(), 70000));
    if (r.status !== 200 || !r.json || !r.json.data) throw apifyError(r);
    run = r.json.data;
  }

  let partial = false;
  if (!TERMINAL.test(run.status)) {
    partial = true;
    try {
      const ab = await apifyCall("POST", `/actor-runs/${run.id}/abort`, null, null, 8000);
      if (ab.json && ab.json.data) run = ab.json.data;
    } catch (e) { /* the actor's own timeout stops it shortly anyway */ }
  }

  const ds = await apifyCall("GET", `/datasets/${run.defaultDatasetId}/items`,
    { clean: 1, format: "json" }, null, Math.max(8000, Math.min(left(), 20000)));
  const items = ds.status === 200 && Array.isArray(ds.json) ? ds.json : [];

  /* Apify settles a run's charges a few seconds AFTER the run stops: read straight away, a run that
     returned six posts still showed { post: 0 } and $0 (measured 2026-10-02 — the figures caught up
     a minute later). The event counts and the dollar figure do not even settle together — a TikTok
     run showed { result: 1, "actor-start": 1 } beside $0. So the record is re-read until the
     per-item charge has caught up with the items returned AND any charged event shows up in the
     dollar figure, for up to ~10 s; past that the figure is reported as not settled. */
  const settled = r => {
    const ev = r.chargedEventCounts || {};
    const charged = Object.values(ev).some(n => n > 0);
    return (ev[a.itemEvent] || 0) >= items.length && (!charged || r.usageTotalUsd > 0);
  };
  let done = false;
  for (let i = 0; i < 7 && left() > 4000; i++) {
    if (i) await sleep(1500);
    try {
      const fin = await apifyCall("GET", `/actor-runs/${run.id}`, null, null, 6000);
      if (fin.status === 200 && fin.json && fin.json.data) run = fin.json.data;
    } catch (e) { /* keep the last record we had */ }
    if ((done = settled(run))) break;
  }

  if (!items.length && run.status !== "SUCCEEDED") {
    throw new Error(`Apify run ${run.status.toLowerCase()}` +
      (run.statusMessage ? `: ${String(run.statusMessage).slice(0, 160)}` : "") +
      " — treat this channel as unknown, not empty");
  }
  return { items, cost: apifyCost(run, done), partial };
}

/* An actor reports a profile it could not read (private, age-restricted, removed) as an item with
   an error field rather than as a failed run — that reason is the useful part, so it is kept. */
const apifyItemError = it => it && (it.errorDescription || it.error || it.errorMessage) || "";

/* Cache of a paid read. Repeated "Run daily check" clicks inside the window cost nothing. */
const APIFY_CACHE_MS = 15 * 60e3;
async function apifyCached(cacheName) {
  try { const c = await ingest.cacheGet(cacheName, APIFY_CACHE_MS); return c && c.length ? c : null; }
  catch (e) { return null; }
}
async function apifyRemember(cacheName, posts) {
  try { await ingest.cacheSet(cacheName, posts); } catch (e) { /* caching is best-effort */ }
}
const CACHED_COST = { usd: 0, cached: true };

/* Last resort for a BRIEF live-read blip (an actor cold-starts, a momentary 5xx): the last good
   read, but only if it is genuinely recent. Kept deliberately short (20 min) — a stale read served
   as if it were current is worse than admitting we could not read, because the report would mark
   every drop NEWER than the stale data as "missing" when the posts actually went out. So beyond
   this window we return null: the collector then fails honestly and the channel reads "could not
   read / unknown", never a false cross. (This is exactly what a prolonged outage — e.g. Apify's
   monthly free credits running out — must not turn into invented misses.) */
async function staleRead(cacheName) {
  try { const c = await ingest.cacheGet(cacheName, 20 * 60e3); return c && c.length ? c : null; }
  catch (e) { return null; }
}

/* ═══════════════════ handle extraction ═══════════════════ */
/* The directory stores a URL and a free-text handle. Either may be the usable one, so try the
   URL path first (it is the field the app validates) and fall back to the typed handle. */

function pathOf(url) {
  try { return new URL(url).pathname.replace(/^\/+|\/+$/g, ""); }
  catch (e) { return ""; }
}

function ytTarget(ch) {
  if (ch.ytChannelId && /^UC[\w-]{20,}$/.test(ch.ytChannelId)) return { id: ch.ytChannelId };
  const p = pathOf(ch.url);
  const byId = p.match(/^channel\/(UC[\w-]{20,})/);
  if (byId) return { id: byId[1] };
  const handle = (p.match(/^@([\w.-]+)/) || [])[1] ||
                 (String(ch.handle || "").match(/@?([\w.-]+)/) || [])[1] || "";
  return handle ? { handle } : {};
}

function tgTarget(ch) {
  const p = pathOf(ch.url).replace(/^s\//, "");
  const name = (p.match(/^([A-Za-z0-9_]{4,})/) || [])[1] ||
               (String(ch.handle || "").match(/@?([A-Za-z0-9_]{4,})/) || [])[1] || "";
  return name;
}

function igTarget(ch) {
  const p = pathOf(ch.url);
  const name = (p.match(/^([A-Za-z0-9._]+)/) || [])[1] ||
               (String(ch.handle || "").match(/@?([A-Za-z0-9._]+)/) || [])[1] || "";
  return name;
}

/* TikTok URLs are tiktok.com/@handle, so the leading @ is stripped off the path (or the handle). */
function ttTarget(ch) {
  const p = pathOf(ch.url);
  const name = (p.match(/^@?([A-Za-z0-9._]+)/) || [])[1] ||
               (String(ch.handle || "").match(/@?([A-Za-z0-9._]+)/) || [])[1] || "";
  return name;
}

/* the path segments x.com/twitter.com use for something other than a handle */
const X_RESERVED = /^(i|status|statuses|intent|search|home|hashtag|explore|notifications|messages|settings|compose|login|signup)$/i;
function xTarget(ch) {
  const seg = pathOf(ch.url).split("/")[0] || "";
  if (seg && !X_RESERVED.test(seg)) return seg;
  return (String(ch.handle || "").match(/@?([\w]{1,15})/) || [])[1] || "";
}

/* a Telegram BOT is t.me/<BotName> — the same first path segment (or the handle), @ stripped */
function tgBotTarget(ch) {
  const p = pathOf(ch.url).replace(/^s\//, "");
  return (p.match(/^@?([A-Za-z0-9_]{3,})/) || [])[1] ||
         (String(ch.handle || "").match(/@?([A-Za-z0-9_]{3,})/) || [])[1] || "";
}

/* ═══════════════════ youtube ═══════════════════ */

/* The public RSS feed (youtube.com/feeds/videos.xml) was this channel's reader until it began
   answering 404 for EVERY channel id — MrBeast and Google Developers as readily as ours, from a
   home connection as readily as from Vercel. That rules out the soft rate-limit this code used to
   blame and retry around: the endpoint is simply gone. The retry loop it had is gone with it,
   because six fetches that cannot succeed are worse than one honest failure.

   YouTube is now read two independent ways, in order:

     1. the official Data API v3, whenever YOUTUBE_API_KEY is set. Versioned, documented, and
        deprecated in public rather than overnight — which is the actual answer to "make sure this
        does not happen again". Three quota units per channel per run against a free 10,000/day
        ceiling, so a daily check cannot outgrow it.
     2. the channel page plus InnerTube — the same JSON endpoint youtube.com's own front end calls
        to render a video. No key, no login, works right now with nothing configured.

   Reader 2 is kept even when a key is present, so an expired or over-quota key is a note in the
   report rather than an outage. Both carry an exact ISO timestamp and a duration, so unlike RSS
   they can tell a Short from long-form instead of lumping the two together. */

const YT_ROUND = 6;    /* metadata lookups per round — one round covers a normal day */
const YT_MAX   = 30;   /* hard ceiling per channel, so a busy channel cannot stall the run */

function ytText(o) {
  if (!o) return "";
  if (typeof o === "string") return o;
  if (o.simpleText) return o.simpleText;
  if (Array.isArray(o.runs)) return o.runs.map(r => r.text || "").join("");
  return "";
}

/* Title and description say the same thing on these channels often enough that joining them
   blindly prints the title twice in the report. */
function ytJoin(title, desc) {
  const t = String(title || ""), d = String(desc || "");
  if (!d) return t;
  if (!t) return d;
  return d.indexOf(t.trim()) !== -1 ? d : t + "\n" + d;
}

/* "PT1M30S" -> 90. Used only to tell Shorts from long-form. */
function ytIsoDur(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(String(s || ""));
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + Math.round(+m[4] || 0);
}

/* A Short is a vertical video of three minutes or less, and neither reader states it outright.
   The channel grid is the honest signal — it links a Short as /shorts/<id> — so duration is only
   consulted when the grid had nothing to say about that video. */
const YT_SHORT_MAX = 180;
function ytKind(isShort, secs) {
  if (isShort) return "short";
  return secs > 0 && secs <= YT_SHORT_MAX ? "short" : "video";
}

function ytLink(vid, kind) {
  return "https://www.youtube.com/" + (kind === "short" ? "shorts/" : "watch?v=") + vid;
}

/* ── reader 1: the official Data API ── */

async function ytApi(resource, query) {
  const r = await get("https://www.googleapis.com/youtube/v3/" + resource + "?" + query +
                      "&key=" + encodeURIComponent(process.env.YOUTUBE_API_KEY));
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { /* the status check below reports it */ }
  if (r.status !== 200) {
    const e = (j && j.error) || {};
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || "";
    /* worth telling apart in the report: an exhausted daily quota fixes itself at midnight
       Pacific, a rejected key never does */
    const quota = /quota/i.test(reason) || /quota/i.test(e.message || "");
    throw new Error("YouTube Data API " + (quota ? "daily quota is used up" : "refused the key") +
                    " (" + (e.message || "HTTP " + r.status) + ")");
  }
  return j || {};
}

async function collectYouTubeApi(ch, cutoff) {
  const t = ytTarget(ch);
  let id = t.id, resolved = null;
  if (!id) {
    if (!t.handle) throw new Error("No YouTube handle or channel id could be read from this channel");
    const handle = t.handle.replace(/^@/, "");
    let apiSaid = "";
    try {
      const j = await ytApi("channels", "part=id&forHandle=" + encodeURIComponent("@" + handle));
      id = j.items && j.items[0] && j.items[0].id;
    } catch (e) {
      /* held rather than thrown, because the page below may still resolve it — but kept, because
         "could not find a channel id" would otherwise be the whole story when the real story is
         a key that was refused */
      apiSaid = String(e.message || e);
    }
    if (!id) {
      /* The channel page is the one YouTube surface that answers a datacenter without a key, so
         it is a better backstop here than a second API call. Costs a fetch, not a quota unit,
         and both channels carry a pinned ytChannelId anyway — this is for a new one. */
      try {
        const html = await ytPage("/@" + encodeURIComponent(handle));
        id = (html.match(/"externalId"\s*:\s*"(UC[\w-]{20,})"/) || [])[1] || "";
      } catch (e) { /* reported as a failure to resolve, just below */ }
    }
    if (!id) throw new Error(apiSaid || "Could not find a channel id for @" + handle);
    resolved = { ytChannelId: id };
  }

  /* Every channel's uploads playlist is its own id with the second letter changed, UC… -> UU… —
     a documented equivalence, so this needs no extra channels.list round trip. Shorts land in
     that playlist alongside long-form. */
  const pl = await ytApi("playlistItems",
                         "part=snippet,contentDetails&maxResults=50&playlistId=UU" + id.slice(2));
  const items = (pl.items || []).filter(it => {
    const ts = it.contentDetails && it.contentDetails.videoPublishedAt;
    return ts && (!cutoff || new Date(ts).getTime() >= cutoff);
  });

  /* one more call covers durations and counters for the whole window at once */
  const ids = items.map(it => it.contentDetails.videoId).filter(Boolean).slice(0, 50);
  const extra = {};
  if (ids.length) {
    const v = await ytApi("videos", "part=contentDetails,statistics&id=" + ids.join(","));
    for (const it of (v.items || [])) extra[it.id] = it;
  }

  const posts = items.map(it => {
    const vid = it.contentDetails.videoId, sn = it.snippet || {}, ex = extra[vid] || {};
    const kind = ytKind(false, ytIsoDur(ex.contentDetails && ex.contentDetails.duration));
    const th = sn.thumbnails || {};
    return {
      externalId: vid,
      ts: new Date(it.contentDetails.videoPublishedAt).toISOString(),
      kind,
      title: sn.title || "",
      text: ytJoin(sn.title, sn.description).trim(),
      views: num(ex.statistics && ex.statistics.viewCount),
      likes: num(ex.statistics && ex.statistics.likeCount),
      thumb: (th.maxres || th.standard || th.high || th.medium || th.default || {}).url || "",
      updated: "",
      permalink: ytLink(vid, kind),
    };
  });

  return {
    posts, resolved, source: "youtube-api",
    note: "Read through the official YouTube Data API. Shorts are told apart by duration " +
          "(three minutes or less), which the API does not state outright.",
  };
}

/* ── reader 2: the channel page and InnerTube, no key ── */

async function ytPage(path) {
  const r = await get("https://www.youtube.com" + path);
  if (r.status !== 200) {
    const e = new Error("YouTube would not serve " + path + " (HTTP " + r.status +
                        ") — treat this channel as unknown, not empty");
    e.status = r.status;
    throw e;
  }
  return r.body;
}

function ytInitialData(html) {
  const m = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s) ||
            html.match(/ytInitialData"\]\s*=\s*(\{.+?\})\s*;/s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

/* Walks the rendered grid for video ids in the order YouTube laid them out — newest first, but
   for a pinned video, which can sit out of order at the top. Which ids are Shorts is read off the
   raw page text instead, because the /shorts/<id> link sits a level above the id in the tree and
   a plain walk would lose the pairing. */
function ytHarvest(json, raw) {
  const ids = [], seen = new Set(), shorts = new Set();
  const re = /"\/shorts\/([\w-]{11})"/g;
  let m;
  while ((m = re.exec(raw))) shorts.add(m[1]);
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    const vid = o.videoId;
    if (typeof vid === "string" && /^[\w-]{11}$/.test(vid) && !seen.has(vid)) {
      seen.add(vid); ids.push(vid);
    }
    for (const k in o) walk(o[k]);
  })(json);
  return { ids, shorts };
}

/* the public web-client credentials youtube.com ships in every page it serves */
function ytCreds(html) {
  return {
    key: (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || "",
    ver: (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || "2.20240101.00.00",
  };
}

/* One video's metadata, by whichever route will answer. The order matters and was settled by
   what production actually does, not by what is tidiest:

     1. InnerTube on www.youtube.com — small JSON, the front end's own call. Answers from a home
        connection and, at least sometimes, refuses from a datacenter.
     2. InnerTube on youtubei.googleapis.com — the same API on Google's API host, which is not
        behind the same front-end gate.
     3. the watch page, scraped. A plain GET of a page anybody can open, which is the one thing
        that kept working from Vercel throughout. About a megabyte a video, so it is the last
        resort rather than the first, but it is the one that does not depend on a gate.

   Every route reduces to the same shape as the InnerTube response so ytPost has one input to
   read. `why` records which route answered, so the report can say so and the next person does
   not have to rediscover any of this. */

/* Asked as a browser from a datacenter, InnerTube answers LOGIN_REQUIRED — Google's "confirm
   you're not a bot" gate, which is applied to the IP rather than to the request, so no amount of
   header dressing talks it round. What the gate does not cover uniformly is every client: the
   embedded player and the TV and phone apps sign in differently and are refused less often. So
   the same question is asked as several clients before the watch page is tried.

   None of this is load-bearing if YOUTUBE_API_KEY is set, and that is the point — these are the
   attempts that keep a keyless deployment working, not the ones the report should depend on. */
const YT_CLIENTS = [
  { host: "https://www.youtube.com",           name: "WEB",   id: 1,  ver: null },
  { host: "https://youtubei.googleapis.com",   name: "WEB",   id: 1,  ver: null },
  { host: "https://youtubei.googleapis.com",   name: "MWEB",  id: 2,  ver: "2.20240101.00.00" },
  { host: "https://youtubei.googleapis.com",   name: "WEB_EMBEDDED_PLAYER", id: 56,
    ver: "1.20240101.00.00" },
  { host: "https://youtubei.googleapis.com",   name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", id: 85,
    ver: "2.0" },
];

async function ytInnertube(client, vid, creds) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  const ver = client.ver || creds.ver;
  try {
    const r = await fetch(client.host + "/youtubei/v1/player?key=" + encodeURIComponent(creds.key), {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "User-Agent": UA,
                 "Accept-Language": "en-US,en;q=0.9", "Origin": "https://www.youtube.com",
                 /* the consent interstitial otherwise stands in for the answer */
                 "Cookie": "CONSENT=YES+cb; SOCS=CAI",
                 "X-YouTube-Client-Name": String(client.id), "X-YouTube-Client-Version": ver },
      body: JSON.stringify({
        videoId: vid,
        context: { client: { clientName: client.name, clientVersion: ver, hl: "en",
                             gl: "US", userAgent: UA } },
      }),
    });
    if (r.status !== 200) return { fail: "HTTP " + r.status };
    const j = await r.json();
    /* a 200 that carries no microformat is a refusal wearing a success code */
    if (!j || !j.microformat) {
      return { fail: (j && j.playabilityStatus && j.playabilityStatus.status) || "no microformat" };
    }
    return { j };
  } catch (e) {
    return { fail: String((e && e.message) || e).slice(0, 60) };
  } finally { clearTimeout(timer); }
}

/* The watch page carries the same microformat block InnerTube would have returned, inlined as
   ytInitialPlayerResponse. Pulling the whole object out and reusing the InnerTube shape keeps
   this from becoming a second parser to maintain. */
async function ytWatch(vid) {
  let r;
  try { r = await get("https://www.youtube.com/watch?v=" + vid, { Cookie: "CONSENT=YES+cb; SOCS=CAI" }); }
  catch (e) { return { fail: String((e && e.message) || e).slice(0, 60) }; }
  if (r.status !== 200) return { fail: "watch HTTP " + r.status };
  const m = r.body.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:<\/script>|var )/s);
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      if (j && j.microformat) return { j };
    } catch (e) { /* fall through to the field-by-field read below */ }
  }
  /* The page is served in more than one shape and the block above is not always parseable in
     one piece. These four fields are all ytPost needs, and each appears once with a stable key,
     so reading them individually is sturdier here than insisting on valid JSON. */
  const one = re => (r.body.match(re) || [])[1] || "";
  const when = one(/"uploadDate"\s*:\s*"([^"]+)"/) || one(/"publishDate"\s*:\s*"([^"]+)"/) ||
               one(/itemprop="uploadDate"[^>]*content="([^"]+)"/);
  if (!when) return { fail: "no date on the watch page" };
  return { j: {
    microformat: { playerMicroformatRenderer: { uploadDate: when } },
    videoDetails: {
      videoId: vid,
      title: decodeXml(one(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/).replace(/\\"/g, '"')),
      shortDescription: decodeXml(one(/"shortDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/)
        .replace(/\\n/g, "\n").replace(/\\"/g, '"')),
      lengthSeconds: one(/"lengthSeconds"\s*:\s*"(\d+)"/),
      viewCount: one(/"viewCount"\s*:\s*"(\d+)"/),
      channelId: one(/"channelId"\s*:\s*"(UC[\w-]{20,})"/),
      thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg" }] },
    },
  } };
}

/* A video that will not answer by any route comes back null and is skipped — one unreadable
   video must not cost the other nine — and the caller refuses to report the channel at all if
   none of them answered. */
async function ytMeta(vid, creds, why) {
  const tried = [];
  const label = c => new URL(c.host).hostname.replace("www.youtube.com", "youtube") +
                     "/" + c.name;
  /* Once one client has answered, the rest of this channel's videos go straight to it — the
     others were refused for the deployment, not for the video, so re-asking them per video would
     multiply every read by five for nothing. */
  const order = why.client ? [why.client].concat(YT_CLIENTS.filter(c => c !== why.client))
                           : YT_CLIENTS;
  for (const client of order) {
    const out = await ytInnertube(client, vid, creds);
    if (out.j) {
      why.client = client;
      why.route = why.route || label(client);
      return out.j;
    }
    tried.push(label(client) + ": " + out.fail);
  }
  const w = await ytWatch(vid);
  if (w.j) { why.route = why.route || "watch page"; return w.j; }
  tried.push("watch page: " + w.fail);
  if (!why.tried) why.tried = tried.join("; ");
  return null;
}

function ytPost(vid, j, isShort) {
  const mf = (j && j.microformat && j.microformat.playerMicroformatRenderer) || null;
  const vd = (j && j.videoDetails) || null;
  /* uploadDate carries the offset and publishDate is the same instant; without either the video
     cannot be placed on the timeline, so it counts as unread rather than as undated */
  const when = mf && (mf.uploadDate || mf.publishDate);
  if (!when) return null;
  const at = new Date(when);
  if (isNaN(at.getTime())) return null;
  const title = (vd && vd.title) || ytText(mf && mf.title);
  const desc = (vd && vd.shortDescription) || ytText(mf && mf.description);
  const kind = ytKind(isShort, Number(vd && vd.lengthSeconds) || 0);
  const thumbs = (vd && vd.thumbnail && vd.thumbnail.thumbnails) || [];
  return {
    externalId: vid,
    ts: at.toISOString(),
    kind,
    title,
    text: ytJoin(title, desc).trim(),
    views: num(vd && vd.viewCount),
    likes: null,        /* the player response carries none, and a written-in 0 would read as real */
    thumb: (thumbs.length && thumbs[thumbs.length - 1].url) || "",
    updated: "",
    permalink: ytLink(vid, kind),
    channelId: (vd && vd.channelId) || "",
  };
}

async function collectYouTubeWeb(ch, cutoff) {
  const t = ytTarget(ch);
  const base = t.id ? "/channel/" + t.id
             : t.handle ? "/@" + encodeURIComponent(t.handle.replace(/^@/, "")) : "";
  if (!base) throw new Error("No YouTube handle or channel id could be read from this channel");

  /* Videos and Shorts are separate grids on a channel that posts both, so reading only one would
     call a day with three Shorts and no long-form an empty day. Fetched together, so the pair
     costs about what one costs; a channel with no Shorts tab simply fails that half. */
  const [vTab, sTab] = await Promise.all([
    ytPage(base + "/videos").catch(e => e),
    ytPage(base + "/shorts").catch(e => e),
  ]);
  const pages = [vTab, sTab].filter(p => typeof p === "string");
  if (!pages.length) throw new Error(String(vTab.message || vTab));

  const found = pages[0].match(/"externalId"\s*:\s*"(UC[\w-]{20,})"/);
  const id = t.id || (found && found[1]) || "";
  const resolved = !t.id && found ? { ytChannelId: found[1] } : null;

  const creds = ytCreds(pages[0]);
  if (!creds.key) {
    throw new Error("YouTube's channel page carried no InnerTube key — treat this channel as " +
                    "unknown, not empty");
  }

  const lists = [], shorts = new Set();
  for (const html of pages) {
    const data = ytInitialData(html);
    if (!data) continue;
    const h = ytHarvest(data, html);
    if (h.ids.length) lists.push(h.ids);
    for (const s of h.shorts) shorts.add(s);
  }
  /* interleaved, so one round of lookups covers the newest of both tabs rather than draining one */
  const order = [], queued = new Set();
  for (let i = 0; i < YT_MAX; i++) for (const l of lists) {
    if (l[i] && !queued.has(l[i])) { queued.add(l[i]); order.push(l[i]); }
  }
  if (!order.length) {
    throw new Error("Could not read a single video off YouTube's channel page — treat this " +
                    "channel as unknown, not empty");
  }

  const posts = [];
  const why = { route: "", tried: "" };
  let read = 0, looked = 0;
  for (let i = 0; i < order.length && looked < YT_MAX; i += YT_ROUND) {
    const batch = order.slice(i, i + YT_ROUND);
    looked += batch.length;
    const got = await Promise.all(
      batch.map(v => ytMeta(v, creds, why).then(j => ytPost(v, j, shorts.has(v)))));
    let fresh = 0;
    for (const p of got) {
      if (!p) continue;
      read++;
      const owner = p.channelId; delete p.channelId;
      /* the page's JSON also names videos this channel did not post — a trailer, a shelf of
         recommendations — and one of those inside the window would otherwise be credited here */
      if (id && owner && owner !== id) continue;
      posts.push(p);
      if (!cutoff || new Date(p.ts).getTime() >= cutoff) fresh++;
    }
    /* The grid runs newest first, so a whole round landing outside the window means everything
       after it is older still. A round rather than a single video, because one pinned video at
       the top is old by design and must not cut the read short. */
    if (!fresh && posts.length) break;
  }
  if (!read) {
    /* Naming every route that was tried and how each one refused is what turns the next "no data
       again" into something diagnosable from the report, instead of from a redeploy. The first
       version of this reader failed exactly here on Vercel while working from a desk, and the
       note said only that it had failed. */
    throw new Error("YouTube would not describe any of this channel's videos — treat this " +
                    "channel as unknown, not empty. Tried " + (why.tried || "every route") + ".");
  }

  return {
    posts, resolved, source: "youtube-web",
    note: "Read from the channel page via " + (why.route || "InnerTube") + " — no API key is " +
          "set. Setting YOUTUBE_API_KEY switches this to the official API, which is sturdier.",
  };
}

/* The API first when there is a key, the page read as the safety net either way. */
async function collectYouTube(ch, cutoff) {
  let apiFailed = "";
  if (process.env.YOUTUBE_API_KEY) {
    try { return await collectYouTubeApi(ch, cutoff); }
    catch (err) { apiFailed = String(err.message || err); }
  }
  try {
    const out = await collectYouTubeWeb(ch, cutoff);
    if (apiFailed) out.note = apiFailed + " — read from the channel page instead.";
    return out;
  } catch (err) {
    throw new Error(apiFailed ? apiFailed + " | " + (err.message || err) : String(err.message || err));
  }
}

/* ═══════════════════ x (twitter) ═══════════════════ */

/* X server-renders the logged-out profile timeline as HTML carrying schema.org microdata — one
   <article itemType=".../SocialMediaPosting"> per post, each with an exact ISO timestamp, the full
   text, its media and every counter. No token, no guest API, no login: a plain fetch of the
   profile URL with an ordinary browser User-Agent (the UA already set on every request here) gets
   the full render — only a crawler UA gets an empty client-side shell instead.

   Depth is small and has no cursor: as few as 3 posts for a quiet account, not reliably more than
   about 10 for a busy one. Fine for a daily check — the question is always "the last 24 hours" —
   but an account that outpaces this between two collections loses the overflow, the same ceiling
   Instagram's public endpoint imposes, and reported the same way: plainly, in the note, never
   silently. */

const X_STAT_NAME = { Views: "views", Likes: "likes", Retweets: "reposts", Replies: "replies" };

/* "PT19S" / "PT1M30S" -> seconds. X reports video length this way; everywhere else in this file
   it is "0:10" / "1:02:33", which is what mmss() below is for. */
function isoDurToSec(s) {
  const m = String(s || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Math.round(Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0));
}

function xArticles(html) {
  return html.split("<article ").slice(1);
}

function xVideoOf(body) {
  const i = body.indexOf("schema.org/VideoObject");
  if (i < 0) return null;
  const w = body.slice(i, i + 1200);
  return {
    thumb: (w.match(/content="([^"]+)"\s+itemProp="thumbnailUrl"/) || [])[1] || "",
    duration: isoDurToSec((w.match(/content="([^"]+)"\s+itemProp="duration"/) || [])[1]),
  };
}

/* one post can carry several — a photo carousel — so this returns every one it finds */
function xImagesOf(body) {
  return body.split("schema.org/ImageObject").slice(1).map(part => {
    const w = part.slice(0, 700);
    return (w.match(/content="([^"]+)"\s+itemProp="thumbnailUrl"/) || [])[1]
        || (w.match(/content="([^"]+)"\s+itemProp="(?:contentUrl|url)"/) || [])[1] || "";
  }).filter(Boolean);
}

/* Four sibling InteractionCounter blocks carry the post's own stats. The author block a few lines
   up has its own counters (Tweets/Following/Follows) under a differently-named itemProp —
   agentInteractionStatistic, not interactionStatistic — so anchoring on the exact prop name keeps
   this from ever mistaking the account's tweet count for the post's view count. */
function xStatsOf(body) {
  const out = {};
  for (const part of body.split('itemProp="interactionStatistic"').slice(1)) {
    const w = part.slice(0, 400);
    const name = (w.match(/content="([^"]*)"\s+itemProp="name"/) || [])[1];
    const count = (w.match(/content="([^"]*)"\s+itemProp="userInteractionCount"/) || [])[1];
    const key = X_STAT_NAME[name];
    if (key && count !== undefined) out[key] = num(count);
  }
  return out;
}

/* One <article>, already sliced to its own close tag. Returns null for anything that is not a
   fully-formed, first-party post by this exact handle — which is deliberately strict:
     · no itemType at all           → not a post the render fully described (an ad slot, a gap)
     · no author block              → a quote-card, which speaks for someone else's post
     · author present but different → a repost. Its words reached this page, but they are not
       this channel's own content, and counting them would make a day of reposts read as delivered
   so every one of those is skipped rather than risking a wrong verdict on faked evidence. */
function xParsePost(rawArticle, handle) {
  const endTag = rawArticle.indexOf("</article>");
  const body = endTag === -1 ? rawArticle : rawArticle.slice(0, endTag);
  if (!/^[^>]*itemType="https:\/\/schema\.org\/SocialMediaPosting"/.test(body)) return null;

  const id = (body.match(/^[^>]*data-tweet-id="(\d+)"/) || [])[1];
  const ts = (body.match(/content="([^"]+)"\s+itemProp="datePublished"/) || [])[1];
  if (!id || !ts || isNaN(new Date(ts).getTime())) return null;

  const author = (body.match(/itemProp="author"[\s\S]{0,240}?content="([^"]*)"\s+itemProp="alternateName"/) || [])[1];
  if (!author || author.toLowerCase() !== handle.toLowerCase()) return null;

  const text = decodeXml((body.match(/content="([^"]*)"\s+itemProp="text"/) || [])[1] || "");
  const video = xVideoOf(body);
  const images = video ? [] : xImagesOf(body);
  const stats = xStatsOf(body);
  const comments = stats.replies != null ? stats.replies
                  : num((body.match(/content="(\d+)"\s+itemProp="commentCount"/) || [])[1]);

  return {
    externalId: id,
    ts: new Date(ts).toISOString(),
    kind: video ? "video" : images.length > 1 ? "carousel" : images.length ? "photo" : "text",
    text,
    views: stats.views != null ? stats.views : null,
    likes: stats.likes != null ? stats.likes : null,
    comments,
    /* X's own metric, alongside likes/comments — nothing else this file reads exposes a repost
       count, so the report's per-post view grows one field to show it rather than dropping it */
    reposts: stats.reposts != null ? stats.reposts : null,
    duration: video ? video.duration : null,
    thumb: video ? video.thumb : images[0] || "",
    permalink: (body.match(/content="([^"]+)"\s+itemProp="url"/) || [])[1]
      || ("https://x.com/" + handle + "/status/" + id),
  };
}

/* twitterapi.io returns the timeline as JSON (data.tweets[]). Map it to the same post shape the
   microdata parser produces. Retweets and replies are skipped — a retweet is someone else's post
   on this account's page, and counting it would make a day of them read as delivered. */
function xParseApi(jsonText, handle) {
  let j; try { j = JSON.parse(jsonText); } catch (e) { return []; }
  const tweets = j && j.data && Array.isArray(j.data.tweets) ? j.data.tweets : [];
  return tweets.map(t => {
    const id = String(t.id || t.id_str || "").trim();
    const ms = new Date(t.createdAt || t.created_at || 0).getTime();
    const text = String(t.text || "");
    if (!id || !isFinite(ms) || /^RT @/.test(text) || /^@/.test(text)) return null;
    const media = (t.extendedEntities && t.extendedEntities.media) || t.media || [];
    const mtype = Array.isArray(media) && media[0] ? media[0].type : "";
    return {
      externalId: id,
      ts: new Date(ms).toISOString(),
      kind: mtype === "video" || mtype === "animated_gif" ? "video" : mtype === "photo" ? "photo" : "text",
      text,
      views: num(t.viewCount), likes: num(t.likeCount), comments: num(t.replyCount), reposts: num(t.retweetCount),
      thumb: (Array.isArray(media) && media[0] && (media[0].media_url_https || media[0].media_url)) || "",
      permalink: t.url || t.twitterUrl || ("https://x.com/" + handle + "/status/" + id),
    };
  }).filter(Boolean);
}

/* xquik/x-tweet-scraper's default ("legacy") item: id, text, createdAt (X's own "Wed Oct 01 13:00:00
   +0000 2026" form, which Date parses), url, author.username, isRetweet / isReply, the four counters
   and a media array. Retweets and replies are already excluded in the actor's input — before they
   are billed — and dropped again here in case an item slips through; so is anything by another
   author, for the same reason the page parser drops reposts. */
function xParseApify(items, handle) {
  const me = handle.toLowerCase();
  return items.map(t => {
    if (!t || apifyItemError(t)) return null;
    const id = String(t.id || t.id_str || "").trim();
    const ms = new Date(t.createdAt || t.created_at || 0).getTime();
    if (!id || !isFinite(ms)) return null;
    if (t.isRetweet || t.isReply || t.retweeted_status) return null;
    const a = t.author || {};
    const who = String(a.username || a.userName || a.screen_name || t.authorUsername || "").toLowerCase();
    if (who && who !== me) return null;
    const media = Array.isArray(t.media) ? t.media : [];
    const mtype = String((media[0] && (media[0].type || media[0].mediaType)) || "").toLowerCase();
    return {
      externalId: id, ts: new Date(ms).toISOString(),
      kind: /video|gif/.test(mtype) ? "video" : mtype ? "photo" : "text",
      text: String(t.text || t.full_text || ""),
      views: num(t.viewCount), likes: num(t.likeCount), comments: num(t.replyCount), reposts: num(t.retweetCount),
      thumb: (media[0] && (media[0].url || media[0].media_url_https || media[0].thumbnail)) || "",
      permalink: t.url || ("https://x.com/" + handle + "/status/" + id),
    };
  }).filter(Boolean).sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

/* 1) Apify — the primary reader whenever APIFY_TOKEN is set (apifyRead: cache, run, stale fallback). */
function collectXApify(handle) {
  return apifyRead("x", "xa:" + handle.toLowerCase(), {
    twitterHandles: [handle], mode: "profileTweets", maxItems: APIFY_MAX_POSTS,
    tweetTypes: { excludeReplies: true, excludeRetweets: true },
  }, items => xParseApify(items, handle), "@" + handle);
}

/* 2) twitterapi.io — kept as a second paid route for when Apify cannot answer. */
async function collectXTwitterApi(handle) {
  const cacheName = "x:" + handle.toLowerCase();
  try {
    const cached = await ingest.cacheGet(cacheName, 10 * 60e3);
    if (cached && cached.length) return { posts: cached, source: "x-api", note: "read via twitterapi.io (cached ~10 min to save credits)" };
  } catch (e) { /* cache miss is fine */ }
  let r;
  try {
    r = await get("https://api.twitterapi.io/twitter/user/last_tweets?userName=" + encodeURIComponent(handle),
      { "X-API-Key": process.env.TWITTERAPI_KEY });
  } catch (err) {
    const stale = await staleRead(cacheName);
    if (stale) return { posts: stale, source: "x-api", note: "twitterapi.io was unreachable — showing the last good read (" + (err.message || err) + ")" };
    throw err;
  }
  if (r.status !== 200) {
    const stale = await staleRead(cacheName);
    if (stale) return { posts: stale, source: "x-api", note: "twitterapi.io returned HTTP " + r.status + " — showing the last good read" };
    throw new Error("twitterapi.io returned HTTP " + r.status + (r.status === 402 ? " (account balance is empty)" : "") + " for @" + handle);
  }
  const apiPosts = xParseApi(r.body, handle).sort((a, b) => new Date(b.ts) - new Date(a.ts));
  if (!apiPosts.length) throw new Error("twitterapi.io returned no posts for @" + handle + " — treat as unknown, not empty.");
  try { await ingest.cacheSet(cacheName, apiPosts); } catch (e) { /* caching is best-effort */ }
  return { posts: apiPosts, source: "x-api", note: "read server-side via twitterapi.io" };
}

/* Each route is tried in turn and a failed one never blocks the next: twitterapi.io answering 402
   (an empty balance) used to end the read right there, even though the free page read below could
   still have been tried. Every route that refused is named in the final note or error. */
async function collectX(ch) {
  const handle = xTarget(ch);
  if (!handle) throw new Error("No X (Twitter) handle could be read from this channel");
  const refused = [];
  let spent = null;                       // a failed Apify run still cost something — keep it on the result
  if (process.env.APIFY_TOKEN) {
    try { return await collectXApify(handle); }
    catch (e) { refused.push("Apify: " + (e.message || e)); spent = e.cost || null; }
  }
  const withSpent = out => (spent && !out.cost ? Object.assign(out, { cost: spent }) : out);
  if (process.env.TWITTERAPI_KEY) {
    try {
      const out = await collectXTwitterApi(handle);
      if (refused.length) out.note += " · " + refused.join(" | ");
      return withSpent(out);
    } catch (e) { refused.push("twitterapi.io: " + (e.message || e)); }
  }
  try {
    const out = await collectXDirect(handle);
    if (refused.length) out.note += " · paid readers failed first — " + refused.join(" | ");
    return withSpent(out);
  } catch (e) {
    refused.push("x.com page: " + (e.message || e));
    const err = new Error(refused.join(" | "));
    err.cost = spent;
    throw err;
  }
}

/* 3) The free page read — X's logged-out profile microdata. Works from a home IP; X answers a
   datacenter IP with an empty shell, which is why it comes last. */
async function collectXDirect(handle) {
  const target = "https://x.com/" + encodeURIComponent(handle);
  const parse = body => xArticles(body).map(a => xParsePost(a, handle)).filter(Boolean);

  /* 1) Try X directly. Its logged-out profile page carries the posts as schema.org microdata, which
        the parser reads. This works from most IPs. */
  let posts = [], via = "direct", firstStatus = 0;
  try {
    const r = await get(target);
    firstStatus = r.status;
    if (r.status === 200) posts = parse(r.body);
  } catch (e) { /* fall through to the proxy, if any */ }

  /* 2) X deliberately refuses datacenter IPs (like a serverless host): it answers 200 but with an
        empty client-side shell — no microdata, so zero posts. When that happens and a scraping proxy
        is configured (X_SCRAPER = a URL prefix that fetches from a residential IP), fetch the SAME
        page through it and parse that. Only used on a miss, so it never spends a credit needlessly. */
  if (!posts.length && process.env.X_SCRAPER) {
    try {
      const r2 = await get(process.env.X_SCRAPER + encodeURIComponent(target));
      if (r2.status === 200) { const p2 = parse(r2.body); if (p2.length) { posts = p2; via = "residential proxy"; } }
    } catch (e) { /* keep the empty direct result */ }
  }

  /* Zero posts is indistinguishable from a dead handle, a suspended account, or X declining this
     request — none of those is "posted nothing" — so report it as a refusal (unknown), never empty.
     A non-200 is a different refusal (rate-limit, 404) and is named as such; a 200-with-no-posts is
     the datacenter-IP block, which the X_SCRAPER proxy is there to get past. */
  if (!posts.length) {
    if (firstStatus && firstStatus !== 200) {
      throw new Error("X would not serve that profile (HTTP " + firstStatus + ").");
    }
    throw new Error("X did not render any posts for this profile — treat this as unknown, not empty." +
      (process.env.X_SCRAPER ? "" : " (X blocks datacenter IPs; set TWITTERAPI_KEY to read it server-side — or X_SCRAPER as a fallback.)"));
  }

  return {
    posts,
    note: "Profile page shows only the most recent handful of posts (as few as 3, rarely more " +
          "than about 10)" + (via === "residential proxy" ? " · read via residential proxy (X blocked the server's own IP)" : ""),
  };
}

/* ═══════════════════ telegram ═══════════════════ */

/* Each post in the preview page is one wrapper carrying data-post="channel/123"; the timestamp
   lives in a <time datetime> inside that wrapper. Splitting on data-post keeps every timestamp
   attached to the right post and skips the page's own header/description markup. */
function tgParse(html, channel) {
  const out = [];
  const parts = html.split(/data-post="/).slice(1);
  for (const p of parts) {
    const idm = p.match(/^([A-Za-z0-9_]+\/(\d+))"/);
    if (!idm) continue;
    const body = p.slice(0, 20000);
    const dt = (body.match(/datetime="([^"]+)"/) || [])[1];
    if (!dt) continue;
    /* Telegram interleaves SERVICE notices into the public preview — "Channel photo updated", a
       pin, a name change — each with its own message id and time. They are not content: filing one
       as a post invented a phantom drop that read as "every channel missed it" (the 13:00 case).
       Skip them, by the service CSS class or the canonical service wording (which stays English
       even on localized channels). */
    const txt = (body.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";
    const text0 = stripHtml(txt);
    if (/tgme_widget_message_service/.test(body.slice(0, 1500)) ||
        /^\s*(channel|group)\s+(photo|name|title)\b|^\s*channel created\b|^\s*pinned\b|video chat|voice chat/i.test(text0))
      continue;
    const dur = (body.match(/message_video_duration[^>]*>([^<]*)</) || [])[1] || "";
    out.push({
      externalId: idm[1],
      ts: dt,
      kind: /tgme_widget_message_video/.test(body) ? "video"
          : /tgme_widget_message_photo/.test(body) ? "photo" : "text",
      text: text0,
      views: views((body.match(/tgme_widget_message_views[^>]*>([^<]*)</) || [])[1]),
      duration: mmss(dur),
      thumb: (body.match(/message_video_thumb[^"]*"[^>]*background-image:url\('([^']+)'/) || [])[1]
          || (body.match(/message_photo_wrap[^"]*"[^>]*background-image:url\('([^']+)'/) || [])[1] || "",
      author: stripHtml((body.match(/tgme_widget_message_author[^>]*>([\s\S]*?)<\/span>/) || [])[1] || ""),
      forwarded: /tgme_widget_message_forwarded_from/.test(body),
      edited: /message_meta[^>]*>[^<]*edited/i.test(body),
      permalink: "https://t.me/" + idm[1],
    });
  }
  /* the same post can appear twice when the preview page stitches pages together */
  const seen = new Set();
  return out.filter(p => (seen.has(p.externalId) ? false : seen.add(p.externalId)));
}

async function collectTelegram(ch) {
  const name = tgTarget(ch);
  if (!name) throw new Error("No Telegram channel name could be read from this channel");
  const r = await get("https://t.me/s/" + encodeURIComponent(name));
  if (r.status !== 200) throw new Error("t.me returned HTTP " + r.status);
  if (/tgme_page_additional|is not accessible|If you have Telegram/i.test(r.body) &&
      !/data-post=/.test(r.body)) {
    throw new Error("That Telegram channel is private or has no public preview");
  }
  const posts = tgParse(r.body, name);
  if (!posts.length) throw new Error("No posts found in the public preview");
  return { posts, note: "Public preview shows roughly the last 20 posts" };
}

/* ═══════════════════ the shared Apify read ═══════════════════ */
/* Every Apify-read platform has the same shape: a fresh cache answers for free; otherwise one run,
   whose items the platform's own mapper turns into posts; a failed run falls back to a read from the
   last 20 minutes (staleRead); and a run that came back with no usable posts names the actor's own
   reason when it gave one — a private or age-restricted profile arrives as an error ITEM, not a
   failed run, and "Instagram restricts this profile" is worth far more than "no posts".
   A run that produced nothing still cost something; that cost rides on the error (err.cost) so the
   per-check total stays honest. */
async function apifyRead(platform, cacheName, input, parse, who) {
  const source = platform + "-apify";
  const cached = await apifyCached(cacheName);
  if (cached) return { posts: cached, source, note: "read via Apify (cached ~15 min — no new charge)", cost: CACHED_COST };
  let out;
  try {
    out = await apifyRun(platform, input);
  } catch (err) {
    const stale = await staleRead(cacheName);
    if (stale) return { posts: stale, source, note: "Apify failed — showing the last good read (" + (err.message || err) + ")", cost: CACHED_COST };
    throw err;
  }
  const posts = parse(out.items);
  if (!posts.length) {
    const why = out.items.map(apifyItemError).find(Boolean);
    const e = new Error("Apify returned no posts for " + who + (why ? " — " + String(why).slice(0, 200) : "") +
                        " — treat this as unknown, not empty.");
    e.cost = out.cost;
    throw e;
  }
  await apifyRemember(cacheName, posts);
  return { posts, source, cost: out.cost, partialRead: out.partial,
           note: "read server-side via Apify" + (out.partial ? " (run hit its time budget — partial read)" : "") };
}

/* ═══════════════════ instagram ═══════════════════ */

/* apify/instagram-post-scraper at dataDetailLevel "basicData" — caption, timestamp, url, shortCode,
   type/productType and counts, billed as one flat event per post with no "details" surcharge.
   The shortcode is the id, the same one the extension and the public endpoint use, so a post read
   by more than one of them merges instead of counting twice. A tagged or collab post carries
   someone else's ownerUsername — not this channel's own — and is dropped. */
function igParseApify(items, name) {
  const me = name.toLowerCase();
  return items.map(it => {
    if (!it || apifyItemError(it)) return null;
    const ms = new Date(it.timestamp || 0).getTime();
    const id = String(it.shortCode || it.id || "").trim();
    if (!id || !isFinite(ms) || ms <= 0) return null;
    if (it.ownerUsername && String(it.ownerUsername).toLowerCase() !== me) return null;
    const t = String(it.type || "");
    const reel = it.productType === "clips" || /\/reels?\//.test(String(it.url || ""));
    return {
      externalId: id, ts: new Date(ms).toISOString(),
      kind: reel ? "reel" : t === "Sidecar" ? "carousel" : t === "Video" ? "video" : "image",
      text: String(it.caption || ""),
      permalink: it.url || "https://www.instagram.com/p/" + id + "/",
      likes: num(it.likesCount), comments: num(it.commentsCount),
      views: num(it.videoViewCount || it.videoPlayCount), duration: num(it.videoDuration),
      thumb: it.displayUrl || "",
    };
  }).filter(Boolean).sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

async function collectInstagram(ch) {
  const name = igTarget(ch);
  if (!name) throw new Error("No Instagram username could be read from this channel");

  if (process.env.APIFY_TOKEN) {
    return apifyRead("instagram", "ig:" + name.toLowerCase(), {
      username: [name], resultsLimit: APIFY_MAX_POSTS, skipPinnedPosts: true, dataDetailLevel: "basicData",
    }, items => igParseApify(items, name), "@" + name);
  }

  /* Without a token: Instagram's own public profile endpoint. It answers a home IP but usually
     refuses a datacenter one (429 in ~25 ms) — the daily check then asks the extension instead. */
  const r = await get(
    "https://www.instagram.com/api/v1/users/web_profile_info/?username=" + encodeURIComponent(name),
    { "X-IG-App-ID": IG_APP_ID, Accept: "application/json" }
  );

  if (r.status === 404) {
    const e = new Error("Instagram says this profile does not exist — check the handle");
    e.dead = true;
    throw e;
  }
  if (r.status !== 200) {
    let msg = "Instagram returned HTTP " + r.status;
    try { const j = JSON.parse(r.body); if (j && j.message) msg += " — " + j.message; } catch (e) {}
    throw new Error(msg + " (set APIFY_TOKEN to read Instagram server-side)");
  }

  let user;
  try { user = JSON.parse(r.body).data.user; }
  catch (e) { throw new Error("Instagram answered with something that was not profile JSON"); }
  if (!user) throw new Error("Instagram returned no profile for that username");

  const media = user.edge_owner_to_timeline_media || { edges: [], count: 0 };
  const posts = (media.edges || []).map(x => {
    const n = x.node || {};
    const cap = ((n.edge_media_to_caption || {}).edges || [])[0];
    return {
      externalId: n.shortcode || n.id || "",
      ts: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000).toISOString() : "",
      kind: n.product_type === "clips" ? "reel"
          : n.__typename === "GraphSidecar" ? "carousel"
          : n.__typename === "GraphVideo" ? "video" : "image",
      text: (cap && cap.node && cap.node.text) || "",
      permalink: n.shortcode ? "https://www.instagram.com/p/" + n.shortcode + "/" : "",
    };
  }).filter(p => p.externalId && p.ts);

  return {
    posts, source: "instagram-public",
    meta: { totalPosts: media.count, followers: (user.edge_followed_by || {}).count },
    note: "Public endpoint — returns about the last 12 posts",
  };
}

/* ═══════════════════ facebook ═══════════════════ */

function fbTarget(ch) {
  const u = String(ch.url || "").trim();
  if (/facebook\.com/i.test(u)) return u.replace(/\/+$/, "");
  const h = String(ch.handle || "").replace(/^@/, "").trim();
  return h ? "https://www.facebook.com/" + h : "";
}

/* FB items carry an ISO `time` and usually a numeric `timestamp` too — prefer the ISO one, and if
   only the number is there, read it as seconds or milliseconds by its magnitude. */
function fbWhen(it) {
  if (it.time && isFinite(new Date(it.time).getTime())) return new Date(it.time).getTime();
  const n = Number(it.timestamp);
  if (isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  return NaN;
}

/* apify/facebook-posts-scraper: postId, time/timestamp, text, url, media[], counts. captionText is
   off — it transcribes a video's speech, which this check never reads and which is billed extra. */
function fbParseApify(items) {
  return items.map(it => {
    if (!it || apifyItemError(it)) return null;
    const ms = fbWhen(it);
    const id = String(it.postId || it.facebookId || it.url || "").trim();
    if (!id || !isFinite(ms)) return null;
    const media = Array.isArray(it.media) ? it.media : [];
    const hasVideo = media.some(m => /video/i.test(String((m && (m.__typename || m.type)) || "")) || (m && m.videoUrl));
    const reel = /\/reel\//.test(String(it.url || ""));
    return {
      externalId: id, ts: new Date(ms).toISOString(),
      kind: reel ? "reel" : hasVideo ? "video" : media.length > 1 ? "carousel" : media.length === 1 ? "photo" : (it.link ? "link" : "text"),
      text: String(it.text || ""),
      permalink: it.url || it.facebookUrl || "",
      likes: num(it.likes), comments: num(it.comments), reposts: num(it.shares), views: num(it.viewsCount),
      thumb: (media[0] && (media[0].thumbnail || (media[0].photo_image && media[0].photo_image.uri))) || "",
    };
  }).filter(Boolean).sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

/* Facebook has no public post list a server can read — mbasic is gone and /posts sits behind a
   login wall — so without APIFY_TOKEN the dispatcher below never calls this; it reports the channel
   as one for the extension instead. */
async function collectFacebook(ch) {
  const pageUrl = fbTarget(ch);
  if (!pageUrl) throw new Error("No Facebook page URL could be read from this channel");
  if (!process.env.APIFY_TOKEN) throw new Error("Facebook needs APIFY_TOKEN to be read server-side.");
  return apifyRead("facebook", "fb:" + pageUrl.toLowerCase(), {
    startUrls: [{ url: pageUrl }], resultsLimit: APIFY_MAX_POSTS, captionText: false,
  }, fbParseApify, pageUrl.replace(/^https?:\/\/(www\.)?/, ""));
}

/* ═══════════════════ tiktok ═══════════════════ */

/* clockworks/tiktok-scraper, profile "videos" tab, newest first, pinned videos excluded — an old
   pinned video must never read as today's. Every download option is off (each is billed on its
   own) and so is the proxy-country choice (a paid add-on). No date filter either: on this actor it
   is a paid add-on, and an earlier run that used one came back with nothing at all. A reshare
   carries someone else's authorMeta and is dropped. */
function ttParseApify(items, name) {
  const me = name.toLowerCase();
  return items.map(it => {
    if (!it || apifyItemError(it)) return null;
    const ms = new Date(it.createTimeISO || (it.createTime ? it.createTime * 1000 : 0)).getTime();
    const id = String(it.id || "").trim();
    if (!id || !isFinite(ms) || ms <= 0) return null;
    const owner = String((it.authorMeta && (it.authorMeta.name || it.authorMeta.uniqueId)) || "").toLowerCase();
    if (owner && owner !== me) return null;
    return {
      externalId: id, ts: new Date(ms).toISOString(), kind: "video",
      text: String(it.text || ""),
      permalink: it.webVideoUrl || ("https://www.tiktok.com/@" + name + "/video/" + id),
      views: num(it.playCount), likes: num(it.diggCount), comments: num(it.commentCount), reposts: num(it.shareCount),
      duration: num(it.videoMeta && it.videoMeta.duration),
      thumb: (it.videoMeta && (it.videoMeta.coverUrl || it.videoMeta.originalCoverUrl)) || "",
    };
  }).filter(Boolean).sort((a, b) => new Date(b.ts) - new Date(a.ts));
}

/* TikTok refuses server requests outright and has no free public feed: Apify is the only server
   route. Without a token it is reported as unknown, never as empty. */
async function collectTiktok(ch) {
  const name = ttTarget(ch);
  if (!name) throw new Error("No TikTok username could be read from this channel");
  if (!process.env.APIFY_TOKEN) throw new Error("TikTok needs APIFY_TOKEN to be read server-side.");
  return apifyRead("tiktok", "tt:" + name.toLowerCase(), {
    profiles: [name], resultsPerPage: APIFY_MAX_POSTS, profileScrapeSections: ["videos"],
    profileSorting: "latest", excludePinnedPosts: true,
    shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSlideshowImages: false,
    shouldDownloadAvatars: false, shouldDownloadMusicCovers: false,
    downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES", proxyCountryCode: "None",
  }, items => ttParseApify(items, name), "@" + name);
}

/* ═══════════════════ telegram bot (1:1 DMs, via a user session) ═══════════════════ */

/* A Telegram BOT sends reels 1:1 — private DMs with no public page to scrape (unlike a channel's
   t.me/s/ preview). The only way to read them is to BE the account they were sent to. So this reads
   the bot's chat through a Telegram USER session (MTProto/GramJS): the account that started the bot
   fetches its own recent incoming messages. GramJS is required lazily — only this collector needs
   it, so the rest of the app (and the tests) load with no dependency. Env: TG_API_ID, TG_API_HASH,
   TG_SESSION (a StringSession made once by tg-login.js). Cached, with the same stale-read fallback. */
async function collectTgBot(ch) {
  const target = tgBotTarget(ch);
  if (!target) throw new Error("No Telegram bot name could be read from this channel");
  if (!process.env.TG_SESSION || !process.env.TG_API_ID || !process.env.TG_API_HASH)
    throw new Error("Telegram bot needs TG_API_ID / TG_API_HASH / TG_SESSION set (run tg-login.js once)");

  const cacheName = "tgbot:" + target.toLowerCase();
  try {
    const c = await ingest.cacheGet(cacheName, 15 * 60e3);
    if (c && c.length) return { posts: c, source: "telegram-mtproto", note: "read via Telegram user-session (cached ~15 min)" };
  } catch (e) { /* cache miss is fine */ }

  let messages;
  try {
    const { TelegramClient } = require("telegram");
    const { StringSession } = require("telegram/sessions");
    const client = new TelegramClient(new StringSession(process.env.TG_SESSION),
      Number(process.env.TG_API_ID), process.env.TG_API_HASH, { connectionRetries: 2, baseLogger: { info(){}, warn(){}, error(){}, debug(){} } });
    await client.connect();
    try {
      const entity = await client.getEntity(target);
      messages = await client.getMessages(entity, { limit: 30 });
    } finally { await client.disconnect().catch(() => {}); }
  } catch (err) {
    const stale = await staleRead(cacheName);
    if (stale) return { posts: stale, source: "telegram-mtproto", note: "Telegram read failed — showing the last good read (" + (err.message || err) + ")" };
    throw err;
  }

  const posts = (messages || []).map(m => {
    if (!m || m.out) return null;                 // skip our own outgoing (/start etc.), keep the bot's
    const ms = m.date ? m.date * 1000 : 0;
    const id = m.id != null ? String(m.id) : "";
    if (!id || !ms) return null;
    const text = String(m.message || m.text || "");
    const hasMedia = !!m.media;
    if (!text && !hasMedia) return null;          // pure service message — not a post
    return {
      externalId: "tg-" + id, ts: new Date(ms).toISOString(),
      kind: hasMedia ? "video" : "post",
      text: text || "[media]",
      permalink: "https://t.me/" + target,
    };
  }).filter(Boolean).sort((a, b) => new Date(b.ts) - new Date(a.ts));

  if (!posts.length) throw new Error("No messages read from @" + target + " — treat this as unknown, not empty.");
  try { await ingest.cacheSet(cacheName, posts); } catch (e) { /* best-effort */ }
  return { posts, source: "telegram-mtproto", note: "read server-side via a Telegram user-session" };
}

/* ═══════════════════ viber (pushed in, not read out) ═══════════════════ */

/* Viber is the one channel here that cannot be read at all: its invite page carries no posts, it
   ships no web client for the extension to drive, and the desktop app's message store is
   encrypted. Rather than lose the channel, the direction is reversed — whatever publishes to
   Viber pushes its posts to /api/ingest, and this reads them back.

   That makes it strictly more dependable than the platforms that *are* readable, because nothing
   Viber changes can break it. What it cannot do is invent history: it knows exactly what was
   pushed and nothing before that, so an empty store is reported as unknown rather than as a
   channel that posted nothing. */
async function collectViber(ch) {
  const posts = await ingest.getPosts(ch.id);
  if (!posts.length) {
    throw new Error("Nothing has been pushed to /api/ingest for this channel yet — " +
                    "treat this as unknown, not empty.");
  }
  return {
    posts,
    note: `${posts.length} post(s) pushed in via /api/ingest, kept for ${ingest.MAX_DAYS} days`,
  };
}

/* ═══════════════════ dispatch ═══════════════════ */

/* Without APIFY_TOKEN there is no server route at all for Facebook or TikTok, so they are handed to
   the browser extension up front instead of being reported as failures. Instagram still tries its
   public endpoint and X its free page read first — both can answer from some networks. */
const NEEDS_APIFY = {
  facebook: "Facebook has no public post list a server can read — set APIFY_TOKEN, or collect it with the browser extension.",
  tiktok: "TikTok refuses server requests — set APIFY_TOKEN, or collect it with the browser extension.",
};

/* platform:handle, lowercased — the same first-path-segment handle every collector above already
   extracts, so a pusher only ever needs to know the public name on the URL, never an internal id */
function handleAlias(ch) {
  const raw = ch.platform === "x" ? xTarget(ch)
            : ch.platform === "telegram" ? tgTarget(ch)
            : ch.platform === "instagram" ? igTarget(ch)
            : ch.platform === "tiktok" ? ttTarget(ch)
            : ch.platform === "tgbot" ? tgBotTarget(ch)
            : (pathOf(ch.url).split("/")[0] || String(ch.handle || "").replace(/^@/, ""));
  const handle = String(raw || "").trim().toLowerCase();
  return handle ? ch.platform + ":" + handle : "";
}

async function collectOne(ch, cutoff, pushedAll) {
  const base = { channelId: ch.id, platform: ch.platform, ok: false, posts: [], note: "", source: "" };

  /* Anything pushed in wins, whatever the platform.
     Reading a platform is always a reconstruction — a feed, a rendered page, captions matched by
     similarity. Whatever published the post does not have to reconstruct anything: it knows. So if
     something has pushed posts for this channel, they are used in place of guessing, and the
     platform is never asked. That is what lets Facebook stop being matched on captions, TikTok
     stop being unreadable, and Viber exist at all — the same door for all of them.

     Two keys are tried, not one. In local mode the directory lives in the browser, so the channel's
     own internal id is not something a phone automation rule — or anyone outside that browser —
     can ever know or paste in. The handle in its URL is the one thing about a channel that is
     public and stable, so a push filed under that (e.g. "sportsfc.vn", read straight off
     invite.viber.com/?g2=…) is found here even though it was never told the id. The id is tried
     first only because it is the more specific claim when both happen to exist.

     pushedAll is the whole ingest store, read ONCE by the handler below and handed to every
     channel — not re-read here. A run of N channels used to fire up to 2N separate full-table
     reads (one, sometimes two, per channel) against the same Supabase row just to answer "was
     anything pushed for this one", all in parallel; one shared read serves all of them. */
  try {
    const arr = k => (Array.isArray(pushedAll[k]) ? pushedAll[k] : []);
    let pushed = arr(ch.id);
    if (!pushed.length) {
      const alias = handleAlias(ch);
      if (alias && alias !== ch.id) pushed = arr(alias);
    }
    if (pushed.length) {
      const posts = pushed
        .filter(p => !cutoff || new Date(p.ts).getTime() >= cutoff)
        .sort((a, b) => new Date(b.ts) - new Date(a.ts));
      return { ...base, ok: true, source: "ingest", posts,
               note: `${pushed.length} post(s) pushed in via /api/ingest, kept for ${ingest.MAX_DAYS} days` };
    }
  } catch (err) { /* an unreachable store must never take a readable channel down with it */ }

  if (NEEDS_APIFY[ch.platform] && !process.env.APIFY_TOKEN) {
    return { ...base, source: "browser-required", browserRequired: true, note: NEEDS_APIFY[ch.platform] };
  }

  const fns = { youtube: collectYouTube, telegram: collectTelegram, instagram: collectInstagram,
                x: collectX, facebook: collectFacebook, tiktok: collectTiktok, tgbot: collectTgBot,
                viber: collectViber };
  const fn = fns[ch.platform];
  if (!fn) return { ...base, source: "unsupported", note: "No collector for platform " + ch.platform };

  const paid = !!process.env.APIFY_TOKEN;
  const source = { youtube: "youtube-web", telegram: "telegram-web",
                   instagram: paid ? "instagram-apify" : "instagram-public", x: paid ? "x-apify" : "x-web",
                   facebook: "facebook-apify",
                   tiktok: "tiktok-apify", tgbot: "telegram-mtproto", viber: "ingest" }[ch.platform];
  try {
    /* the window is handed to the collector so it can stop reading once it is past it —
       YouTube pages its metadata lookups and would otherwise walk the whole grid every run */
    const out = await fn(ch, cutoff);
    const posts = out.posts
      .filter(p => !cutoff || new Date(p.ts).getTime() >= cutoff)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts));
    /* cost: what this channel's Apify run billed (Apify's own figure), { usd: 0, cached: true } for a
       cached read, absent for the free readers. partialRead: the run hit its time budget. */
    return { ...base, ok: true, source: out.source || source, posts, note: out.note || "",
             resolved: out.resolved || null, meta: out.meta || null,
             cost: out.cost || null, partialRead: !!out.partialRead };
  } catch (err) {
    return {
      ...base, source,
      note: String(err.message || err),
      dead: !!err.dead,
      cost: err.cost || null,              // a run that read nothing can still have been billed
      /* instagram is the flaky one by design, so tell the UI it is worth trying in the browser */
      browserRequired: ch.platform === "instagram" && !err.dead,
    };
  }
}

/* ═══════════════════ handler ═══════════════════ */

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }

  const channels = (body && Array.isArray(body.channels) ? body.channels : [])
    .filter(c => c && c.id && c.platform)
    .slice(0, MAX_CHANNELS);

  if (!channels.length) {
    return res.status(400).json({ ok: false, error: "Send { channels: [{ id, platform, url }] }." });
  }

  /* hours is the one the daily check uses — the question is always "the last 24 hours". days is
     kept for the wider history view and for the tests. */
  const hours = body.hours !== undefined
    ? Math.min(Math.max(Number(body.hours) || 24, 1), 2160)
    : Math.min(Math.max(Number(body.days) || DEFAULT_DAYS, 1), 90) * 24;
  const cutoff = Date.now() - hours * 3600e3;

  /* One read for the whole batch — see the comment in collectOne for why. An unreachable store
     must never take a readable channel down with it, so a failure here just means every channel
     finds nothing pushed and falls through to its own collector, exactly as before. */
  let pushedAll = {};
  try { pushedAll = await ingest.readAll(); } catch (e) { pushedAll = {}; }

  const results = await Promise.all(channels.map(c => collectOne(c, cutoff, pushedAll)));

  /* What this request actually spent on Apify, summed from each run's own record. Cached reads
     count as 0; a run whose record carried no figure is counted in apifyRuns but not in the sum. */
  const runs = results.map(r => r.cost).filter(c => c && !c.cached);
  const apifyCostUsd = Math.round(runs.reduce((t, c) => t + (c.usd || 0), 0) * 1e6) / 1e6;

  return res.status(200).json({
    ok: true,
    collectedAt: new Date().toISOString(),
    hours,
    days: Math.round(hours / 24),
    apifyCostUsd,
    apifyRuns: runs.length,
    results,
  });
};

/* ═══════════════════ small utilities ═══════════════════ */

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    /* X's own renderer favours hex numeric entities ("&#x27;") where the feeds above use decimal
       or the named form — harmless here even if a decimal entity never used it, since the two
       patterns cannot both match the same text */
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

/* Telegram wraps message text in markup — links, bold, emoji spans. The report only needs the
   words, and <br> has to survive as whitespace or sentences run together and confuse the
   language check. */
function stripHtml(s) {
  return decodeXml(String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const num = v => (v === undefined || v === null || v === "" ? null : Number(v));

/* Telegram abbreviates once a post gets traction: "1.2K", "3.4M". null rather than 0 when it is
   absent, so "not reported" never renders as a real zero. */
function views(s) {
  const t = String(s || "").trim().replace(/\s/g, "");
  if (!t) return null;
  const m = t.match(/^([\d.,]+)([KkMm])?$/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(n)) return null;
  return Math.round(n * (/[Kk]/.test(m[2] || "") ? 1e3 : /[Mm]/.test(m[2] || "") ? 1e6 : 1));
}

/* "0:10" / "1:02:33" -> seconds */
function mmss(s) {
  const parts = String(s || "").trim().split(":").map(Number);
  if (!parts.length || parts.some(x => !isFinite(x))) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0) || null;
}
