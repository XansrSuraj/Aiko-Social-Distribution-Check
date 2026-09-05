/**
 * Aiko Daily Check — service worker
 *
 * Collects the platforms the server cannot reach, using the sessions this browser already
 * holds. Nothing is stored, no cookie is read, no password is involved: every request is made
 * by the browser itself, from the user's own IP, with the user's own session attached the same
 * way it is when they click a link.
 *
 *   instagram — two routes, cheap one first.
 *               (1) One tab on instagram.com serves every account: a script running in it calls
 *               the same endpoints the site calls for itself. Two are tried — the mobile feed
 *               first, since web_profile_info returns an Instagram-side schema error for some
 *               accounts that no amount of retrying or logging in will clear.
 *               (2) Whatever that misses is retried by NAVIGATING to the profile page itself, one
 *               tab per account, and reading the posts Instagram embeds in the document. Route 1
 *               is a background fetch, and Instagram increasingly answers those with nothing —
 *               the same Sec-Fetch-Dest: empty refusal X was found to make. A real navigation is
 *               a different request and gets a real answer.
 *
 *   facebook   three passes, because no single one is enough:
 *
 *               · the page's HTML, fetched with cookies — real post timestamps, no tab needed,
 *                 but only ever the newest post: three creation_time markers in 2.5 MB.
 *               · captions off the rendered page — expand every "See more", then scroll until
 *                 there are enough to cover a day. This is what the report actually judges the
 *                 channel on.
 *               · the DOM date reader, only if the HTML gave nothing at all.
 *
 *               The dashboard matches Facebook on what its posts said rather than when they
 *               appeared. Its timestamps are honest about the posts it hands over and silent
 *               about the rest, so they can prove a post was made and never that one was not —
 *               and trusting them for absence is what produced false missing-post alarms.
 *
 * A tab has to be visible for any of this to work: Chrome does not lay out a tab it never shows,
 * and Facebook loads posts only as they intersect the viewport. So each page is tried quietly
 * first and brought forward only when that fails, and whichever tab the user was on is restored.
 */

/* Facebook streams its feed in and paints placeholder articles first, so there is no settle time
   that is both short enough to be quick and long enough to be safe. The scraper polls instead;
   these bound how long it will keep waiting for real content.
   FB_QUIET_WAIT is the first attempt, made in a background tab. If that only ever sees
   placeholders the tab is brought forward and FB_MAX_WAIT applies — see the comment at the
   Facebook loop for why the quiet attempt often cannot succeed. */
const FB_QUIET_WAIT = 7000;
const FB_MAX_WAIT = 22000;
const FB_POLL = 900;
const NAV_TIMEOUT = 25000;

/* ═══════════════════ instagram ═══════════════════ */

/* Runs inside an instagram.com tab. Same-origin fetch, so the session rides along and no
   CORS or CSP question arises — this is the request the page itself makes. */
async function igScrape(usernames) {
  const HDRS = { "X-IG-App-ID": "936619743392459", Accept: "application/json" };
  const out = {};

  const grab = async path => {
    const r = await fetch(path, { headers: HDRS, credentials: "include" });
    let body = null, raw = "";
    try { raw = await r.text(); body = JSON.parse(raw); } catch (e) {}
    return { status: r.status, body, raw };
  };

  /* Two routes, because the obvious one is not dependable. web_profile_info answers 400 for some
     accounts with an Instagram-side schema error ("ig_business_category_subvertical has been
     deleted") that has nothing to do with the caller and does not clear on retry or on login.
     The mobile feed endpoint does not touch that schema and carries richer media fields anyway,
     so it is tried first and web_profile_info is the fallback. */
  for (const u of usernames) {
    const tried = [];
    try {
      /* ── route 1: the mobile user feed ── */
      let res = await grab("/api/v1/feed/user/" + encodeURIComponent(u) + "/username/?count=24");
      tried.push("feed:" + res.status);
      const items = res.body && Array.isArray(res.body.items) ? res.body.items : null;
      if (items) {
        out[u] = { ok: true, route: "feed", tried, posts: items.map(it => {
          const kind = it.product_type === "clips" ? "reel"
                     : it.media_type === 8 ? "carousel"
                     : it.media_type === 2 ? "video" : "image";
          const cand = (((it.image_versions2 || {}).candidates || [])[0] || {}).url || "";
          return {
            externalId: it.code || String(it.pk || ""),
            ts: it.taken_at ? new Date(it.taken_at * 1000).toISOString() : "",
            kind,
            text: ((it.caption || {}).text) || "",
            /* nulls, not zeros: Instagram omits play counts on images and hides likes on some
               accounts, and a real 0 must stay distinguishable from "not reported" */
            views: it.play_count != null ? it.play_count
                 : (it.view_count != null ? it.view_count : null),
            likes: it.like_count != null ? it.like_count : null,
            comments: it.comment_count != null ? it.comment_count : null,
            duration: it.video_duration != null ? Math.round(it.video_duration) : null,
            width: it.original_width || null,
            height: it.original_height || null,
            slides: it.carousel_media_count || null,
            thumb: cand,
            permalink: it.code
              ? "https://www.instagram.com/" + (kind === "reel" ? "reel/" : "p/") + it.code + "/"
              : "",
          };
        }).filter(p => p.externalId && p.ts) };
        continue;
      }

      /* ── route 2: the web profile ── */
      res = await grab("/api/v1/users/web_profile_info/?username=" + encodeURIComponent(u));
      tried.push("web:" + res.status);
      if (res.status === 404) { out[u] = { ok: false, dead: true, tried, note: "No such profile" }; continue; }
      const user = res.body && res.body.data && res.body.data.user;
      if (!user) {
        const why = (res.body && res.body.message) || res.raw.slice(0, 120) || "no profile in the response";
        out[u] = { ok: false, tried, note: `both routes failed (${tried.join(", ")}) — ${why}` };
        continue;
      }
      const media = user.edge_owner_to_timeline_media || { edges: [] };
      out[u] = { ok: true, route: "web", tried, totalPosts: media.count,
        posts: (media.edges || []).map(e => {
          const n = e.node || {};
          const cap = ((n.edge_media_to_caption || {}).edges || [])[0];
          const dim = n.dimensions || {};
          const kind = n.product_type === "clips" ? "reel"
                     : n.__typename === "GraphSidecar" ? "carousel"
                     : n.__typename === "GraphVideo" || n.is_video ? "video" : "image";
          return {
            externalId: n.shortcode || n.id || "",
            ts: n.taken_at_timestamp ? new Date(n.taken_at_timestamp * 1000).toISOString() : "",
            kind,
            text: (cap && cap.node && cap.node.text) || "",
            views: n.video_view_count != null ? n.video_view_count
                 : (n.video_play_count != null ? n.video_play_count : null),
            likes: (n.edge_liked_by || n.edge_media_preview_like || {}).count ?? null,
            comments: (n.edge_media_to_comment || n.edge_media_to_parent_comment || {}).count ?? null,
            duration: n.video_duration != null ? Math.round(n.video_duration) : null,
            width: dim.width || null,
            height: dim.height || null,
            slides: kind === "carousel"
              ? ((n.edge_sidecar_to_children || {}).edges || []).length || null : null,
            thumb: n.thumbnail_src || n.display_url || "",
            permalink: n.shortcode
              ? "https://www.instagram.com/" + (kind === "reel" ? "reel/" : "p/") + n.shortcode + "/"
              : "",
          };
        }).filter(p => p.externalId && p.ts) };
    } catch (e) {
      out[u] = { ok: false, tried, note: String((e && e.message) || e) };
    }
  }
  return out;
}

/* ═══════════════════ instagram: the profile tab ═══════════════════
 *
 * The route above asks Instagram's API from inside an instagram.com tab. That is a background
 * fetch, and it carries Sec-Fetch-Dest: empty — which is exactly the request shape X was found to
 * refuse (see the X section below), and Instagram throttles it the same way: the call is accepted
 * and answered with nothing, so the channel reports "ran, collected nothing" with no error to show
 * for it. A real top-level navigation is a different request entirely, and Instagram answers it
 * with the profile AND the first page of posts embedded in the document.
 *
 * So this is the second route: open the profile itself in a tab and read the posts out of the page
 * Instagram actually served. No API call, no app id, no session assumptions beyond the ones the
 * browser already has.
 *
 * The posts arrive as JSON in <script type="application/json"> blocks, minified and deeply nested,
 * and the nesting changes between Instagram builds. Rather than reach for a fixed path — which is
 * what would break silently on the next redesign — every block is parsed and walked, keeping any
 * node that carries BOTH a shortcode and a taken_at instant. That pair is a post wherever
 * Instagram decides to file it.
 */
