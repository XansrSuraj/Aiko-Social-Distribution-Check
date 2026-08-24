/**
 * POST /api/collect  { channels:[{id,platform,url,handle,ytChannelId?}], days? }
 *   -> { ok, collectedAt, results:[ { channelId, platform, source, ok, posts:[…], note, resolved } ] }
 *
 * Reads the recent post list of every channel it can reach WITHOUT any credential:
 *
 *   youtube   — the public RSS feed (no API key, no quota, officially published by YouTube)
 *   telegram  — t.me/s/<channel>, the server-rendered preview Telegram ships for public channels
 *   instagram — the same public profile endpoint instagram.com itself calls. Undocumented and
 *               rate-limited per IP, so it is strictly best-effort: some profiles answer, some
 *               return 400/404 for reasons outside our control. Never fail the whole run over it.
 *   x         — the profile page's own server-rendered HTML, which carries schema.org microdata:
 *               one <article itemType="SocialMediaPosting"> per post with an exact ISO timestamp,
 *               the full text, the media and every counter. No token and no login.
 *   facebook  — no public path exists any more (mbasic is gone, /posts is behind a login wall),
 *               so it is reported as browser-required and collected by the extension instead.
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
/* Apify runs a scraper ("actor") on its own residential infrastructure and hands the result back
   as a dataset. The run-sync-get-dataset-items route starts the run, waits for it, and returns the
   items in a single call — which is why this has its own POST with a long leash rather than the
   get() helper above (that one is GET-only and short-timeout). Scraping is slower than a plain
   fetch, so the Vercel function is given matching room in vercel.json (maxDuration). Only ever
   called when APIFY_TOKEN is set; the callers keep their own free path for when it is not. */
const APIFY_TIMEOUT = 55000;
async function apifyItems(actorPath, input) {
  const url = "https://api.apify.com/v2/acts/" + actorPath +
              "/run-sync-get-dataset-items?token=" + encodeURIComponent(process.env.APIFY_TOKEN) +
              "&timeout=" + Math.floor(APIFY_TIMEOUT / 1000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), APIFY_TIMEOUT);
  let r;
  try {
    r = await fetch(url, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e)));
    throw new Error(aborted
      ? "Apify took too long to answer — treat this channel as unknown, not empty"
      : "Could not reach Apify: " + (e.message || e));
  } finally { clearTimeout(timer); }

  const body = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error("Apify refused the token (HTTP " + r.status + ") — check APIFY_TOKEN");
  if (r.status !== 200 && r.status !== 201) throw new Error("Apify returned HTTP " + r.status);
  let items; try { items = JSON.parse(body); } catch (e) { throw new Error("Apify answered with something that was not JSON"); }
  if (!Array.isArray(items)) items = (items && items.items) || [];
  return items;
}

/* YYYY-MM-DD, `days` ago — bounds an Apify scrape to just the recent window, which keeps every run
   fast and cheap (fewer results billed) rather than crawling a page's whole history. */
function sinceDate(days) {
  return new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
}

/* Last resort when a live Apify call fails or times out (its actors cold-start and can occasionally
   run past the function's ceiling): the last good read from the past few hours. That is still the
   same day's content, so a transient slow run shows the real posts rather than blanking the channel
   to "unknown" and inventing a gap. Self-heals the moment a fresh call succeeds again. */
