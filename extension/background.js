/**
 * Aiko Daily Check — service worker
 *
 * Collects the two platforms the server cannot reach, using the sessions this browser already
 * holds. Nothing is stored, no cookie is read, no password is involved: every request is made
 * by the browser itself, from the user's own IP, with the user's own session attached the same
 * way it is when they click a link.
 *
 *   instagram — one tab on instagram.com serves every account. A script running in it calls the
 *               same endpoints the site calls for itself; being same-origin and logged in, it
 *               answers reliably where the server-side attempt is rate-limited. Two are tried:
 *               the mobile feed first, since web_profile_info returns an Instagram-side schema
 *               error for some accounts that no amount of retrying or logging in will clear.
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

async function xFetchProfile(handle) {
  const url = "https://x.com/" + encodeURIComponent(handle);
  const r = await fetch(url, { credentials: "omit", cache: "no-store", headers: { Accept: "text/html" } });
  if (r.status !== 200) throw new Error("X would not serve @" + handle + " (HTTP " + r.status + ").");
  return r.text();
}

async function xCollect(channels, onProgress) {
  const out = [];
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const handle = String(c.username || c.handle || "").replace(/^@/, "").trim();
    onProgress(`X — @${handle} (${i + 1}/${channels.length})…`);
    try {
      if (!handle) throw new Error("No X handle for this channel");
      const html = await xFetchProfile(handle);
      const posts = xArticles(html).map(a => xParsePost(a, handle)).filter(Boolean);
      /* zero posts is indistinguishable from a dead handle or X declining this particular request —
         none of those is "posted nothing", so report it as unknown, exactly as the server does */
      if (!posts.length) throw new Error("X rendered no posts for @" + handle + " — treat as unknown, not empty.");
      posts.sort((a, b) => new Date(b.ts) - new Date(a.ts));
      out.push({ channelId: c.id, platform: "x", username: handle, ok: true,
                 note: `${posts.length} post(s) via x.com (extension)`, posts, source: "extension-x" });
    } catch (e) {
      out.push({ channelId: c.id, platform: "x", username: handle, ok: false,
                 note: String((e && e.message) || e), posts: [], source: "extension-x" });
    }
  }
  return out;
}

async function collect(channels, onProgress) {
  const results = [];
  const igChannels = channels.filter(c => c.platform === "instagram");
  const fbChannels = channels.filter(c => c.platform === "facebook");
  const xChannels  = channels.filter(c => c.platform === "x");

  /* ---- x, straight fetches from the user's IP (no tab, quick) ---- */
  if (xChannels.length) {
    for (const r of await xCollect(xChannels, onProgress)) results.push(r);
  }

  /* ---- instagram, all accounts through one tab ---- */
  if (igChannels.length) {
    onProgress(`Instagram — ${igChannels.length} account(s)…`);
    let tab = null;
    try {
      tab = await instagramTab();
      const names = igChannels.map(c => c.username);
      const map = await runInTab(tab.tabId, igScrape, [names]);
      for (const c of igChannels) {
        const r = (map && map[c.username]) || { ok: false, note: "No response for this account" };
        results.push({
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
        results.push({ channelId: c.id, platform: "instagram", username: c.username,
                       ok: false, note, posts: [], source: "extension-instagram" });
      }
      if (tab && !tab.reuse) await chrome.tabs.remove(tab.tabId).catch(() => {});
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

      results.push({
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
      results.push({
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
      results.push({ channelId: c.id, platform: "facebook", username: c.username,
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

  return results;
}

/* ═══════════════════ message API for the popup ═══════════════════ */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "collect") {
    const tick = text => chrome.runtime.sendMessage({ type: "progress", text }).catch(() => {});
    collect(msg.channels || [], tick)
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