function igTabScrape(handle, maxWaitMs, pollMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wanted = String(handle || "").toLowerCase();
  const budget = maxWaitMs == null ? 14000 : Number(maxWaitMs);
  const gap = pollMs == null ? 800 : Number(pollMs);
  const deadline = Date.now() + budget;

  const seen = new Map();
  const num = v => (v === undefined || v === null || v === "" ? null : Number(v));

  const keep = node => {
    const code = node.code || node.shortcode;
    if (typeof code !== "string" || !/^[\w-]{5,30}$/.test(code)) return;
    const at = Number(node.taken_at != null ? node.taken_at : node.taken_at_timestamp);
    if (!isFinite(at) || at < 1e9 || at > 4e9) return;          // not a plausible post instant
    /* a tagged, suggested or "related" post belongs to someone else — never this channel's */
    const owner = String((node.owner && node.owner.username) ||
                         (node.user && node.user.username) || "").toLowerCase();
    if (owner && wanted && owner !== wanted) return;
    if (seen.has(code)) return;

    const capNode = node.caption;
    const text = typeof capNode === "string" ? capNode
               : (capNode && capNode.text) ? capNode.text
               : (((node.edge_media_to_caption || {}).edges || [])[0] || {}).node?.text || "";
    const isClip = node.product_type === "clips";
    const mt = Number(node.media_type);
    seen.set(code, {
      externalId: code,
      ts: new Date(at * 1000).toISOString(),
      kind: isClip ? "reel" : mt === 8 ? "carousel" : mt === 2 ? "video" : "image",
      text: text || "",
      /* nulls, not zeros — Instagram omits play counts on images and hides likes on some accounts,
         and a real 0 has to stay distinguishable from "not reported" */
      views: num(node.play_count != null ? node.play_count : node.view_count),
      likes: num(node.like_count),
      comments: num(node.comment_count),
      duration: node.video_duration != null ? Math.round(Number(node.video_duration)) : null,
      thumb: (((node.image_versions2 || {}).candidates || [])[0] || {}).url || node.display_url || "",
      permalink: "https://www.instagram.com/" + (isClip ? "reel/" : "p/") + code + "/",
    });
  };

  /* The depth cap has to clear Meta's wrapper, which is enormous before any post is reached:
     require[] -> ["ScheduledServerJS"…] -> [{__bbox}] -> __bbox -> require[] ->
     ["RelayPrefetchedStreamCache"…] -> ["adp_…",{__bbox}] -> __bbox -> result -> data ->
     xdt_api__v1__feed__user_timeline_graphql_connection -> edges[] -> {node}
     — sixteen levels down, counting one per array element as well as per key. A cap of 14 meant
     this walk could never reach a single real post on a live profile while every fixture in the
     test suite (all ten levels deep) passed happily. The cap is only a runaway guard, so it is set
     far above anything Meta plausibly nests; the seen-Map bounds the output, and JSON.parse output
     cannot contain a cycle. */
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 60) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    keep(v);
    for (const k in v) {
      const child = v[k];
      if (child && typeof child === "object") walk(child, depth + 1);
    }
  };

  const scanOnce = () => {
    const blocks = document.querySelectorAll('script[type="application/json"]');
    for (const b of blocks) {
      const raw = b.textContent || "";
      if (raw.length < 40) continue;
      /* only blocks that could possibly hold a post — parsing every one of a hundred config blobs
         on every poll is wasted work */
      if (raw.indexOf("taken_at") === -1) continue;
      try { walk(JSON.parse(raw), 0); } catch (e) { /* not this block */ }
    }
    return blocks.length;
  };

  return (async () => {
    let blocks = 0, rounds = 0;
    while (Date.now() < deadline) {
      blocks = scanOnce();
      rounds++;
      if (seen.size >= 12) break;                 // plenty to cover a day
      await sleep(gap);
      if (seen.size && rounds >= 3) break;        // it has what it is going to give
    }

    /* the grid's own links, as corroboration — they prove posts exist even in the case where no
       instant could be read, which is the difference between "nothing posted" and "could not read" */
    const gridCodes = new Map();
    for (const a of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
      const m = (a.getAttribute("href") || "").match(/\/(p|reel)\/([\w-]+)/);
      if (!m) continue;
      if (!gridCodes.has(m[2])) {
        const img = a.querySelector("img");
        gridCodes.set(m[2], { kind: m[1] === "reel" ? "reel" : "image",
                              text: (img && img.getAttribute("alt")) || "",
                              thumb: (img && img.getAttribute("src")) || "" });
      }
    }

    /* ── ask each post for its own date ────────────────────────────────────────
       The grid renders the posts but carries no instant for any of them — measured live: twelve
       posts on the page, zero dates anywhere in its JSON. Without a date a post cannot be matched
       to a drop, so the channel reported nothing while a dozen posts sat plainly on screen.
       Instagram will still say WHEN each one went out, one post at a time: /p/<code>/embed/ is a
       public, keyless page that carries the post's own timestamp. It is same-origin from here, so
       the session rides along and no permission question arises.
       Deliberately NOT derived from the shortcode. A shortcode does encode a timestamp, but the
       decoding could not be checked against a known-good post from here, and a plausible-looking
       date that is quietly wrong is far worse than no date at all — it would silently match posts
       to the wrong drops. This asks Instagram and believes only what it answers. */
    if (!seen.size && gridCodes.size) {
      const codes = [...gridCodes.keys()].slice(0, 14);
      const budget = Date.now() + 20000;
      for (const code of codes) {
        if (Date.now() > budget) break;
        let html = "";
        try {
          const r = await fetch("/p/" + encodeURIComponent(code) + "/embed/captioned/",
                                { credentials: "include" });
          if (r.ok) html = await r.text();
        } catch (e) { /* one post failing is not the channel failing */ }
        if (!html) continue;
        let at = null;
        const unix = html.match(/"taken_at_timestamp"\s*:\s*(\d{9,11})/);
        if (unix) at = Number(unix[1]) * 1000;
        if (at === null) {
          const dt = html.match(/datetime="([^"]+)"/);
          const t = dt ? new Date(dt[1]).getTime() : NaN;
          if (isFinite(t)) at = t;
        }
        /* no date found means no date claimed — the post is simply left out */
        if (at === null || !isFinite(at)) continue;
        const meta = gridCodes.get(code) || {};
        const cap = html.match(/"edge_media_to_caption"[\s\S]{0,200}?"text"\s*:\s*"((?:[^"\\]|\\.){0,600})"/);
        let text = meta.text || "";
        if (cap) { try { text = JSON.parse('"' + cap[1] + '"'); } catch (e) {} }
        seen.set(code, {
          externalId: code,
          ts: new Date(at).toISOString(),
          kind: meta.kind === "reel" ? "reel" : "image",
          text,
          views: null, likes: null, comments: null, duration: null,
          thumb: meta.thumb || "",
          permalink: "https://www.instagram.com/" + (meta.kind === "reel" ? "reel/" : "p/") + code + "/",
        });
      }
    }

    const posts = [...seen.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts));
    let diag = "";
    if (!posts.length) {
      const bodyText = (document.body && document.body.innerText || "").slice(0, 3000);
      if (/^\/accounts\/login/.test(location.pathname) ||
          document.querySelector('input[name="password"], input[name="username"]'))
        diag = "a login page is showing — this browser is not logged into instagram.com";
      else if (/sorry, this page isn.t available/i.test(bodyText)) diag = "Instagram says this profile does not exist";
      else if (/this account is private/i.test(bodyText)) diag = "this account is private to the logged-in user";
      else if (gridCodes.size) diag = `the grid shows ${gridCodes.size} post(s), but neither the ` +
        `page's own data nor asking each post for its date returned one`;
      else diag = `no post data was embedded in the page (${blocks} json block(s), ${rounds} pass(es))`;
    }
    /* the grid in page order (newest first), so the caller can walk it post by post when no
       instant could be read here — see igTabCollect */
    const gridList = [...gridCodes.entries()].slice(0, 20)
      .map(([code, meta]) => ({ code, kind: meta.kind, thumb: meta.thumb }));
    return { posts, diag, blocks, rounds, gridCodes: gridCodes.size, gridList, url: location.href };
  })();
}

/* Runs inside a single Instagram POST page. A post page states its own instant plainly — Instagram
   puts it in the page data and in a <time datetime> the post itself renders — so this needs none of
   the guesswork the profile grid forced. Kept deliberately small: it is serialised into the page
   and cut off from every outer binding, and it is run once per post, so it must be cheap. */
function igPostRead() {
  const html = document.documentElement ? document.documentElement.innerHTML : "";
  let at = null;

  const unix = html.match(/"taken_at(?:_timestamp)?"\s*:\s*(\d{9,11})/);
  if (unix) at = Number(unix[1]) * 1000;
  if (at === null) {
    /* the timestamp the post shows a reader — an absolute instant, not a "2h" label */
    const t = document.querySelector("time[datetime]");
    const d = t ? new Date(t.getAttribute("datetime")).getTime() : NaN;
    if (isFinite(d)) at = d;
  }
  /* a date outside anything plausible is not a date — better none than a wrong one */
  if (at !== null && (!isFinite(at) || at < 1.2e12 || at > Date.now() + 864e5)) at = null;

  let text = "";
  const cap = html.match(/"edge_media_to_caption"[\s\S]{0,300}?"text"\s*:\s*"((?:[^"\\]|\\.){0,900})"/);
  if (cap) { try { text = JSON.parse('"' + cap[1] + '"'); } catch (e) {} }
  if (!text) {
    const og = document.querySelector('meta[property="og:description"], meta[name="description"]');
    text = (og && og.getAttribute("content")) || "";
  }

  /* counts only if the page states them outright; nulls otherwise, never a fabricated zero */
  const numOf = re => { const m = html.match(re); return m ? Number(m[1]) : null; };
  return {
    at, text,
    likes: numOf(/"edge_media_preview_like"\s*:\s*\{\s*"count"\s*:\s*(\d+)/),
    views: numOf(/"video_view_count"\s*:\s*(\d+)/),
    loginWall: /^\/accounts\/login/.test(location.pathname),
  };
}

/* one tab per account: the profile page IS the request that works, so each account needs its own */
async function igTabCollect(channels, onProgress, onResult) {
  const out = [];
  /* hand each channel over the instant it is done — see collect()'s note on why batching is unsafe */
  const done = r => { out.push(r); try { if (onResult) onResult(r); } catch (e) {} };
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const handle = String(c.username || c.handle || "").replace(/^@/, "").trim();
    onProgress(`Instagram — @${handle} via its profile page (${i + 1}/${channels.length})…`);
    let tabId = null;
    try {
      if (!handle) throw new Error("No Instagram handle for this channel");
      const tab = await chrome.tabs.create({ url: "https://www.instagram.com/" + encodeURIComponent(handle) + "/", active: false });
      tabId = tab.id;
      await waitForLoad(tabId);
      const res = await runInTab(tabId, igTabScrape, [handle, 14000, 800]);
      let posts = (res && res.posts) || [];
      let via = "the profile page";

      /* ── walk the grid post by post when the page gave no instants ────────────
         Measured on this account: twelve posts render, the page carries no date for any of them,
         AND every background request for one is refused — the API answered 429 and so did each
         post's embed. But the profile page itself rendered perfectly, which is the tell: Instagram
         is throttling this browser's FETCHES while serving its NAVIGATIONS normally. It is the
         same distinction X taught us, and the answer is the same — stop fetching, navigate.
         So the one tab already open is walked through each post in turn. Newest first, stopping as
         soon as a post is older than the window, so a channel that posted six times today costs
         seven navigations rather than twenty. */
      const grid = (res && res.gridList) || [];
      if (!posts.length && grid.length) {
        const cutoff = Date.now() - 36 * 3600e3;      // comfortably past any window the report asks for
        const budget = Date.now() + 60000;
        const got = [];
        for (const g of grid) {
          if (Date.now() > budget) break;
          onProgress(`Instagram — @${handle}: reading post ${got.length + 1} of up to ${grid.length}…`);
          try {
            await chrome.tabs.update(tabId, { url: "https://www.instagram.com/p/" + encodeURIComponent(g.code) + "/" });
            await waitForLoad(tabId);
            const one = await runInTab(tabId, igPostRead, []);
            if (!one || !one.at || !isFinite(one.at)) continue;   // no date claimed, so no post filed
            if (one.at < cutoff) break;                            // past the window — the rest are older still
            got.push({
              externalId: g.code,
              ts: new Date(one.at).toISOString(),
              kind: g.kind === "reel" ? "reel" : "image",
              text: one.text || "",
              views: one.views != null ? one.views : null,
              likes: one.likes != null ? one.likes : null,
              comments: null, duration: null,
              thumb: g.thumb || "",
              permalink: "https://www.instagram.com/" + (g.kind === "reel" ? "reel/" : "p/") + g.code + "/",
            });
          } catch (e) { /* one post failing is not the channel failing */ }
        }
        if (got.length) { posts = got.sort((a, b) => new Date(b.ts) - new Date(a.ts)); via = "each post's own page"; }
      }

      if (!posts.length) throw new Error("Instagram's profile page gave no readable posts for @" + handle +
        " — treat as unknown, not empty." + (res && res.diag ? " (" + res.diag + ")" : ""));
      done({ channelId: c.id, platform: "instagram", username: handle, ok: true,
                 note: `${posts.length} post(s) via ${via} (extension)` +
                       (res.gridCodes ? ` · ${res.gridCodes} in the grid` : ""),
                 posts, source: "extension-instagram-page" });
    } catch (e) {
      done({ channelId: c.id, platform: "instagram", username: handle, ok: false,
                 note: String((e && e.message) || e), posts: [], source: "extension-instagram-page" });
    } finally {
      if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
  return out;
}

/* ═══════════════════ facebook: the fetch routes ═══════════════════ */

/* Reading Facebook by rendering a tab and parsing "2h" off the DOM lost, repeatedly. Chrome will
   not lay out a hidden tab, Facebook loads posts only on intersection, and even with the tab
   brought forward most of the feed was still placeholders after twenty-two seconds. The relative
   labels it does render are also the weakest possible evidence — no date, just "2h".

   So stop rendering. The page's own HTML carries real unix timestamps for its posts, and a plain
   fetch from here has the user's cookies attached, needs no tab, no layout and no waiting. When it
   works the result is strictly better than the DOM ever gave: exact instants, which let Facebook
   join the drop matching instead of contributing a bare count.

   It cannot be verified from outside a logged-in session — every route answers 400 to anything
   else — so every attempt is logged with what it saw, and a run whose evidence does not hang
   together reports that rather than guessing. */

const FB_HTML_ROUTES = [
  u => `https://m.facebook.com/${u}`,
  u => `https://www.facebook.com/${u}`,
  u => `https://m.facebook.com/${u}/posts`,
];

/* Entry points tried in a real tab when the payload is not enough — which it never is for anything
   but the newest post. Which of these renders a full timeline varies by page and by week, so they
   are tried in turn and their captions pooled rather than betting on one. */
const FB_TAB_ROUTES = [
  u => `https://www.facebook.com/${u}`,
  u => `https://m.facebook.com/${u}?v=timeline`,
  u => `https://www.facebook.com/${u}/videos`,
];
/* enough to cover a day of drops with room to spare */
const FB_WANT_CAPTIONS = 10;
/* captions travel as objects; the payload parser still yields plain strings, so both are accepted */
const capObj = t => (t && typeof t === "object" ? t : { text: String(t || "") });
const capKey = t => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 120);