async function staleApify(cacheName) {
  try { const c = await ingest.cacheGet(cacheName, 6 * 3600e3); return c && c.length ? c : null; }
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

/* the path segments x.com/twitter.com use for something other than a handle */
const X_RESERVED = /^(i|status|statuses|intent|search|home|hashtag|explore|notifications|messages|settings|compose|login|signup)$/i;
function xTarget(ch) {
  const seg = pathOf(ch.url).split("/")[0] || "";
  if (seg && !X_RESERVED.test(seg)) return seg;
  return (String(ch.handle || "").match(/@?([\w]{1,15})/) || [])[1] || "";
}

/* ═══════════════════ youtube ═══════════════════ */

/* A handle (@SportsFC-vn) is not accepted by the feed endpoint — only the UC… id is. The id is
   embedded in the channel page as "externalId", so one extra fetch resolves it. That page is
   ~1 MB, so the resolved id is handed back to the caller to cache against the channel. */
async function ytResolve(handle) {
  const r = await get("https://www.youtube.com/@" + encodeURIComponent(handle.replace(/^@/, "")));
  const m = r.body.match(/"externalId"\s*:\s*"(UC[\w-]{20,})"/) ||
            r.body.match(/channel_id=(UC[\w-]{20,})/);
  if (!m) throw new Error("Could not find the channel id on that YouTube page");
  return m[1];
}

function ytParse(xml) {
  const out = [];
  const entries = xml.split("<entry>").slice(1);
  for (const e of entries) {
    const vid = (e.match(/<yt:videoId>([^<]+)</) || [])[1];
    const pub = (e.match(/<published>([^<]+)</) || [])[1];
    if (!vid || !pub) continue;
    const title = decodeXml((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    /* media:description carries the full description; the title alone is often just a name and
       too short to tell one language from another. These channels repeat the title inside the
       description, so joining both blindly prints it twice in the report. */
    const desc = decodeXml((e.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1] || "");
    const text = !desc ? title
               : !title ? desc
               : desc.indexOf(title.trim()) !== -1 ? desc
               : title + "\n" + desc;

    /* The alternate link is /shorts/<id> for a Short and /watch?v=<id> for anything else, which
       is the one place the feed distinguishes them — the fields themselves never say. */
    const href = (e.match(/<link[^>]+href="([^"]+)"/) || [])[1] || "";
    const isShort = /\/shorts\//.test(href);

    out.push({
      externalId: vid,
      ts: pub,
      kind: isShort ? "short" : "video",
      title,
      text: text.trim(),
      views: num((e.match(/media:statistics[^>]*views="(\d+)"/) || [])[1]),
      likes: num((e.match(/media:starRating[^>]*count="(\d+)"/) || [])[1]),
      thumb: (e.match(/media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || "",
      updated: (e.match(/<updated>([^<]+)</) || [])[1] || "",
      permalink: href || "https://www.youtube.com/watch?v=" + vid,
    });
  }
  return out;
}

async function collectYouTube(ch) {
  const t = ytTarget(ch);
  let id = t.id, resolved = null;
  if (!id) {
    if (!t.handle) throw new Error("No YouTube handle or channel id could be read from this channel");
    id = await ytResolve(t.handle);
    resolved = { ytChannelId: id };
  }
  /* 404 is retried here, unlike everywhere else, because YouTube's feed does not use it to mean
     "no such channel". Under load it serves Google's generic 404 page — byte-for-byte the same
     1613 bytes for a real channel id as for one invented at random — so the status carries no
     information about existence and may well clear on a second ask. */
  const r = await get("https://www.youtube.com/feeds/videos.xml?channel_id=" + id, null, [404]);
  if (r.status !== 200) {
    /* Resolution reached a live channel page, so the channel is certainly there; whatever the
       feed is doing, this is not an empty channel and must not be read as one. */
    const known = resolved ? " The channel page loaded fine, so it exists — treat this as unknown, not empty."
                           : " Treat this as unknown, not empty.";
    throw new Error(`YouTube would not serve the feed (HTTP ${r.status}).` + known);
  }
  const posts = ytParse(r.body);
  if (!posts.length && !/<feed/i.test(r.body)) throw new Error("YouTube feed was not readable");
  return {
    posts, resolved,
    /* Shorts are not flagged anywhere in the feed and a duration lookup needs an API key,
       so long-form and Shorts are deliberately counted together rather than guessed at. */
    note: "Shorts and long-form are counted together — the feed does not distinguish them",
  };
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

async function collectX(ch) {
  const handle = xTarget(ch);
  if (!handle) throw new Error("No X (Twitter) handle could be read from this channel");

  /* Preferred path: a dedicated X API (twitterapi.io). X blocks datacenter IPs outright, so a
     serverless host cannot read the page itself — this API reads it reliably and returns JSON.
     Cached ~10 minutes, so several "Run daily check" clicks in a row cost ONE paid call, not one
     each. Only used when TWITTERAPI_KEY is set; otherwise the free direct/proxy path below runs. */
  if (process.env.TWITTERAPI_KEY) {
    const cacheName = "x:" + handle.toLowerCase();
    try {
      const cached = await ingest.cacheGet(cacheName, 10 * 60e3);
      if (cached && cached.length) return { posts: cached, source: "x-api", note: "read via twitterapi.io (cached ~10 min to save credits)" };
    } catch (e) { /* cache miss is fine */ }
    const r = await get("https://api.twitterapi.io/twitter/user/last_tweets?userName=" + encodeURIComponent(handle),
      { "X-API-Key": process.env.TWITTERAPI_KEY });
    if (r.status !== 200) throw new Error("twitterapi.io returned HTTP " + r.status + " for @" + handle);
    const apiPosts = xParseApi(r.body, handle).sort((a, b) => new Date(b.ts) - new Date(a.ts));
    if (!apiPosts.length) throw new Error("twitterapi.io returned no posts for @" + handle + " — treat as unknown, not empty.");
    try { await ingest.cacheSet(cacheName, apiPosts); } catch (e) { /* caching is best-effort */ }
    return { posts: apiPosts, source: "x-api", note: "read server-side via twitterapi.io" };
  }

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

/* ═══════════════════ instagram (best effort) ═══════════════════ */

async function collectInstagram(ch) {
  const name = igTarget(ch);
  if (!name) throw new Error("No Instagram username could be read from this channel");

  /* Preferred when APIFY_TOKEN is set: Apify's Instagram scraper, which reads from a residential
     IP and does not depend on the fragile public web endpoint below (Instagram degrades or blocks
     that one without warning). Cached ~15 min — repeated daily-check runs cost one paid call, not
     one each. Pinned posts are skipped so an old pinned post never masquerades as today's. */
  if (process.env.APIFY_TOKEN) {
    const cacheName = "ig:" + name.toLowerCase();
    try {
      const c = await ingest.cacheGet(cacheName, 15 * 60e3);
      if (c && c.length) return { posts: c, source: "instagram-apify", note: "read via Apify (cached ~15 min to save credits)" };
    } catch (e) { /* cache miss is fine */ }
    let items;
    try {
      items = await apifyItems("apify~instagram-post-scraper", {
        username: [name], resultsLimit: 25, skipPinnedPosts: true, onlyPostsNewerThan: sinceDate(12),
      });
    } catch (err) {
      const stale = await staleApify(cacheName);
      if (stale) return { posts: stale, source: "instagram-apify", note: "Apify was slow — showing the last good read (" + (err.message || err) + ")" };
      throw err;
    }
    const posts = items.map(it => {
      const ms = new Date(it.timestamp || 0).getTime();
      const id = String(it.id || it.shortCode || "").trim();
      if (!id || !isFinite(ms)) return null;
      /* a tagged / reshared post carries someone else's ownerUsername — not this channel's own */
      if (it.ownerUsername && it.ownerUsername.toLowerCase() !== name.toLowerCase()) return null;
      const t = String(it.type || "");
      return {
        externalId: id, ts: new Date(ms).toISOString(),
        kind: t === "Sidecar" ? "carousel"
            : t === "Video" ? (it.productType === "clips" ? "reel" : "video") : "image",
        text: String(it.caption || ""),
        permalink: it.url || (it.shortCode ? "https://www.instagram.com/p/" + it.shortCode + "/" : ""),
        likes: num(it.likesCount), comments: num(it.commentsCount),
        views: num(it.videoViewCount), duration: num(it.videoDuration),
        thumb: it.displayUrl || "",
      };
    }).filter(Boolean).sort((a, b) => new Date(b.ts) - new Date(a.ts));
    if (!posts.length) throw new Error("Apify returned no Instagram posts for @" + name + " — treat this as unknown, not empty.");
    try { await ingest.cacheSet(cacheName, posts); } catch (e) { /* caching is best-effort */ }
    return { posts, source: "instagram-apify", note: "read server-side via Apify" };
  }

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
    throw new Error(msg);
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
    posts,
    meta: { totalPosts: media.count, followers: (user.edge_followed_by || {}).count },
    note: "Public endpoint — returns about the last 12 posts",
  };
}

/* ═══════════════════ facebook (via Apify) ═══════════════════ */

/* Facebook has no public post list a server can read, and it will not serve one to a datacenter
   IP even if it did. The extension can drive a logged-in tab, but that ties the channel to a
   browser being open. When APIFY_TOKEN is set, Apify's Facebook scraper reads the page's recent
   posts server-side instead, so the channel reports on its own — no browser, no extension. */
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

async function collectFacebook(ch) {
  const pageUrl = fbTarget(ch);
  if (!pageUrl) throw new Error("No Facebook page URL could be read from this channel");
  if (!process.env.APIFY_TOKEN) throw new Error("Facebook needs APIFY_TOKEN set to be read server-side");

  const cacheName = "fb:" + pageUrl.toLowerCase();
  try {
    const c = await ingest.cacheGet(cacheName, 15 * 60e3);
    if (c && c.length) return { posts: c, source: "facebook-apify", note: "read via Apify (cached ~15 min to save credits)" };
  } catch (e) { /* cache miss is fine */ }

  let items;
  try {
    items = await apifyItems("apify~facebook-posts-scraper", {
      startUrls: [{ url: pageUrl }], resultsLimit: 25, onlyPostsNewerThan: sinceDate(12),
    });
  } catch (err) {
    const stale = await staleApify(cacheName);
    if (stale) return { posts: stale, source: "facebook-apify", note: "Apify was slow — showing the last good read (" + (err.message || err) + ")" };
    throw err;
  }
  const posts = items.map(it => {
    const ms = fbWhen(it);
    const id = String(it.postId || it.facebookId || it.url || "").trim();
    if (!id || !isFinite(ms)) return null;
    const media = Array.isArray(it.media) ? it.media : [];
    const hasVideo = media.some(m => /video/i.test(String((m && (m.__typename || m.type)) || "")) || (m && m.videoUrl));
    return {
      externalId: id, ts: new Date(ms).toISOString(),
      kind: hasVideo ? "video" : media.length > 1 ? "carousel" : media.length === 1 ? "photo" : (it.link ? "link" : "text"),
      text: String(it.text || ""),
      permalink: it.url || it.facebookUrl || "",
      likes: num(it.likes), comments: num(it.comments), reposts: num(it.shares), views: num(it.viewsCount),
      thumb: (media[0] && (media[0].thumbnail || (media[0].photo_image && media[0].photo_image.uri))) || "",
    };
  }).filter(Boolean).sort((a, b) => new Date(b.ts) - new Date(a.ts));
  if (!posts.length) throw new Error("Apify returned no Facebook posts for this page — treat this as unknown, not empty.");
  try { await ingest.cacheSet(cacheName, posts); } catch (e) { /* caching is best-effort */ }
  return { posts, source: "facebook-apify", note: "read server-side via Apify" };
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

/* Facebook is collectable, just not from here — the extension handles it. TikTok is not
   collectable at all: it refuses server requests and the extension does not cover it either.
   Saying "use the extension" for TikTok would send someone to a tool that will never report it,
   so the two cases are kept distinct. */
const BROWSER_ONLY = {
  facebook: "Facebook has no public post list any more — collect this one with the browser extension",
};
const UNSUPPORTED = {
  tiktok: "TikTok cannot be collected — it refuses server requests and the extension does not cover it",
};

/* platform:handle, lowercased — the same first-path-segment handle every collector above already
   extracts, so a pusher only ever needs to know the public name on the URL, never an internal id */
function handleAlias(ch) {
  const raw = ch.platform === "x" ? xTarget(ch)
            : ch.platform === "telegram" ? tgTarget(ch)
            : ch.platform === "instagram" ? igTarget(ch)
            : (pathOf(ch.url).split("/")[0] || String(ch.handle || "").replace(/^@/, ""));
  const handle = String(raw || "").trim().toLowerCase();
  return handle ? ch.platform + ":" + handle : "";
}

async function collectOne(ch, cutoff) {
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
     first only because it is the more specific claim when both happen to exist. */
  try {
    let pushed = await ingest.getPosts(ch.id);
    if (!pushed.length) {
      const alias = handleAlias(ch);
      if (alias && alias !== ch.id) pushed = await ingest.getPosts(alias);
    }
    if (pushed.length) {
      const posts = pushed
        .filter(p => !cutoff || new Date(p.ts).getTime() >= cutoff)
        .sort((a, b) => new Date(b.ts) - new Date(a.ts));
      return { ...base, ok: true, source: "ingest", posts,
               note: `${pushed.length} post(s) pushed in via /api/ingest, kept for ${ingest.MAX_DAYS} days` };
    }
  } catch (err) { /* an unreachable store must never take a readable channel down with it */ }

  if (UNSUPPORTED[ch.platform]) {
    return { ...base, source: "unsupported", unsupported: true, note: UNSUPPORTED[ch.platform] };
  }

  /* Facebook is browser-only ONLY when there is no server-side reader for it. With APIFY_TOKEN set
     it reads server-side (collectFacebook), so it falls through to the collector map instead. */
  const browserNote = BROWSER_ONLY[ch.platform];
  if (browserNote && !(ch.platform === "facebook" && process.env.APIFY_TOKEN)) {
    return { ...base, source: "browser-required", browserRequired: true, note: browserNote };
  }

  const fns = { youtube: collectYouTube, telegram: collectTelegram, instagram: collectInstagram,
                x: collectX, facebook: collectFacebook, viber: collectViber };
  const fn = fns[ch.platform];
  if (!fn) return { ...base, source: "unsupported", note: "No collector for platform " + ch.platform };

  const source = { youtube: "youtube-rss", telegram: "telegram-web",
                   instagram: "instagram-public", x: "x-web", facebook: "facebook-apify",
                   viber: "ingest" }[ch.platform];
  try {
    const out = await fn(ch);
    const posts = out.posts
      .filter(p => !cutoff || new Date(p.ts).getTime() >= cutoff)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts));
    return { ...base, ok: true, source: out.source || source, posts, note: out.note || "",
             resolved: out.resolved || null, meta: out.meta || null };
  } catch (err) {
    return {
      ...base, source,
      note: String(err.message || err),
      dead: !!err.dead,
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

  const results = await Promise.all(channels.map(c => collectOne(c, cutoff)));

  return res.status(200).json({
    ok: true,
    collectedAt: new Date().toISOString(),
    hours,
    days: Math.round(hours / 24),
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