/* markers seen in Facebook's own payloads, newest style first */
const FB_STAMP_RX = [
  ["creation_time", /"creation_time"\s*:\s*(\d{10,13})/g],
  ["publish_time", /"publish_time"\s*:\s*(\d{10,13})/g],
  ["created_time", /"created_time"\s*:\s*(\d{10,13})/g],
  ["data-utime", /data-utime="(\d{10})"/g],
  ["store-time", /&quot;time&quot;\s*:\s*(\d{10})/g],
];
const FB_ID_RX = [
  /\/posts\/(pfbid[\w-]+)/g,
  /"post_id"\s*:\s*"?(\d{6,})/g,
  /story_fbid=(\d{6,}|pfbid[\w-]+)/g,
];

function fbParseHtml(html, nowMs) {
  const markers = {};
  const stamps = new Set();
  const now = nowMs || Date.now();

  for (const [name, rx] of FB_STAMP_RX) {
    rx.lastIndex = 0;
    let m, hits = 0;
    while ((m = rx.exec(html)) !== null) {
      if (++hits > 400) break;
      const raw = Number(m[1]);
      if (!isFinite(raw)) continue;
      const ms = raw < 1e11 ? raw * 1000 : raw;
      /* keep only plausible post times: not the future, not older than two months. Facebook's
         payloads are full of unrelated epochs — config stamps, cache keys, session times. */
      if (ms > now + 3600e3 || ms < now - 60 * 86400e3) continue;
      stamps.add(ms);
    }
    if (hits) markers[name] = hits;
  }

  const ids = new Set();
  for (const rx of FB_ID_RX) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(html)) !== null) { ids.add(m[1]); if (ids.size > 200) break; }
  }

  /* Post text, for the language check. Only used when there is exactly one text per timestamp —
     pairing them positionally otherwise would eventually pin the wrong caption to a post and
     report a language fault that is not there. Better no verdict than a wrong one. */
  const texts = [];
  /* the message key specifically, not any "text" — and long enough to be a post rather than a
     label. A looser pattern pulled in the whole interface when it was tried against the DOM. */
  const trx = /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.){40,1200})"/g;
  let tm;
  while ((tm = trx.exec(html)) !== null) {
    try {
      const t = JSON.parse('"' + tm[1] + '"');
      if (t.trim().length >= 40) texts.push(t);
    } catch (e) {}
    if (texts.length > 60) break;
  }

  const login = /\/login\/\?next|name="pass"|id="email"/.test(html) &&
                !/role="article"|"creation_time"/.test(html);

  return { markers, stamps: [...stamps].sort((a, b) => b - a), ids: [...ids], texts, login,
           bytes: html.length };
}

/* Runs in the service worker: a plain credentialed fetch, no tab involved. */
async function fbFetchPosts(username) {
  const log = [];
  for (const make of FB_HTML_ROUTES) {
    const url = make(encodeURIComponent(username));
    try {
      const r = await fetch(url, {
        credentials: "include", redirect: "follow",
        headers: { "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,*/*" },
      });
      const html = await r.text();
      const p = fbParseHtml(html);
      log.push({ url, status: r.status, bytes: p.bytes, stamps: p.stamps.length,
                 ids: p.ids.length, texts: p.texts.length, markers: p.markers, login: p.login });
      if (p.login || !p.stamps.length) continue;

      /* Sanity before trust. Post ids and timestamps should be in the same ballpark; wildly more
         stamps than ids means the regexes are catching things that are not posts, and a count
         built on that would be confidently wrong. */
      if (p.ids.length && p.stamps.length > p.ids.length * 4) {
        log[log.length - 1].rejected = "far more timestamps than posts — not trusting these";
        continue;
      }

      const pairText = p.texts.length === p.stamps.length;
      if (!pairText && p.texts.length) log[log.length - 1].textsUnpaired = true;
      return {
        ok: true, route: url, log, pairedText: pairText,
        /* Every caption found, unpaired. Facebook's HTML reaches back only a few posts and its
           timestamps cannot be trusted to cover a whole day, so the dashboard matches this channel
           on what the posts said rather than when they appeared — for which an unordered bag is
           enough, and is available even when pairing captions to instants is not. */
        captions: p.texts.slice(0, 40),
        posts: p.stamps.map((ms, i) => ({
          externalId: p.ids[i] || ("fb-" + ms),
          ts: new Date(ms).toISOString(),
          kind: "post",
          text: pairText ? p.texts[i] : "",
          permalink: p.ids[i] ? `https://www.facebook.com/${username}/posts/${p.ids[i]}` : "",
        })),
      };
    } catch (e) {
      log.push({ url, error: String((e && e.message) || e) });
    }
  }
  return { ok: false, log };
}

/* ═══════════════════ facebook: captions from the rendered page ═══════════════════ */

/* Runs in a Page tab, and its only job is the words.
   Two things make this necessary. The HTML payload does carry post text, but not under a key
   shape that could be found from outside a logged-in session, so captions kept coming back empty
   while timestamps arrived fine — and a Facebook channel matched on content with no captions
   reports every drop as missing, which is precisely the false alarm this must never raise.
   Second, Facebook collapses long captions to a bare link plus "See more", so even the rendered
   text is useless until those are expanded. Hence: expand, settle, then harvest. */
async function fbCaptionScrape(maxWaitMs, pollMs, wantCount) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const budget = maxWaitMs == null ? 22000 : Number(maxWaitMs);
  const gap = pollMs == null ? 900 : Number(pollMs);
  const want = wantCount == null ? 12 : Number(wantCount);
  const deadline = Date.now() + budget;

  /* the label Facebook puts on the expander, in the languages these pages run in */
  const MORE = /^(see more|xem thêm|see translation|ดูเพิ่มเติม|查看更多|más|mehr)$/i;

  const expand = () => {
    let clicked = 0;
    for (const el of document.querySelectorAll('div[role="button"], span[role="button"], a[role="button"]')) {
      const t = (el.innerText || "").trim();
      if (t.length < 24 && MORE.test(t)) {
        try { el.click(); clicked++; } catch (e) {}
      }
      if (clicked > 40) break;
    }
    return clicked;
  };

  /* Chrome that turns up inside an article and is not part of the post. Left in, these become
     captions in their own right — and being in English they were reported as English posts on a
     Vietnamese channel, three false language alarms in one run. */
  const CHROME = /^(write a comment|see all photos|not yet rated|find friends|contact info|photos|videos|about|reels|like|comment|share|most relevant|all reactions|view more comments|log in|sign up)/i;

  const seen = new Map();
  /* Captions are objects, not strings: the report shows the banner beside the text so the same
     artwork can be checked across channels at a glance, and carries whatever else the post gives
     up. Extra fields never overwrite ones already known — the DOM has the picture and the counts,
     the payload usually only the words, and whichever arrives first should not lose to the other. */
  const keep = (t, extra, floor) => {
    let s = String(t || "").replace(/\n?(see more|see less|xem thêm|see translation)\s*$/i, "").trim();
    /* Forty characters is comfortably above every piece of interface text and below the posts these
       channels run — but it is a defence against chrome, not a truth about captions, and a genuinely
       short post ("🔥 GOAL! What a finish.") would be thrown away with it. So the floor drops when
       the text came out of Facebook's own message container, where it cannot be chrome. */
    if (s.length < (floor || 40)) return;
    if (/^https?:\/\/\S+$/.test(s)) return;            // a bare link is not a caption
    if (CHROME.test(s)) return;
    const key = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 120);
    if (key.length < 20) return;
    const had = seen.get(key);
    if (!had) { seen.set(key, Object.assign({ text: s.slice(0, 900) }, extra || {})); return; }
    for (const k in (extra || {})) if (extra[k] && !had[k]) had[k] = extra[k];
  };

  /* the post's own artwork — skipping avatars and reaction icons by size */
  const bannerOf = art => {
    let best = "", bestArea = 0;
    const vid = art.querySelector("video[poster]");
    if (vid) { const p = vid.getAttribute("poster"); if (p) { best = p; bestArea = 1e9; } }
    for (const im of art.querySelectorAll("img")) {
      const w = im.naturalWidth || im.width || 0, h = im.naturalHeight || im.height || 0;
      if (w < 160 || h < 160) continue;
      const area = w * h;
      if (area > bestArea && /^https?:/.test(im.src || "")) { bestArea = area; best = im.src; }
    }
    return best;
  };

  /* whatever else Facebook is willing to say about the post */
  const metaOf = art => {
    const out = {};
    for (const el of art.querySelectorAll("a[href]")) {
      const h = el.getAttribute("href") || "";
      const m = h.match(/\/(?:posts|videos|reel|permalink)\/([\w.-]+)/) || h.match(/story_fbid=([\w.-]+)/);
      if (m && !out.permalink) {
        /* absolute already, or relative to Facebook — never depend on location.origin being
           readable, since losing the permalink to that would be silent */
        out.permalink = /^https?:/.test(h) ? h.split("?")[0]
          : "https://www.facebook.com" + (h.startsWith("/") ? "" : "/") + h.split("?")[0];
      }
      const t = (el.innerText || "").trim();
      if (!out.timeLabel && t && t.length < 30 &&
          /^(just now|\d+\s*[smhdw]\b|yesterday|[A-Z][a-z]{2,}\s+\d{1,2})/i.test(t)) out.timeLabel = t;
    }
    const all = art.innerText || "";
    const react = all.match(/([\d.,]+[KM]?)\s*(reactions?|likes?)/i);
    const comm = all.match(/([\d.,]+[KM]?)\s*comments?/i);
    const views = all.match(/([\d.,]+[KM]?)\s*views?/i);
    if (react) out.reactions = react[1];
    if (comm) out.comments = comm[1];
    if (views) out.views = views[1];
    return out;
  };

  /* Why a DOM article yielded nothing, counted. The banner only ever comes from here — in the DOM
     the picture and the words sit in the same element, so the pairing is certain, whereas guessing
     which image in a payload belongs to which message would eventually attach the wrong artwork to
     a post and defeat the whole point of showing it. A live run found nine captions from the HTML
     and two from the DOM, so nearly every caption arrived without a banner. */
  const rejects = { short: 0, chrome: 0, empty: 0, dupe: 0 };

  const fromDom = () => {
    for (const art of document.querySelectorAll('[role="article"]')) {
      const msg = art.querySelector(
        '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]');
      let raw = ((msg || art).innerText || "");
      /* Without a message container the article's own text is all there is, and it opens with the
         page name and the timestamp. Dropping those leading lines is what lets the rest clear the
         length floor as a caption rather than being judged as chrome. */
      if (!msg) {
        const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
        /* Strip by what a line is, not by how long it is. Judging on length alone ate the whole
           caption of a post whose lines are short by design — "🕵️ WHO AM I?" is thirteen
           characters and is the most distinctive thing in it. Only a handle-like token, a
           timestamp or a separator goes, and never more than the first few. */
        let dropped = 0;
        while (lines.length && dropped < 3) {
          const l = lines[0];
          const isTime = /^(just now|\d+\s*[smhdw]\b|yesterday|[A-Z][a-z]{2,}\s+\d{1,2})\b/i.test(l);
          /* A page handle, not merely a single word — these are "Sportsfc.vn", "sportsfc_fans",
             so a dot, underscore or hyphen is required. Accepting any lone word would strip a
             caption that opens with one, and "GOAL!" is a plausible opening. */
          const isHandle = /^[\w-]*[._-][\w-]*$/.test(l) && l.length <= 32;
          const isSep = /^[·•\s|]+$/.test(l);
          if (!isTime && !isHandle && !isSep) break;
          lines.shift(); dropped++;
        }
        raw = lines.join("\n");
      }
      const s = raw.replace(/\n?(see more|see less|xem thêm|see translation)\s*$/i, "").trim();
      /* Out of Facebook's own message container the text cannot be interface chrome, so a
         genuinely short post is allowed to be short. Falling back to the article's own text has no
         such guarantee and keeps the higher floor. */
      const floor = msg ? 20 : 40;
      if (!s) { rejects.empty++; continue; }
      if (s.length < floor) { rejects.short++; continue; }
      if (CHROME.test(s)) { rejects.chrome++; continue; }
      const before = seen.size;
      /* the merge in keep() fills a banner into a caption the HTML found first, so an article whose
         words are already known still contributes its picture */
      keep(s, Object.assign({ thumb: bannerOf(art) }, metaOf(art)), floor);
      if (seen.size === before) rejects.dupe++;
    }
  };

  /* The page's own HTML, which grows as the feed streams in — and which turned out to be the
     source doing nearly all the work: reading only the DOM dropped a Page from 2/2 to 1/2.
     The pattern matters more than the source. A bare "text":"…" swept up the whole interface —
     sixteen "captions" off a page showing two posts, each reported as an English post on a
     Vietnamese channel. Anchoring on the message key instead confines it to post bodies, which is
     the same pattern the payload parser uses and the same one that found real captions there. */
  const fromHtml = () => {
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const rx = /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.){40,1600})"/g;
    let m, n = 0;
    while ((m = rx.exec(html)) !== null && n < 300) {
      n++;
      try { keep(JSON.parse('"' + m[1] + '"')); } catch (e) {}
    }
  };

  /* Keep going until there are enough captions to cover a day, or scrolling stops finding any.
     Stopping at the first success — which an earlier version did — meant never scrolling past the
     newest post, so a caption from yesterday was never reached at all. That is exactly why a post
     sitting on the page was reported missing. */
  /* counted per source, because which one is carrying the run is the single most useful fact when
     captions come back thin — and the answer has already flipped once */
  let clicks = 0, rounds = 0, dry = 0, domFound = 0, htmlFound = 0;
  const trace = [];
  while (Date.now() < deadline) {
    clicks += expand();
    await sleep(gap);
    rounds++;
    const before = seen.size;
    fromDom();
    domFound += seen.size - before;
    const afterDom = seen.size;
    fromHtml();
    htmlFound += seen.size - afterDom;
    trace.push(seen.size);
    if (seen.size === before) dry++; else dry = 0;
    if (seen.size >= want) break;
    if (dry >= 3) break;                                // the feed has stopped giving anything new
    const step = Math.round((window.innerHeight || 800) * 0.9);
    try { window.scrollBy(0, step); } catch (e) {}
    try {
      const de = document.documentElement;
      if (de) de.scrollTop = (de.scrollTop || 0) + step;
      const arts = document.querySelectorAll('[role="article"]');
      const last = arts[arts.length - 1];
      if (last && last.scrollIntoView) last.scrollIntoView({ block: "end" });
      window.dispatchEvent(new Event("scroll"));
    } catch (e) {}
  }

  const loginWall = /\/login\//.test(location.pathname) ||
                    !!document.querySelector('input[name="pass"], #email');
  const withBanner = [...seen.values()].filter(c => c.thumb).length;
  return { ok: !loginWall, loginWall, captions: [...seen.values()], clicks, rounds, trace,
           domFound, htmlFound, withBanner, rejects,
           articles: document.querySelectorAll('[role="article"]').length };
}

/* ═══════════════════ facebook: the DOM fallback ═══════════════════ */

/* Runs inside a Page tab. Scrolls a little to pull posts in, then classifies each post by the
   relative time Facebook prints on it.

   Counting articles alone is not good enough: [role="article"] matches every post on screen,
   which is a week's worth, so reporting it as "today" makes the whole report wrong. Each post
   carries a relative time instead ("2h", "Yesterday", "29 July"), which is enough to tell
   today from not-today without inventing an instant that Facebook never gave us.

   Anything unrecognised counts as unknown rather than being assumed recent — an undercount that
   announces itself beats an overcount that looks authoritative. The label parsing is English-UI
   only; another language lands everything in unknown, which is the safe direction. */
async function fbScrape(maxWaitMs, pollMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /* Defined in here on purpose. executeScript serialises this function and cuts it off from
     every outer binding, so anything it needs has to be declared inside it or passed in. */
  const FB_MAX_WAIT_DEFAULT = 22000, FB_POLL_DEFAULT = 900;

  /* Facebook does not put the timestamp anywhere dependable. It has been the link's own text
     ("2h"), an aria-label with the full date, a title attribute, an <abbr>, and a tooltip that
     only exists on hover. Reading one of those and giving up read 0 of 4 dates on a live page,
     which produced a channel with no data and no way to tell why. So: gather every string in the
     post that could be a time from text, aria-label and title alike, and try each one. */
  const REL_TODAY = /(^|\s)(just now|\d+\s*(s|m|h|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours))(\s|$|\b)/i;
  const REL_OLDER = /(^|\s)(yesterday|\d+\s*(d|w|y|day|days|week|weeks|year|years))(\s|$|\b)/i;
  const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
  const ABS = new RegExp(`(${MONTHS})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?|\\b(\\d{1,2})\\s+(${MONTHS})(?:\\s+(\\d{4}))?`, "i");

  const idRx = [/\/posts\/(?:pfbid)?([\w.-]+)/, /story_fbid=([\w.-]+)/, /\/videos\/(\d+)/,
                /\/reel\/(\d+)/, /\/permalink\/(\d+)/, /\/photos\/[^/]+\/(\d+)/];

  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);

  /* "today" / "before today" / null when the string is not a time at all */
  function classify(s) {
    const t = String(s || "").trim();
    if (!t || t.length > 90) return null;
    if (REL_OLDER.test(t)) return "older";
    if (REL_TODAY.test(t)) {
      /* "23h" can sit either side of midnight — only today if it still lands on today */
      const hrs = (t.match(/(\d+)\s*(h|hr|hrs|hour|hours)\b/i) || [])[1];
      if (hrs && new Date(Date.now() - Number(hrs) * 3600e3) < startOfToday) return "older";
      return "today";
    }
    const m = t.match(ABS);
    if (m) {
      /* Facebook drops the year for anything in the current one — "1 August", "July 29" — and
         Date parses those as year 2001, which would file today's post as old. Supply the year,
         and step back one if that lands in the future (a December date read in January). */
      let s = t.replace(/\s+at\s+/i, " ");
      if (!/\b\d{4}\b/.test(s)) {
        const y = startOfToday.getFullYear();
        let d = new Date(s + " " + y);
        if (!isNaN(d.getTime()) && d.getTime() > Date.now() + 86400e3) d = new Date(s + " " + (y - 1));
        if (!isNaN(d.getTime())) return d >= startOfToday ? "today" : "older";
      }
      const parsed = new Date(s);
      if (!isNaN(parsed.getTime())) return parsed >= startOfToday ? "today" : "older";
      return "older";           // a written-out date that will not parse is still not today
    }
    return null;
  }

  /* one pass over the DOM exactly as it stands right now */
  function harvest() {
    let today = 0, older = 0, unknown = 0, skeleton = 0;
    const allIds = new Set(), todayTexts = [], allTexts = [], diag = [];

    for (const art of document.querySelectorAll('[role="article"]')) {
      let verdict = null, id = "";
      const seen = [];

      /* every string in this post that might be a time, from wherever Facebook put it */
      for (const el of art.querySelectorAll("a[href], abbr, [aria-label], [title], time")) {
        const href = el.getAttribute("href") || "";
        if (!id) for (const re of idRx) { const m = href.match(re); if (m) { id = m[1]; break; } }
        const dt = el.getAttribute("datetime");
        if (dt) {
          const d = new Date(dt);
          if (!isNaN(d.getTime())) { verdict = d >= startOfToday ? "today" : "older"; seen.push("datetime=" + dt); break; }
        }
        for (const s of [el.getAttribute("aria-label"), el.getAttribute("title"),
                         (el.innerText || "").trim()]) {
          if (!s || s.length > 90) continue;
          if (seen.length < 8) seen.push(s);
          const v = classify(s);
          if (v && !verdict) verdict = v;
        }
        if (verdict) break;
      }

      /* The post's own words, for the language check. Take the message container rather than the
         article's full text: innerText also sweeps up the surrounding chrome, and if the viewer's
         Facebook is set to Vietnamese that chrome would make every English post look Vietnamese. */
      const msg = art.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
      const text = ((msg || art).innerText || "").slice(0, 600).trim();

      /* A skeleton is not a post. Facebook renders placeholder articles while the feed streams
         in, and counting them as undated posts is what produced "could not read the date on 4 of
         4" — the four were all still saying "Loading…". */
      const looksSkeleton = !verdict && !id &&
        (!seen.length || seen.every(s => /^\s*(loading|·)?\s*\.{0,3}\s*$/i.test(s))) &&
        (!text || /^\s*loading/i.test(text) || !!art.querySelector('[role="progressbar"]'));
      if (looksSkeleton) { skeleton++; continue; }

      if (id) allIds.add(id);
      /* kept regardless of whether the date could be read — content matching needs the words,
         not the instant */
      if (text && allTexts.length < 24) allTexts.push(text);

      if (verdict === "today") { today++; if (text) todayTexts.push(text); }
      else if (verdict === "older") older++;
      else {
        unknown++;
        /* record what was on offer so the selectors can be fixed from evidence, not guesswork */
        if (diag.length < 3) diag.push(seen.slice(0, 8));
      }
    }

    return { today, older, unknown, skeleton, dated: today + older,
             visible: today + older + unknown,
             todayTexts, allTexts, diag };
  }

  /* Poll instead of sleeping a fixed time. Facebook streams the feed in and paints skeletons
     first, so a fixed wait read four placeholders and reported them as four undated posts. Wait
     for real content to appear, nudging the scroll to keep it coming, and stop as soon as every
     visible post has a date. Keep the best pass seen in case it degrades later. */
  /* explicit, not `||`: passing 0 has to mean "do not wait", and a falsy default would silently
     turn it into the full 22 seconds */
  const budget = maxWaitMs == null ? FB_MAX_WAIT_DEFAULT : Number(maxWaitMs);
  const gap = pollMs == null ? FB_POLL_DEFAULT : Number(pollMs);
  const deadline = Date.now() + budget;
  let best = harvest();
  let waited = 0;
  while (Date.now() < deadline && !(best.dated > 0 && best.unknown === 0)) {
    /* Nudge the feed several ways. Facebook loads posts on intersection, and scrollBy alone does
       nothing in a tab that has not been laid out — so also drive the scroll position directly,
       pull the last article into view, and fire the event some listeners wait for. */
    const step = Math.round((window.innerHeight || 800) * 0.9);
    try { window.scrollBy(0, step); } catch (e) {}
    try {
      const de = document.documentElement;
      if (de) de.scrollTop = (de.scrollTop || 0) + step;
      const arts = document.querySelectorAll('[role="article"]');
      const last = arts[arts.length - 1];
      if (last && last.scrollIntoView) last.scrollIntoView({ block: "end" });
      window.dispatchEvent(new Event("scroll"));
    } catch (e) {}
    await sleep(gap);
    waited++;
    const snap = harvest();
    if (snap.dated > best.dated ||
        (snap.dated === best.dated && snap.visible > best.visible)) best = snap;
  }

  const loginWall = /\/login\//.test(location.pathname) ||
                    !!document.querySelector('input[name="pass"], #email');

  return {
    ok: !loginWall,
    loginWall,
    todayCount: best.today,
    olderCount: best.older,
    unknownCount: best.unknown,
    skeletonCount: best.skeleton,
    visibleCount: best.visible,
    stillLoading: best.visible === 0 && best.skeleton > 0,
    polls: waited,
    todayTexts: best.todayTexts.slice(0, 12),
    diag: best.diag,
    title: document.title,
    url: location.href,
  };
}

/* ═══════════════════ tab helpers ═══════════════════ */

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out loading the page")); }, NAV_TIMEOUT);
    function listener(id, info) { if (id === tabId && info.status === "complete") { cleanup(); resolve(); } }
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => { if (t && t.status === "complete") { cleanup(); resolve(); } })
      .catch(() => {});
  });
}

async function runInTab(tabId, fn, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args: args || [] });
  return res && res.result;
}

/* one shared instagram.com tab serves every account */
async function instagramTab() {
  const open = await chrome.tabs.query({ url: ["https://www.instagram.com/*", "https://instagram.com/*"] });
  if (open.length) return { tabId: open[0].id, reuse: true };
  const tab = await chrome.tabs.create({ url: "https://www.instagram.com/", active: false });
  await waitForLoad(tab.id);
  return { tabId: tab.id, reuse: false };
}

/* ═══════════════════ orchestration ═══════════════════ */

/* ═══════════════════ x (twitter) ═══════════════════
 *
 * The server (api/collect.js) reads X from the profile page's logged-out, server-rendered HTML —
 * schema.org microdata, one <article itemType=".../SocialMediaPosting"> per post, each with an
 * exact ISO timestamp. That works from a home IP but X can refuse a datacenter IP, which is exactly
 * where a Vercel deployment lives. So the extension is the fallback: the SAME microdata, fetched
 * from the user's own IP instead of the server's.
 *
 * The fetch is made WITHOUT credentials on purpose. The microdata lives in the LOGGED-OUT render;
 * a logged-in session is served X's client-side shell, which carries no posts to parse. Dropping
 * cookies asks for the render we can actually read, and the request still leaves from the user's
 * residential IP — the whole point of the fallback. host_permissions for x.com let the service
 * worker make this request with no CORS wall.
 *
 * The parser below is a faithful port of api/collect.js's. test/x-ext.test.js runs the same
 * fixtures through both so the two cannot drift apart unnoticed.
 */
/* ── x parse: mirror of api/collect.js ─ do not edit one without the other ─── */
const X_NUM = v => (v === undefined || v === null || v === "" ? null : Number(v));
function xDecode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function xIsoDurToSec(s) {
  const m = String(s || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Math.round(Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0));
}
const X_STAT_NAME = { Views: "views", Likes: "likes", Retweets: "reposts", Replies: "replies" };
function xArticles(html) { return html.split("<article ").slice(1); }
function xVideoOf(body) {
  const i = body.indexOf("schema.org/VideoObject");
  if (i < 0) return null;
  const w = body.slice(i, i + 1200);
  return {
    thumb: (w.match(/content="([^"]+)"\s+itemProp="thumbnailUrl"/) || [])[1] || "",
    duration: xIsoDurToSec((w.match(/content="([^"]+)"\s+itemProp="duration"/) || [])[1]),
  };
}
function xImagesOf(body) {
  return body.split("schema.org/ImageObject").slice(1).map(part => {
    const w = part.slice(0, 700);
    return (w.match(/content="([^"]+)"\s+itemProp="thumbnailUrl"/) || [])[1]
        || (w.match(/content="([^"]+)"\s+itemProp="(?:contentUrl|url)"/) || [])[1] || "";
  }).filter(Boolean);
}
function xStatsOf(body) {
  const out = {};
  for (const part of body.split('itemProp="interactionStatistic"').slice(1)) {
    const w = part.slice(0, 400);
    const name = (w.match(/content="([^"]*)"\s+itemProp="name"/) || [])[1];
    const count = (w.match(/content="([^"]*)"\s+itemProp="userInteractionCount"/) || [])[1];
    const key = X_STAT_NAME[name];
    if (key && count !== undefined) out[key] = X_NUM(count);
  }
  return out;
}
function xParsePost(rawArticle, handle) {
  const endTag = rawArticle.indexOf("</article>");
  const body = endTag === -1 ? rawArticle : rawArticle.slice(0, endTag);
  if (!/^[^>]*itemType="https:\/\/schema\.org\/SocialMediaPosting"/.test(body)) return null;

  const id = (body.match(/^[^>]*data-tweet-id="(\d+)"/) || [])[1];
  const ts = (body.match(/content="([^"]+)"\s+itemProp="datePublished"/) || [])[1];
  if (!id || !ts || isNaN(new Date(ts).getTime())) return null;

  const author = (body.match(/itemProp="author"[\s\S]{0,240}?content="([^"]*)"\s+itemProp="alternateName"/) || [])[1];
  if (!author || author.toLowerCase() !== handle.toLowerCase()) return null;

  const text = xDecode((body.match(/content="([^"]*)"\s+itemProp="text"/) || [])[1] || "");
  const video = xVideoOf(body);
  const images = video ? [] : xImagesOf(body);
  const stats = xStatsOf(body);
  const comments = stats.replies != null ? stats.replies
                  : X_NUM((body.match(/content="(\d+)"\s+itemProp="commentCount"/) || [])[1]);

  return {
    externalId: id,
    ts: new Date(ts).toISOString(),
    kind: video ? "video" : images.length > 1 ? "carousel" : images.length ? "photo" : "text",
    text,
    views: stats.views != null ? stats.views : null,
    likes: stats.likes != null ? stats.likes : null,
    comments,
    reposts: stats.reposts != null ? stats.reposts : null,
    duration: video ? video.duration : null,
    thumb: video ? video.thumb : images[0] || "",
    permalink: (body.match(/content="([^"]+)"\s+itemProp="url"/) || [])[1]
      || ("https://x.com/" + handle + "/status/" + id),
  };
}
/* ── end x parse ───────────────────────────────────────────────────────────── */

/* Both of the earlier attempts turned out to depend on how the REQUEST was made, not just where
   it left from. A background fetch() — even run from inside an x.com tab, same-origin, with the
   user's cookies — carries Sec-Fetch-Dest: empty (it announces itself as a script's own request,
   not a page load), and X answers that with an empty client shell. Only a genuine top-level
   navigation (Sec-Fetch-Dest: document) gets the full render. So this opens a REAL tab at the
   profile URL — an actual navigation, not a fetch — and reads the result from there.

   Once that page has loaded, two different things can be true of it, tried in order:
     1) the server-rendered HTML still carries schema.org microdata (the same shape api/collect.js
        reads) — read straight off document.documentElement.outerHTML, richest data, tried first.
     2) it does not (X's JS has since replaced that markup with the live app), so instead the
        actual rendered tweets are read out of the DOM — real <time datetime> timestamps, but only
        the words, the link and whatever the action bar's aria-label gives up for counts.
   This second path is inherently more fragile than everywhere else in this file: X's DOM structure
   changes without notice, unlike Facebook's and Instagram's which have stayed stable for a long
   time. Expect it to need retouching if X reshuffles its markup again. */
async function xDomScrape(handle, maxWaitMs, pollMs, sinceMs) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const WANT = 30, MAXW = maxWaitMs || 20000, POLL = pollMs || 900;
  const wantedAuthor = String(handle || "").toLowerCase();

  function numFrom(s) {
    const m = String(s || "").replace(/,/g, "").match(/([\d.]+)\s*([KkMm]?)/);
    if (!m) return null;
    let n = Number(m[1]);
    if (/k/i.test(m[2])) n *= 1000; else if (/m/i.test(m[2])) n *= 1e6;
    return Math.round(n);
  }
  /* the action bar's group aria-label reads like "12 replies, 34 reposts, 56 likes, 78 views" */
  function statsFrom(art) {
    const grp = art.querySelector('[role="group"][aria-label]');
    const label = (grp && grp.getAttribute("aria-label")) || "";
    const out = {};
    for (const [key, re] of [["comments", /([\d.,]+\s*[KkMm]?)\s*repl/i], ["reposts", /([\d.,]+\s*[KkMm]?)\s*repost/i],
                              ["likes", /([\d.,]+\s*[KkMm]?)\s*like/i], ["views", /([\d.,]+\s*[KkMm]?)\s*view/i]]) {
      const m = label.match(re);
      if (m) out[key] = numFrom(m[1]);
    }
    return out;
  }

  function harvest() {
    const posts = [], seen = new Set();
    for (const art of document.querySelectorAll('article[data-testid="tweet"], article[role="article"]')) {
      /* a repost/quote of someone else's tweet, or a promoted slot — not this account's own post */
      if (art.querySelector('[data-testid="socialContext"]')) continue;
      if (/promoted/i.test(art.getAttribute("aria-label") || "")) continue;

      const timeEl = art.querySelector("time[datetime]");
      if (!timeEl) continue;                              // still a loading placeholder
      const ts = timeEl.getAttribute("datetime");
      const link = timeEl.closest("a[href*='/status/']");
      const href = link ? link.getAttribute("href") : "";
      const idm = href.match(/\/status\/(\d+)/);
      if (!idm) continue;
      const id = idm[1];
      if (seen.has(id)) continue;

      /* confirm the author is the profile we asked for, not a quoted/embedded post from someone
         else riding along inside the same article */
      const nameBlock = art.querySelector('[data-testid="User-Name"]');
      const authorHref = nameBlock ? (nameBlock.querySelector('a[href^="/"]') || {}).getAttribute?.("href") : "";
      const author = String(authorHref || href.split("/status/")[0] || "").replace(/^\//, "").toLowerCase();
      if (author && author !== wantedAuthor) continue;

      seen.add(id);
      const textEl = art.querySelector('[data-testid="tweetText"]');
      const hasVideo = !!art.querySelector("video");
      const photos = art.querySelectorAll('[data-testid="tweetPhoto"]').length;
      posts.push({
        externalId: id, ts: new Date(ts).toISOString(),
        kind: hasVideo ? "video" : photos > 1 ? "carousel" : photos ? "photo" : "text",
        text: (textEl ? textEl.innerText : "").trim(),
        permalink: "https://x.com" + href.replace(/\?.*$/, ""),
        thumb: (art.querySelector("video, [data-testid='tweetPhoto'] img") || {}).src || "",
        ...statsFrom(art),
      });
    }
    return posts;
  }

  const start = Date.now();
  /* ACCUMULATE across polls; never keep a single snapshot.
     X's timeline is virtualised in BOTH directions — scrolling down does not merely add tweets at
     the bottom, it REMOVES the ones that leave the top from the DOM entirely. So any one harvest
     sees only a moving window of the timeline, and keeping "the biggest single harvest" meant
     keeping one arbitrary slice of it. That is what produced the second, stranger failure: the
     reader scrolled past the newest tweets, they were unmounted, and the snapshot it kept held the
     OLDER ones — so the three oldest drops were ticked and the four newest crossed, on a channel
     that had posted all seven. Union of every poll is the only correct reading of a list that
     recycles its own nodes. */
  const acc = new Map();
  let stableRounds = 0, lastCount = -1, polls = 0;
  while (Date.now() - start < MAXW) {
    polls++;
    for (const p of harvest()) if (!acc.has(p.externalId)) acc.set(p.externalId, p);
    const found = [...acc.values()];

    /* Coverage is DECIDED at the end, never used to leave early.
       Reaching back past the window says the far end is covered; it says nothing about the near
       end, and X's first paint routinely contains tweets from well before the window while the
       newest ones are still arriving. Breaking the moment an old tweet appeared therefore ended the
       scrape before the newest tweets had rendered — which is why the two most recent drops were
       crossed on a channel that had posted in both. The loop now always runs until the timeline
       stops giving anything new (or the budget ends), and coverage is computed from everything
       collected. A few seconds more per channel is worth strictly more than an early exit. */
    if (found.length >= WANT) break;

    /* "nothing new across several polls" only means STOP once something has actually been found —
       while it is still zero, X's own timeline call can simply not have answered yet (its GraphQL
       fetch is asynchronous and slow on a first load), and bailing out on zero was cutting the wait
       to ~3 polls instead of the full budget, so the answer was "no posts" before X had even tried
       to render any. Zero must exhaust the whole window before giving up.
       Six rather than three: X's timeline is virtualised and pauses between batches, so three quiet
       polls is a normal gap mid-scroll rather than the end of the timeline. Three was short enough
       that a single rendered tweet ended the run in under three seconds. */
    if (found.length > 0 && polls >= 4) {
      stableRounds = found.length === lastCount ? stableRounds + 1 : 0;
      if (stableRounds >= 6) break;
    }
    lastCount = found.length;

    /* Nudge the scroll several ways, exactly as the Facebook reader has to. scrollBy alone does
       nothing in a tab Chrome has never laid out, and X only renders further tweets as they come
       into view — so drive the scroll position directly, pull the last article into view, and fire
       the event the timeline listens on. */
    try { window.scrollBy(0, 1400); } catch (e) {}
    try {
      const de = document.documentElement;
      if (de) de.scrollTop = (de.scrollTop || 0) + 1400;
      const arts = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
      const last = arts[arts.length - 1];
      if (last && last.scrollIntoView) last.scrollIntoView({ block: "end" });
      window.dispatchEvent(new Event("scroll"));
    } catch (e) {}
    await sleep(POLL);
  }
  const best = [...acc.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  /* decided from everything collected, once the timeline has stopped giving more */
  const covered = !!(sinceMs && best.length &&
    best.reduce((m, p) => Math.min(m, new Date(p.ts).getTime()), Infinity) < sinceMs);

  /* If nothing was ever found, say something more useful than silence: a login wall reads very
     differently from a page that simply took its time, and the next person debugging this should
     not have to guess which one happened. Checked only on the empty path — it costs nothing when
     posts were actually found. */
  let diag = "";
  if (!best.length) {
    const bodyText = (document.body && document.body.innerText || "").slice(0, 4000);
    if (document.querySelector('a[href="/i/flow/login"], [data-testid="loginButton"], [data-testid="login"]') ||
        /log in to x|sign in to x/i.test(bodyText)) diag = "a login prompt is showing — the browser is not logged into x.com";
    else if (/this account doesn.t exist|user not found/i.test(bodyText)) diag = "X says this account does not exist";
    else if (/these tweets are protected|this account.s tweets are protected/i.test(bodyText)) diag = "this account's posts are protected (private)";
    else diag = `no tweet articles ever appeared in ${Math.round((Date.now() - start) / 1000)}s — X's page loaded but rendered nothing recognisable`;
  }
  /* `covered` says the scroll reached back past the window, so silence inside it is real. Without
     it the caller cannot tell "this account posted once" from "only one tweet ever rendered". */
  return { posts: best, diag, covered };
}

async function xCollect(channels, onProgress, onResult) {
  const XW = 22000, XP = 900;
  /* how far back the scroll has to reach before silence inside the window means anything. Wider
     than any window the report asks for, so "covered" is never claimed on a technicality. */
  const sinceMs = Date.now() - 36 * 3600e3;
  const out = [];
  const done = r => { out.push(r); try { if (onResult) onResult(r); } catch (e) {} };
  /* whichever tab the user was on, to put back if one has to be brought forward */
  let restoreTabId = null;
  try {
    const [act] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (act) restoreTabId = act.id;
  } catch (e) {}
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const handle = String(c.username || c.handle || "").replace(/^@/, "").trim();
    onProgress(`X — @${handle} (${i + 1}/${channels.length})…`);
    let tabId = null;
    try {
      if (!handle) throw new Error("No X handle for this channel");
      const tab = await chrome.tabs.create({ url: "https://x.com/" + encodeURIComponent(handle), active: false });
      tabId = tab.id;
      await waitForLoad(tabId);

      /* route 1: the page's own server-rendered HTML, if it still carries the microdata */
      let posts = [], via = "microdata", xCovered = false;
      try {
        const html = await runInTab(tabId, () => document.documentElement.outerHTML, []);
        if (html) posts = xArticles(html).map(a => xParsePost(a, handle)).filter(Boolean);
      } catch (e) { /* fall through to the DOM scrape */ }

      /* route 2: the live, rendered timeline — X's own app, read the way a person reading the page
         would see it. Only the words/time/link/counts are reliable this way, not the richer stats
         and media the microdata carries when it is there.

         Tried quietly first, then AGAIN with the tab brought forward. Chrome does not lay out a tab
         it never shows, and X's timeline is virtualised — it renders further tweets only as they
         scroll into view — so in a background tab the scroll does nothing and the reader sees only
         whatever happened to render on load. That is how a channel with seven posts reported one,
         and then crossed the other six. The Facebook reader has always had to do this; X needs it
         for exactly the same reason. */
      let diag = "";
      if (!posts.length) {
        via = "dom";
        let res = await runInTab(tabId, xDomScrape, [handle, 7000, XP, sinceMs]);
        if (!res || !res.covered) {
          onProgress(`X — @${handle}: showing the tab so its timeline will scroll…`);
          await chrome.tabs.update(tabId, { active: true }).catch(() => {});
          const second = await runInTab(tabId, xDomScrape, [handle, XW, XP, sinceMs]);
          /* keep whichever pass saw more — bringing the tab forward should help, never lose ground */
          if (second && (second.posts || []).length >= ((res && res.posts) || []).length) res = second;
          if (res) res.neededFocus = true;
        }
        posts = (res && res.posts) || [];
        diag = (res && res.diag) || "";
        xCovered = !!(res && res.covered);
        /* a read that never got back past the window cannot support a cross, and says so */
        if (posts.length && !(res && res.covered))
          diag = `only ${posts.length} tweet(s) rendered before the timeline stopped giving more — ` +
                 `the window was not covered end to end`;
      }

      /* zero posts is indistinguishable from a dead handle, a login wall, or X declining this
         request — none of those is "posted nothing", so it is reported as unknown, never empty.
         diag names WHICH of those it actually was, from xDomScrape's own check of the page. */
      if (!posts.length) throw new Error("X rendered no posts for @" + handle + " — treat as unknown, not empty." +
        (diag ? " (" + diag + ")" : " (If your browser is not logged into x.com, log in and try again.)"));
      posts.sort((a, b) => new Date(b.ts) - new Date(a.ts));
      done({ channelId: c.id, platform: "x", username: handle, ok: true,
                 note: `${posts.length} post(s) via x.com (extension, ${via})` + (diag ? ` · ${diag}` : ""),
                 /* the microdata route hands over whatever the page shipped and cannot be scrolled,
                    so it is never a covered read either — only a DOM scrape that reached back past
                    the window may license crossing a drop */
                 partialRead: !xCovered,
                 posts, source: "extension-x" });
    } catch (e) {
      done({ channelId: c.id, platform: "x", username: handle, ok: false,
                 note: String((e && e.message) || e), posts: [], source: "extension-x" });
    } finally {
      if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
  /* put the user back where they were, whether or not a tab had to be brought forward */
  if (restoreTabId) await chrome.tabs.update(restoreTabId, { active: true }).catch(() => {});
  return out;
}

/* ═══════════════════ tiktok ═══════════════════
 *
 * Added as a stand-in fallback while Apify (the server-side reader, clockworks/tiktok-scraper) is
 * out of credit. TikTok server-renders a profile's recent videos into a JSON blob inside the page
 * itself — no API call, no signing, nothing to reverse-engineer — so opening a real tab at the
 * profile and reading that blob out of the DOM is enough, the same shape of trick api/collect.js
 * uses for X's microdata. Two script tags carry it depending on which build of the site answers:
 * the current one, __UNIVERSAL_DATA_FOR_REHYDRATION__, and the older SIGI_STATE some regions still
 * serve. Both are tried; whichever exists wins.
 */
function ttScrape(handle) {
  const wanted = String(handle || "").toLowerCase();
  const num = v => (v === undefined || v === null || v === "" ? null : Number(v));
  const tried = [];

  function itemsFromRehydration() {
    const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (!el) { tried.push("rehydration:absent"); return null; }
    let data;
    try { data = JSON.parse(el.textContent || "{}"); } catch (e) { tried.push("rehydration:unparsable"); return null; }
    const scope = data.__DEFAULT_SCOPE__ || {};
    const detail = scope["webapp.user-detail"] || {};
    const list = detail.itemList || (detail.userInfo && detail.userInfo.itemList) || null;
    tried.push("rehydration:" + (list ? list.length : "no-itemList"));
    return list;
  }

  function itemsFromSigi() {
    const el = document.getElementById("SIGI_STATE");
    if (!el) { tried.push("sigi:absent"); return null; }
    let data;
    try { data = JSON.parse(el.textContent || "{}"); } catch (e) { tried.push("sigi:unparsable"); return null; }
    const mod = data.ItemModule || {};
    const list = Object.values(mod);
    tried.push("sigi:" + list.length);
    return list;
  }

  const raw = itemsFromRehydration() || itemsFromSigi() || [];

  const posts = raw.map(it => {
    const author = ((it.author && (it.author.uniqueId || it.author)) || "").toString().toLowerCase();
    if (author && wanted && author !== wanted) return null;      // a recommended/related item riding along
    const id = it.id || (it.video && it.video.id) || "";
    const createTime = Number(it.createTime);
    if (!id || !isFinite(createTime) || !createTime) return null;
    const isPhoto = !!it.imagePost;
    const cover = it.video && (it.video.cover || it.video.dynamicCover || it.video.originCover) || "";
    const photoThumb = isPhoto && it.imagePost.images && it.imagePost.images[0]
      && it.imagePost.images[0].imageURL && (it.imagePost.images[0].imageURL.urlList || [])[0];
    const stats = it.stats || it.statsV2 || {};
    return {
      externalId: String(id),
      ts: new Date(createTime * 1000).toISOString(),
      kind: isPhoto ? "carousel" : "video",
      text: it.desc || "",
      views: num(stats.playCount),
      likes: num(stats.diggCount),
      comments: num(stats.commentCount),
      reposts: num(stats.shareCount),
      duration: it.video && it.video.duration != null ? Math.round(Number(it.video.duration)) : null,
      thumb: cover || photoThumb || "",
      permalink: `https://www.tiktok.com/@${handle}/video/${id}`,
    };
  }).filter(Boolean);

  /* ── the rendered grid, when the script tags are empty ──────────────────────
     Which they usually are. The blob above is only populated when TikTok server-renders the
     profile; in a real browser it commonly ships an empty itemList and fills the grid from its own
     XHR after load. A probe from two networks measured exactly that — HTTP 200, both script tags
     present, zero items in each — so a reader that stopped here would return nothing even once the
     network could reach TikTok at all.
     The grid itself is enough, because a TikTok video id IS its timestamp: the id is a snowflake
     whose top 32 bits are the unix second it was created. So a link is a post AND its instant, with
     no API, no signing and nothing to parse but the href. */
  if (!posts.length) {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/@([\w.\-]+)\/video\/(\d{6,25})/);
      if (!m) continue;
      if (wanted && m[1].toLowerCase() !== wanted) continue;   // a recommended clip from another account
      const id = m[2];
      if (seen.has(id)) continue;
      seen.add(id);
      let ts = "";
      try {
        const secs = Number(BigInt(id) >> 32n);
        if (isFinite(secs) && secs > 1e9 && secs < 4e9) ts = new Date(secs * 1000).toISOString();
      } catch (e) { /* not a snowflake — then it cannot be dated, and an undated post is no use */ }
      if (!ts) continue;
      /* the description rides on the cover image's alt text */
      const img = a.querySelector("img");
      posts.push({
        externalId: id, ts, kind: "video",
        text: (img && (img.getAttribute("alt") || "")) || "",
        views: null, likes: null, comments: null, reposts: null, duration: null,
        thumb: (img && img.getAttribute("src")) || "",
        permalink: "https://www.tiktok.com/@" + m[1] + "/video/" + id,
      });
    }
    tried.push("grid:" + posts.length);
    posts.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  }

  const bodyText = (document.body && document.body.innerText || "").slice(0, 4000);
  let diag = "";
  if (!posts.length) {
    if (/verify to continue|select 2 objects|are you a human/i.test(bodyText)) diag = "TikTok showed a bot-check wall instead of the profile";
    else if (/couldn.t find this account/i.test(bodyText)) diag = "TikTok says this account does not exist";
    else if (/log in to tiktok|sign up for tiktok/i.test(bodyText) && !/\/video\//.test(document.body.innerHTML || ""))
      diag = "TikTok is showing a login wall instead of the profile grid";
    else if (raw.length && !posts.length) diag = "posts were on the page but none matched @" + handle + " (" + tried.join(", ") + ")";
    else diag = "neither the embedded data nor the rendered grid had a video (" + tried.join(", ") + ")";
  }
  return { posts, tried, diag };
}

async function ttCollect(channels, onProgress, onResult) {
  const out = [];
  const done = r => { out.push(r); try { if (onResult) onResult(r); } catch (e) {} };
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const handle = String(c.username || c.handle || "").replace(/^@/, "").trim();
    onProgress(`TikTok — @${handle} (${i + 1}/${channels.length})…`);
    let tabId = null;
    try {
      if (!handle) throw new Error("No TikTok handle for this channel");
      const tab = await chrome.tabs.create({ url: "https://www.tiktok.com/@" + encodeURIComponent(handle), active: false });
      tabId = tab.id;
      await waitForLoad(tabId);
      /* "complete" only means the document finished loading — TikTok fills its grid from its own
         XHR afterwards, so the first read is routinely too early. Re-read a few times rather than
         reporting an empty profile that is merely still arriving. */
      let res = null, posts = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await runInTab(tabId, ttScrape, [handle]);
        posts = (res && res.posts) || [];
        if (posts.length) break;
        /* a bot wall or a dead handle will not improve by waiting */
        if (res && res.diag && /bot-check|does not exist|login wall/.test(res.diag)) break;
        await new Promise(r => setTimeout(r, 1500));
      }
      if (!posts.length) throw new Error("TikTok rendered no posts for @" + handle + " — treat as unknown, not empty." +
        (res && res.diag ? " (" + res.diag + ")" : ""));
      posts.sort((a, b) => new Date(b.ts) - new Date(a.ts));
      done({ channelId: c.id, platform: "tiktok", username: handle, ok: true,
                 note: `${posts.length} post(s) via tiktok.com (extension)`, posts, source: "extension-tiktok" });
    } catch (e) {
      done({ channelId: c.id, platform: "tiktok", username: handle, ok: false,
                 note: String((e && e.message) || e), posts: [], source: "extension-tiktok" });
    } finally {
      if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
  return out;
}

/**
 * Read every channel the server could not, and hand each one over THE MOMENT it is done.
 *
 * `onResult` is what makes a slow channel harmless. This used to return one payload at the end,
 * and the page gave the whole run a single 180-second deadline — so one slow or impossible channel
 * did not merely fail itself, it destroyed the entire run. That is exactly what happened when a
 * TikTok reader was added on a network that blocks tiktok.com: the tab could never load, it burned
 * the navigation timeout on every run, the deadline passed, and Facebook — which had already been
 * read successfully — was thrown away with it. A channel that worked yesterday went blank because
 * of an unrelated channel that never could.
 *
 * So results now leave here one at a time, as soon as each is known. Whatever has been collected
 * when the deadline arrives is already in the report, and the deadline stops being a data-loss
 * event. Order matters for the same reason: the cheap, reliable readers run FIRST, so the ones
 * most likely to succeed are banked before anything expensive is attempted.
 */
async function collect(channels, onProgress, onResult) {
  const results = [];
  /* bank it and hand it over immediately — never batch */
  const emit = r => {
    results.push(r);
    try { if (onResult) onResult(r); } catch (e) { /* the page not listening must not stop the run */ }
    return r;
  };
  const igChannels = channels.filter(c => c.platform === "instagram");
  const fbChannels = channels.filter(c => c.platform === "facebook");
  const xChannels  = channels.filter(c => c.platform === "x");
  const ttChannels = channels.filter(c => c.platform === "tiktok");

  /* ---- x, read from inside a shared x.com tab (same-origin, gets the full server HTML) ---- */
  if (xChannels.length) {
    /* emit is passed IN so each channel lands as it finishes; the returned array is only
       used to keep the final payload complete, and re-emitting is harmless (results are merged
       by channel id, and meta is simply overwritten with the same value) */
    await xCollect(xChannels, onProgress, emit);
  }

  /* ---- instagram: the API routes first, then the profile page for whatever they missed ----
     The API routes are cheaper (one tab serves every account) but they are background fetches, and
     Instagram increasingly answers those with nothing at all. So whatever they fail to read is
     retried the expensive way — a real navigation to the profile itself, one tab each — which is
     the request shape Instagram does answer. Only the failures are retried, so a working API read
     still costs exactly one tab for the whole set. */
  if (igChannels.length) {
    onProgress(`Instagram — ${igChannels.length} account(s)…`);
    const igResults = new Map();
    let tab = null;
    try {
      tab = await instagramTab();
      const names = igChannels.map(c => c.username);
      const map = await runInTab(tab.tabId, igScrape, [names]);
      for (const c of igChannels) {
        const r = (map && map[c.username]) || { ok: false, note: "No response for this account" };
        igResults.set(c.id, {
          channelId: c.id, platform: "instagram", username: c.username,
          ok: !!r.ok, dead: !!r.dead,
          /* keep which route answered in the note — when one of the two is failing, that is the
             single most useful fact for working out why */
          note: r.ok
            ? `${(r.posts || []).length} posts via ${r.route}` + (r.tried ? ` (${r.tried.join(", ")})` : "")
            : (r.note || "failed"),
          posts: r.posts || [], source: "extension-instagram", suggested: false,
        });
      }
      if (!tab.reuse) await chrome.tabs.remove(tab.tabId).catch(() => {});
    } catch (e) {
      const note = String((e && e.message) || e);
      for (const c of igChannels) {
        igResults.set(c.id, { channelId: c.id, platform: "instagram", username: c.username,
                              ok: false, note, posts: [], source: "extension-instagram" });
      }
      if (tab && !tab.reuse) await chrome.tabs.remove(tab.tabId).catch(() => {});
    }

    /* Anything the cheap route already settled goes out NOW rather than waiting behind the page
       route, which can take a minute per remaining account. Holding these back was the whole
       reason Instagram contributed nothing when a run overran. */
    const stillMissing = igChannels.filter(c => {
      const r = igResults.get(c.id);
      /* a dead handle is a real answer — retrying it on the page would only confirm it slowly */
      const settled = r && (r.ok || r.dead);
      if (settled) emit(r);
      return r && !r.ok && !r.dead;
    });

    if (stillMissing.length) {
      /* and each page-route account lands as it finishes, for the same reason */
      await igTabCollect(stillMissing, onProgress, r => {
        const apiNote = (igResults.get(r.channelId) || {}).note || "";
        /* carry why the cheap route failed into the note either way — when the page route saves the
           run that is worth knowing, and when both fail the report needs both reasons, not one */
        emit(Object.assign({}, r, {
          note: r.note + (apiNote ? ` · api route first said: ${apiNote}` : ""),
        }));
      });
    }
  }

  /* ---- facebook, one tab per Page ---- */

  /* whichever tab the user was on, to put back afterwards */
  let restoreTabId = null;
  if (fbChannels.length) {
    try {
      const [act] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (act) restoreTabId = act.id;
    } catch (e) {}
  }

  for (let i = 0; i < fbChannels.length; i++) {
    const c = fbChannels[i];
    onProgress(`Facebook — ${c.username || c.url} (${i + 1}/${fbChannels.length})…`);

    /* First: the page's own HTML, fetched with the user's cookies. No tab, no rendering, and when
       it works it yields real instants rather than "2h" — so these posts can be matched drop by
       drop like every other channel. */
    let fetched = null;
    try { fetched = await fbFetchPosts(c.username); } catch (e) { fetched = { ok: false, log: [{ error: String(e) }] }; }
    if (fetched && fetched.ok) {
      let captions = fetched.captions || [];
      let capNote = "";

      /* Timestamps without captions is the worst possible state for this channel: it is matched on
         content, so no captions means every drop reads as missing. The payload's text is not
         reliably findable, so fall back to the rendered page for the words — and only for the
         words, which is quick and needs no dates. */
      /* The payload only ever carries the newest post — measured: three creation_time markers in
         2.5 MB, one of them a real post time. Anything older needs the feed to actually load, so
         the page has to be opened and scrolled. Several entry points are tried in turn, because
         which one renders a full timeline varies, and captions from all of them are pooled. */
      const capLog = [];
      if (captions.length) capLog.push(`payload:${captions.length}`);
      if (captions.length < FB_WANT_CAPTIONS) {
        const bag = new Map();
        for (const t of captions) { const o = capObj(t); bag.set(capKey(o.text), o); }

        for (const make of FB_TAB_ROUTES) {
          if (bag.size >= FB_WANT_CAPTIONS) break;
          const url = make(c.username);
          onProgress(`Facebook — ${c.username}: reading ${new URL(url).pathname} …`);
          let tabId = null;
          try {
            const tab = await chrome.tabs.create({ url, active: false });
            tabId = tab.id;
            await waitForLoad(tabId);
            let cap = await runInTab(tabId, fbCaptionScrape, [7000, FB_POLL, FB_WANT_CAPTIONS]);
            /* a hidden tab is never laid out, so Facebook's feed never loads into it */
            if (!cap || cap.captions.length < 2) {
              await chrome.tabs.update(tabId, { active: true }).catch(() => {});
              cap = await runInTab(tabId, fbCaptionScrape, [FB_MAX_WAIT, FB_POLL, FB_WANT_CAPTIONS]);
            }
            for (const t of (cap && cap.captions) || []) {
              const o = capObj(t);
              const had = bag.get(capKey(o.text));
              /* keep the richer of the two: the payload knows the words, the page knows the
                 picture and the counts */
              if (!had) bag.set(capKey(o.text), o);
              else for (const k in o) if (o[k] && !had[k]) had[k] = o[k];
            }
            capLog.push(`${new URL(url).pathname}:${(cap && cap.captions.length) || 0}` +
                        (cap && cap.loginWall ? "(login)" : "") +
                        (cap ? `(dom${cap.domFound}/html${cap.htmlFound}/img${cap.withBanner})` +
                               `/${cap.rounds}r/${cap.articles}art` +
                               /* why DOM articles were passed over — the banner depends on them */
                               (cap.rejects && Object.values(cap.rejects).some(Boolean)
                                 ? `/rej:${Object.entries(cap.rejects).filter(([, v]) => v)
                                     .map(([k, v]) => k + v).join(",")}` : "")
                             : ""));
          } catch (e) {
            capLog.push(`${new URL(url).pathname}:err`);
          } finally {
            if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
          }
        }
        captions = [...bag.values()];
      }
      capNote = captions.length
        ? ` · ${captions.length} caption(s) [${capLog.join(" ")}]`
        : ` · no captions could be read [${capLog.join(" ") || "nothing tried"}] — ` +
          `content matching cannot judge this channel, so it reports unknown rather than missing`;

      emit({
        channelId: c.id, platform: "facebook", username: c.username,
        ok: true, suggested: false,
        posts: fetched.posts,
        captions,
        note: `${fetched.posts.length} post(s) from ${new URL(fetched.route).hostname}` + capNote,
        source: "extension-facebook-html",
        routeLog: fetched.log,
      });
      continue;
    }

    /* Otherwise fall back to reading the rendered page. */
    const fetchSummary = (fetched && fetched.log || [])
      .map(l => `${new URL(l.url || "https://x/").hostname}:${l.status || l.error || "?"}` +
                (l.rejected ? "(rejected)" : "") + (l.login ? "(login)" : "") +
                (l.stamps != null ? `/${l.stamps}st` : ""))
      .join(" ");
    onProgress(`Facebook — ${c.username}: HTML gave nothing (${fetchSummary}), opening the page…`);

    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url: c.url, active: false });
      tabId = tab.id;
      await waitForLoad(tabId);
      let r = await runInTab(tabId, fbScrape, [FB_QUIET_WAIT, FB_POLL]);

      /* Chrome does not lay out a tab it never shows, and Facebook's feed only loads posts as
         they intersect the viewport — so in a background tab the placeholders are all there ever
         is, however long the wait. Twenty-two seconds of polling proved that. Bringing the tab
         forward is the price of reading it; better a moment of stolen focus than reporting a
         channel nobody actually managed to look at. */
      if (r && r.stillLoading) {
        onProgress(`Facebook — ${c.username}: showing the tab so its feed will load…`);
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        r = await runInTab(tabId, fbScrape, [FB_MAX_WAIT, FB_POLL]);
        if (r) r.neededFocus = true;
      }
      const note = r && r.loginWall
        ? "You are not logged into Facebook in this browser — log in and run again"
        : !r ? "Nothing came back from the page"
        : r.stillLoading
          ? `The page was still loading after ${Math.round(FB_MAX_WAIT / 1000)}s ` +
            `(${r.skeletonCount} placeholder(s), no posts yet) — try again, or enter the count by hand`
        : r.visibleCount === 0 ? "No posts were visible on the page"
        : r.unknownCount > r.todayCount + r.olderCount
          ? `Could not read the date on ${r.unknownCount} of ${r.visibleCount} posts — enter the count by hand` +
            /* carry a sample of what the page did offer, so this is fixable from evidence */
            ((r.diag || []).length ? ` · saw: ${JSON.stringify(r.diag[0]).slice(0, 220)}` : "")
        /* A count taken while part of the feed is still blank is not a count. Two placeholders
           beside one readable post could each be today's, so "0 today" would be a guess dressed
           as a measurement — and the report would show it as posts missing. */
        : r.skeletonCount > 0
          ? `Only ${r.visibleCount} of ${r.visibleCount + r.skeletonCount} posts finished loading — ` +
            `too incomplete to count · HTML routes: ${fetchSummary || "none"}`
          : `${r.todayCount} today of ${r.visibleCount} visible` +
            (r.unknownCount ? `, ${r.unknownCount} undated` : "");
      emit({
        channelId: c.id, platform: "facebook", username: c.username,
        ok: !!(r && r.ok),
        note,
        todayCount: r ? r.todayCount : 0,
        visibleCount: r ? r.visibleCount : 0,
        unknownCount: r ? r.unknownCount : 0,
        /* the dashboard files nothing at all when this is set — a page that never rendered, or
           only rendered part of itself, has no count, and a zero from one would read as
           "no posts went out" */
        stillLoading: !!(r && (r.stillLoading || r.skeletonCount > 0)),
        neededFocus: !!(r && r.neededFocus),
        todayTexts: r ? r.todayTexts : [],
        /* the DOM path can still supply captions for content matching even when its dates fail */
        captions: r ? (r.todayTexts || []).concat(r.allTexts || []) : [],
        posts: [],
        /* read off the page, so a hint the dashboard shows as editable — never evidence */
        suggested: true,
        source: "extension-facebook",
      });
    } catch (e) {
      emit({ channelId: c.id, platform: "facebook", username: c.username,
                     ok: false, note: String((e && e.message) || e),
                     todayCount: 0, visibleCount: 0, unknownCount: 0,
                     /* an error is not a measurement either — file nothing */
                     stillLoading: true,
                     posts: [], suggested: true,
                     source: "extension-facebook" });
    } finally {
      if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
    }
  }

  /* put the user back where they were, whether or not a tab had to be brought forward */
  if (restoreTabId) await chrome.tabs.update(restoreTabId, { active: true }).catch(() => {});

  /* ---- tiktok LAST, and only if the network can actually reach it ----
     Deliberately the final thing attempted. On a network that blocks tiktok.com — which is where
     this runs — a tab for it can never load, so it is guaranteed to spend the navigation timeout
     and return nothing. Anything queued behind that pays for it, which is how a working Facebook
     read came to be lost. Last in the order, and gated on a short reachability check, it can now
     only ever cost itself. */
  if (ttChannels.length) {
    const reachable = await tiktokReachable();
    if (!reachable.ok) {
      for (const c of ttChannels)
        emit({ channelId: c.id, platform: "tiktok",
               username: String(c.username || c.handle || "").replace(/^@/, "").trim(),
               ok: false, posts: [], source: "extension-tiktok",
               note: "this browser's network cannot reach tiktok.com (" + reachable.why + ") — " +
                     "nothing here can read TikTok until that changes, so the drop stays unknown " +
                     "rather than being reported as missing" });
    } else {
      await ttCollect(ttChannels, onProgress, emit);
    }
  }

  return results;
}

/* Can this browser reach tiktok.com at all? A blocked network fails the connection outright, so a
   short HEAD is enough to find out — and finding out costs a few seconds instead of a full
   navigation timeout per channel. Never throws: anything other than a clear answer is treated as
   unreachable, because attempting the tab is the expensive branch. */
async function tiktokReachable() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    await fetch("https://www.tiktok.com/", { method: "HEAD", signal: ctl.signal, mode: "no-cors" });
    return { ok: true, why: "" };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e)));
    return { ok: false, why: aborted ? "no answer in 6s" : String((e && e.message) || e).slice(0, 80) };
  } finally { clearTimeout(timer); }
}

/* ═══════════════════ message API for the popup ═══════════════════ */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "collect") {
    /* Two different listeners, two different transports, and getting this wrong is invisible.
       chrome.runtime.sendMessage reaches the extension's OWN pages — the popup — and never a
       content script. bridge.js IS a content script, so anything sent that way to the dashboard
       goes nowhere, and the rejection ("Receiving end does not exist") is swallowed by the catch.
       That is how the per-channel streaming below came to be wired to a dead wire, and why the
       mid-run progress toasts had in fact never once arrived.
       The collect request comes FROM the bridge, so sender.tab.id is exactly the dashboard tab —
       address it directly. Both transports are used: the tab for the page, runtime for the popup,
       so whichever is driving the run gets its updates. */
    const tabId = sender && sender.tab && sender.tab.id;
    const toBoth = payload => {
      if (tabId != null) chrome.tabs.sendMessage(tabId, payload).catch(() => {});
      chrome.runtime.sendMessage(payload).catch(() => {});
    };
    const tick = text => toBoth({ type: "progress", text });
    /* Every channel is handed over the moment it is read, not held until the end. The page files
       each one immediately, so whatever has been collected survives even if the run is later cut
       short by its deadline — which is what stopped one impossible channel wiping out the rest. */
    const partial = result => toBoth({ type: "partial", result });
    collect(msg.channels || [], tick, partial)
      .then(results => {
        const payload = { collectedAt: new Date().toISOString(), results };
        chrome.storage.local.set({ lastRun: payload });
        reply({ ok: true, ...payload });
      })
      .catch(e => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;                      // keep the channel open for the async reply
  }

  if (msg && msg.type === "readLocalDirectory") {
    /* With no database configured the app keeps the directory in the browser instead, where
       GET /api/data cannot see it. Read it out of the dashboard tab so a purely local setup
       is still testable end to end. */
    chrome.tabs.query({ url: msg.dashboardPatterns })
      .then(async tabs => {
        if (!tabs.length) return reply({ ok: false, error: "Open the dashboard in a tab first." });
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => localStorage.getItem("orghub.v1"),
        });
        if (!r || !r.result) return reply({ ok: false, error: "That tab has no directory saved yet." });
        try { reply({ ok: true, data: JSON.parse(r.result) }); }
        catch (e) { reply({ ok: false, error: "The saved directory could not be parsed." }); }
      })
      .catch(e => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg && msg.type === "push") {
    /* Hand the run to the dashboard by writing it into that origin's localStorage — the page
       picks it up on its next render. Avoids needing an admin key or a write endpoint. */
    chrome.tabs.query({ url: msg.dashboardPatterns })
      .then(async tabs => {
        if (!tabs.length) return reply({ ok: false, error: "No Aiko tab is open — open the dashboard first." });
        await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: run => { localStorage.setItem("orghub.browserRun", JSON.stringify(run)); },
          args: [msg.run],
        });
        await chrome.tabs.update(tabs[0].id, { active: true });
        reply({ ok: true });
      })
      .catch(e => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});
