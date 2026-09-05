/**
 * GET /api/probe-free — which FREE (no key, no credit) route can actually read TikTok, Instagram
 * or X from this host?
 *
 * WHAT IT FOUND (measured from Vercel, 2026-09-05 — re-run it before trusting any of this):
 *   TikTok    the profile page loads and gives the account's stats and secUid, but the itemList is
 *             served EMPTY; the item_list XHR that fills it answers 200-with-no-body unless the
 *             request is signed (msToken / X-Bogus), and replaying TikTok's own cookies does not
 *             change that. tikwm and every public RSSHub mirror sit behind a Cloudflare challenge.
 *             No free server-side route. Apify remains the only server-side reader.
 *   Instagram 429 in ~25ms on every route — the datacenter IP is refused outright, not throttled
 *             by volume. Free mirrors are Cloudflare-walled. Must be read from a real browser.
 *   X         cdn.syndication (the public embed backend) answers 429 just as fast, and x.com
 *             itself serves the logged-out shell with zero microdata. Also browser-only.
 *
 * Diagnosis only. It answers a question that cannot be settled from a desk: the readers that
 * matter run on Vercel, and every one of these platforms answers a datacenter IP differently from
 * a home one — TikTok is blocked outright on some consumer ISPs while Vercel reaches it fine, and
 * Instagram does the reverse. So each candidate route is tried from HERE, and what it actually
 * returned is reported: status, size, which markers were present, how many posts could be parsed
 * and the newest timestamp among them.
 *
 * Read-only and keyless by design — every route listed is one that needs no token, so this never
 * spends credit and never exposes a secret. Nothing is stored; nothing is written.
 *
 *   /api/probe-free                          both platforms, the SportsFC handles
 *   /api/probe-free?platform=tiktok
 *   /api/probe-free?handle=sportsfc.vn&platform=instagram
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IG_APP_ID = "936619743392459";
const PER_ROUTE_TIMEOUT = 9000;

async function tryGet(url, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PER_ROUTE_TIMEOUT);
  const started = Date.now();
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: Object.assign({ "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, headers || {}),
    });
    const body = await r.text();
    /* the cookies the site handed out — a browser would send these back on the next request, and
       whether doing so changes the answer is one of the things being measured here */
    let setCookie = [];
    try { setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : []; } catch (e) {}
    return { status: r.status, body, ms: Date.now() - started, setCookie };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e)));
    return { status: 0, body: "", ms: Date.now() - started,
             error: aborted ? `timed out after ${PER_ROUTE_TIMEOUT}ms` : String((e && e.message) || e) };
  } finally { clearTimeout(timer); }
}

/* the newest post instant a route yielded, so "it answered" can be told from "it answered with
   something current" — a mirror serving a month-old cache is not a usable reader */
const newestOf = posts => posts.reduce((m, p) => {
  const t = new Date(p.ts).getTime();
  return isFinite(t) && t > m ? t : m;
}, 0);

function summarise(route, res, parsed) {
  const out = {
    route: route.name,
    url: route.url.replace(/([?&](?:token|key|api_key)=)[^&]*/gi, "$1***"),
    status: res.status,
    ms: res.ms,
    bytes: res.body ? res.body.length : 0,
  };
  if (res.error) out.error = res.error;
  if (parsed) {
    out.markers = parsed.markers;
    out.posts = parsed.posts.length;
    const newest = newestOf(parsed.posts);
    if (newest) out.newest = new Date(newest).toISOString();
    if (parsed.note) out.note = parsed.note;
    if (parsed.posts.length) out.sample = String(parsed.posts[0].text || "").slice(0, 80);
  }
  /* when nothing parsed, a slice of what DID come back is the only way to tell a bot wall from a
     login wall from an empty-but-honest answer */
  if ((!parsed || !parsed.posts.length) && res.body) {
    out.bodyHead = res.body.slice(0, 240).replace(/\s+/g, " ");
  }
  return out;
}

/* ═══════════════════ tiktok parsers ═══════════════════ */

/* the same two embedded blobs the extension reads, but from raw HTML rather than a live DOM */
function ttFromHtml(html, handle) {
  const markers = [];
  let items = null;

  const rehydration = html.match(
    /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (rehydration) {
    markers.push("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    try {
      const data = JSON.parse(rehydration[1]);
      const detail = (data.__DEFAULT_SCOPE__ || {})["webapp.user-detail"] || {};
      items = detail.itemList || (detail.userInfo && detail.userInfo.itemList) || null;
    } catch (e) { markers.push("rehydration:unparsable"); }
  }
  if (!items) {
    const sigi = html.match(/<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (sigi) {
      markers.push("SIGI_STATE");
      try { items = Object.values(JSON.parse(sigi[1]).ItemModule || {}); }
      catch (e) { markers.push("sigi:unparsable"); }
    }
  }
  if (/verify to continue|select 2 objects|captcha/i.test(html)) markers.push("BOT-WALL");
  if (/couldn.t find this account/i.test(html)) markers.push("NO-SUCH-ACCOUNT");

  const posts = (items || []).map(it => {
    const author = ((it.author && (it.author.uniqueId || it.author)) || "").toString().toLowerCase();
    if (author && handle && author !== handle.toLowerCase()) return null;
    const id = it.id || "";
    const t = Number(it.createTime);
    if (!id || !isFinite(t) || !t) return null;
    return { externalId: String(id), ts: new Date(t * 1000).toISOString(), text: it.desc || "" };
  }).filter(Boolean);

  return { markers, posts };
}

/* tikwm is a free public mirror of TikTok's own post list — no key, no account. Worth probing
   precisely because it is the sort of thing that either works outright or is gone tomorrow. */
function ttFromTikwm(body) {
  const markers = [];
  let json;
  try { json = JSON.parse(body); } catch (e) { return { markers: ["not-json"], posts: [] }; }
  if (json.code !== 0) markers.push("code:" + json.code + (json.msg ? " " + json.msg : ""));
  const list = (json.data && (json.data.videos || json.data.list)) || [];
  markers.push("videos:" + list.length);
  const posts = list.map(v => {
    const t = Number(v.create_time);
    if (!v.video_id && !v.aweme_id) return null;
    if (!isFinite(t) || !t) return null;
    return { externalId: String(v.video_id || v.aweme_id), ts: new Date(t * 1000).toISOString(), text: v.title || "" };
  }).filter(Boolean);
  return { markers, posts };
}

function fromRss(body) {
  const markers = [];
  const items = body.split(/<item[\s>]/).slice(1);
  markers.push("items:" + items.length);
  const posts = items.map(chunk => {
    const date = (chunk.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1];
    const title = (chunk.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
    const link = (chunk.match(/<link>([^<]+)<\/link>/) || [])[1] || "";
    const ms = date ? new Date(date).getTime() : NaN;
    if (!isFinite(ms)) return null;
    return { externalId: link, ts: new Date(ms).toISOString(), text: title.slice(0, 120) };
  }).filter(Boolean);
  return { markers, posts };
}

/* ═══════════════════ instagram parsers ═══════════════════ */

function igFromProfileJson(body) {
  const markers = [];
  let user;
  try { user = JSON.parse(body).data.user; } catch (e) { return { markers: ["not-profile-json"], posts: [] }; }
  if (!user) return { markers: ["no-user-in-json"], posts: [] };
  markers.push("web_profile_info");
  const edges = ((user.edge_owner_to_timeline_media || {}).edges) || [];
  const posts = edges.map(x => {
    const n = x.node || {};
    const cap = ((n.edge_media_to_caption || {}).edges || [])[0];
    if (!n.shortcode || !n.taken_at_timestamp) return null;
    return { externalId: n.shortcode, ts: new Date(n.taken_at_timestamp * 1000).toISOString(),
             text: (cap && cap.node && cap.node.text) || "" };
  }).filter(Boolean);
  return { markers, posts };
}

/* Instagram's logged-out profile HTML has, at various times, carried the post list inline. When it
   does, this finds it without an app id or a session; when it does not, the markers say so. */
function igFromHtml(html) {
  const markers = [];
  if (/"require":\[\[/.test(html)) markers.push("polaris-shell");
  if (/accounts\/login|loginForm/i.test(html)) markers.push("LOGIN-WALL");
  if (/challenge|suspicious/i.test(html)) markers.push("CHALLENGE");

  const posts = [];
  const rx = /"shortcode"\s*:\s*"([\w-]+)"[\s\S]{0,4000}?"taken_at_timestamp"\s*:\s*(\d{9,11})/g;
  let m, guard = 0;
  while ((m = rx.exec(html)) !== null && guard++ < 60) {
    posts.push({ externalId: m[1], ts: new Date(Number(m[2]) * 1000).toISOString(), text: "" });
  }
  if (posts.length) markers.push("inline-shortcodes");
  return { markers, posts };
}

/* ═══════════════════ the routes ═══════════════════ */

function tiktokRoutes(handle) {
  const h = encodeURIComponent(handle);
  return [
    { name: "tiktok profile page (embedded JSON)", url: `https://www.tiktok.com/@${h}`,
      parse: b => ttFromHtml(b, handle) },
    { name: "tiktok profile page ?lang=en", url: `https://www.tiktok.com/@${h}?lang=en`,
      parse: b => ttFromHtml(b, handle) },
    { name: "tikwm free mirror", url: `https://www.tikwm.com/api/user/posts?unique_id=%40${h}&count=20`,
      parse: ttFromTikwm },
    { name: "tiktok oembed (reachability only)", url: `https://www.tiktok.com/oembed?url=https://www.tiktok.com/@${h}`,
      parse: null },
    { name: "rsshub public instance", url: `https://rsshub.app/tiktok/user/@${h}`, parse: fromRss },
  ];
}

function instagramRoutes(handle) {
  const h = encodeURIComponent(handle);
  return [
    { name: "web_profile_info (app-id header)",
      url: `https://www.instagram.com/api/v1/users/web_profile_info/?username=${h}`,
      headers: { "X-IG-App-ID": IG_APP_ID, Accept: "application/json" },
      parse: igFromProfileJson },
    { name: "profile page HTML", url: `https://www.instagram.com/${h}/`, parse: igFromHtml },
    { name: "?__a=1&__d=dis", url: `https://www.instagram.com/${h}/?__a=1&__d=dis`, parse: igFromProfileJson },
    { name: "rsshub public instance", url: `https://rsshub.app/instagram/user/${h}`, parse: fromRss },
    { name: "imginn mirror", url: `https://imginn.com/${h}/`, parse: igFromHtml },
  ];
}

/* ═══════════════════ structure dump ═══════════════════ */

/* When a route answers 200 but yields no posts, the useful question stops being "did it work" and
   becomes "what IS in there". This reports the shape of what came back — which scope keys exist,
   whether the post-list markers appear anywhere in the raw text at all — so the reader can be
   pointed at the right path instead of guessed at. */
async function deepTiktok(handle) {
  const url = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
  const r = await tryGet(url);
  const html = r.body || "";
  const out = { url, status: r.status, bytes: html.length };

  const countOf = s => (html.split(s).length - 1);
  out.rawCounts = {
    createTime: countOf('"createTime"'),
    itemList: countOf('"itemList"'),
    aweme_id: countOf('"aweme_id"'),
    video_id: countOf('"video_id"'),
    uniqueId: countOf('"uniqueId"'),
    statusCode: countOf('"statusCode"'),
  };

  const m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) { out.rehydration = "absent"; return out; }
  out.rehydrationBytes = m[1].length;
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { out.rehydration = "unparsable: " + String(e.message || e); return out; }
  const scope = data.__DEFAULT_SCOPE__ || {};
  out.scopeKeys = Object.keys(scope);
  const detail = scope["webapp.user-detail"];
  if (detail) {
    out.userDetailKeys = Object.keys(detail);
    out.userDetailStatus = { statusCode: detail.statusCode, statusMsg: detail.statusMsg };
    const info = detail.userInfo || {};
    out.userInfoKeys = Object.keys(info);
    if (info.stats) out.stats = { videoCount: info.stats.videoCount, followerCount: info.stats.followerCount };
    if (info.user) out.user = { uniqueId: info.user.uniqueId, secUid: (info.user.secUid || "").slice(0, 24) + "…" };
  }
  /* the item list may be filed under a different scope key than the profile itself */
  for (const k of Object.keys(scope)) {
    const v = scope[k];
    if (v && typeof v === "object" && Array.isArray(v.itemList)) {
      out.itemListFoundUnder = k;
      out.itemListLength = v.itemList.length;
      break;
    }
  }
  return out;
}

/* The profile page hands over the account's secUid but an EMPTY itemList — TikTok loads the videos
   themselves through a separate XHR the page makes after render. That call is the last free route
   worth trying: it needs no key, only the secUid the page already gave us. It is also the one
   TikTok signs (msToken / X-Bogus) for its own client, so whether an unsigned call is answered is
   exactly the thing that has to be measured rather than assumed. */
async function deepTtList(handle) {
  const out = { handle, steps: [] };

  const page = await tryGet(`https://www.tiktok.com/@${encodeURIComponent(handle)}`);
  const secUid = (page.body.match(/"secUid"\s*:\s*"([\w-]+={0,2})"/) || [])[1] || "";
  out.steps.push({ step: "read secUid from profile page", status: page.status, found: !!secUid,
                   secUidLength: secUid.length });
  if (!secUid) return out;

  const common = {
    aid: "1988", app_language: "en", app_name: "tiktok_web", browser_language: "en-US",
    browser_name: "Mozilla", browser_online: "true", browser_platform: "Win32",
    browser_version: "5.0 (Windows NT 10.0; Win64; x64)", channel: "tiktok_web",
    cookie_enabled: "true", count: "35", cursor: "0", device_platform: "web_pc",
    focus_state: "true", from_page: "user", history_len: "3", is_fullscreen: "false",
    is_page_visible: "true", language: "en", os: "windows", region: "US",
    screen_height: "1080", screen_width: "1920", secUid, tz_name: "Asia/Ho_Chi_Minh",
    webcast_language: "en", coverFormat: "2", post_item_list_request_type: "0",
    device_id: "7300000000000000000",
  };
  const qs = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

  const variants = [
    { name: "item_list (full web params)", url: `https://www.tiktok.com/api/post/item_list/?${qs(common)}` },
    { name: "item_list (minimal params)",
      url: `https://www.tiktok.com/api/post/item_list/?aid=1988&count=35&cursor=0&secUid=${encodeURIComponent(secUid)}` },
  ];

  for (const v of variants) {
    const r = await tryGet(v.url, {
      Accept: "application/json, text/plain, */*",
      Referer: `https://www.tiktok.com/@${handle}`,
      "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
    });
    const rec = { step: v.name, status: r.status, bytes: (r.body || "").length, error: r.error };
    try {
      const j = JSON.parse(r.body || "{}");
      rec.statusCode = j.statusCode;
      rec.itemListLength = Array.isArray(j.itemList) ? j.itemList.length : null;
      rec.hasMore = j.hasMore;
      if (Array.isArray(j.itemList) && j.itemList.length) {
        const it = j.itemList[0];
        rec.newest = it.createTime ? new Date(Number(it.createTime) * 1000).toISOString() : null;
        rec.sample = String(it.desc || "").slice(0, 80);
      }
    } catch (e) { rec.head = (r.body || "").slice(0, 200).replace(/\s+/g, " "); }
    out.steps.push(rec);
  }

  /* A browser's SECOND request to a site carries the cookies the first one set. TikTok hands out
     ttwid (and msToken) on the first visit and treats a request without them as a stranger's — so
     the empty itemList may simply be what a cookieless caller gets. Replaying the cookies is what
     any HTTP client with a cookie jar does; it is not a signature or a bypass, and it is the last
     free route worth measuring before concluding there is not one. */
  {
    const jar = (page.setCookie || []).map(c => String(c).split(";")[0]).filter(Boolean).join("; ");
    out.steps.push({ step: "cookies offered by the first page load",
                     count: (page.setCookie || []).length,
                     names: (page.setCookie || []).map(c => String(c).split("=")[0]).slice(0, 8) });
    if (jar) {
      const again = await tryGet(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, { Cookie: jar });
      const parsed = ttFromHtml(again.body || "", handle);
      out.steps.push({ step: "profile page REPLAYED with those cookies", status: again.status,
                       bytes: (again.body || "").length, posts: parsed.posts.length,
                       createTimes: (again.body || "").split('"createTime"').length - 1,
                       newest: parsed.posts.length ? parsed.posts[0].ts : null,
                       sample: parsed.posts.length ? parsed.posts[0].text.slice(0, 60) : undefined });

      const listAgain = await tryGet(
        `https://www.tiktok.com/api/post/item_list/?${qs(common)}`,
        { Cookie: jar, Accept: "application/json, text/plain, */*",
          Referer: `https://www.tiktok.com/@${handle}`,
          "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" });
      const rec2 = { step: "item_list REPLAYED with those cookies", status: listAgain.status,
                     bytes: (listAgain.body || "").length };
      try {
        const j = JSON.parse(listAgain.body || "{}");
        rec2.statusCode = j.statusCode;
        rec2.itemListLength = Array.isArray(j.itemList) ? j.itemList.length : null;
        if (Array.isArray(j.itemList) && j.itemList.length) {
          rec2.newest = new Date(Number(j.itemList[0].createTime) * 1000).toISOString();
          rec2.sample = String(j.itemList[0].desc || "").slice(0, 60);
        }
      } catch (e) { rec2.head = (listAgain.body || "").slice(0, 160).replace(/\s+/g, " "); }
      out.steps.push(rec2);
    }
  }

  /* TikTok's OFFICIAL creator embed. Unlike item_list this one is meant to be read by anybody —
     it is the widget TikTok gives sites to show a creator's recent videos — so it should need no
     signature. If it carries create times it is the free reader this whole probe is looking for. */
  for (const embed of [
    `https://www.tiktok.com/embed/@${encodeURIComponent(handle)}`,
    `https://www.tiktok.com/embed/v2/@${encodeURIComponent(handle)}`,
  ]) {
    const r = await tryGet(embed, { Accept: "text/html,*/*" });
    const html = r.body || "";
    const rec = { step: "creator embed " + embed.replace(/^https:\/\/www\.tiktok\.com/, ""),
                  status: r.status, bytes: html.length, error: r.error };
    rec.counts = {
      createTime: html.split('"createTime"').length - 1,
      itemList: html.split('"itemList"').length - 1,
      videoId: html.split('"id":"7').length - 1,
    };
    const parsed = ttFromHtml(html, handle);
    rec.markers = parsed.markers;
    rec.posts = parsed.posts.length;
    if (parsed.posts.length) { rec.newest = parsed.posts[0].ts; rec.sample = parsed.posts[0].text.slice(0, 60); }
    /* the embed uses its own rehydration key, so also look for any create times at all */
    const times = [...html.matchAll(/"createTime"\s*:\s*"?(\d{10})"?/g)].map(m => Number(m[1]));
    if (times.length) {
      rec.createTimesFound = times.length;
      rec.newestSeen = new Date(Math.max(...times) * 1000).toISOString();
    }
    if (!rec.posts && !times.length) rec.head = html.slice(0, 200).replace(/\s+/g, " ");
    out.steps.push(rec);
  }

  /* other public RSSHub deployments — rsshub.app itself is behind a Cloudflare challenge from here,
     but the project is self-hostable and several open mirrors exist */
  for (const host of ["rsshub.rssforever.com", "rss.shab.fun"]) {
    const r = await tryGet(`https://${host}/tiktok/user/@${encodeURIComponent(handle)}`);
    const parsed = r.body ? fromRss(r.body) : { markers: [], posts: [] };
    out.steps.push({ step: "rsshub mirror " + host, status: r.status, bytes: (r.body || "").length,
                     posts: parsed.posts.length, newest: parsed.posts.length ? parsed.posts[0].ts : null,
                     head: parsed.posts.length ? undefined : (r.body || "").slice(0, 160).replace(/\s+/g, " ") });
  }

  return out;
}

/* X's EMBEDDED-TIMELINE backend. Every "embed this profile" widget on the open web is served by
   cdn.syndication.twimg.com, which means it is public by design, unsigned, and not the endpoint X
   blocks datacenter IPs from — the thing that stops api/collect.js reading x.com directly. If it
   answers here, X stops needing a paid key at all. */
async function deepX(handle) {
  const h = encodeURIComponent(String(handle).replace(/^@/, ""));
  const out = { handle, steps: [] };

  const routes = [
    { name: "cdn.syndication timeline-profile",
      url: `https://cdn.syndication.twimg.com/srv/timeline-profile/screen-name/${h}` },
    { name: "cdn.syndication timeline-profile (json suffix)",
      url: `https://cdn.syndication.twimg.com/srv/timeline-profile/screen-name/${h}?showReplies=false` },
    { name: "syndication.twitter.com timeline-profile",
      url: `https://syndication.twitter.com/srv/timeline-profile/screen-name/${h}` },
    { name: "x.com profile (microdata, for comparison)", url: `https://x.com/${h}` },
  ];

  for (const rt of routes) {
    const r = await tryGet(rt.url, { Accept: "text/html,application/json,*/*" });
    const body = r.body || "";
    const rec = { step: rt.name, status: r.status, bytes: body.length, ms: r.ms, error: r.error };

    /* the syndication routes answer with an HTML shell whose __NEXT_DATA__ carries the tweets */
    const nd = body.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nd) {
      rec.hasNextData = true;
      try {
        const data = JSON.parse(nd[1]);
        const entries = [];
        const walk = (v, d) => {
          if (!v || typeof v !== "object" || d > 14) return;
          if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
          /* a tweet: an id_str plus a created_at that parses */
          if (v.id_str && v.created_at && isFinite(new Date(v.created_at).getTime())) {
            entries.push({ id: v.id_str, ts: new Date(v.created_at).toISOString(),
                           text: String(v.full_text || v.text || "").slice(0, 70),
                           user: (v.user && v.user.screen_name) || "" });
          }
          for (const k in v) walk(v[k], d + 1);
        };
        walk(data, 0);
        const mine = entries.filter(e => !e.user || e.user.toLowerCase() === String(handle).toLowerCase());
        rec.tweetsFound = entries.length;
        rec.tweetsThisAccount = mine.length;
        if (mine.length) {
          mine.sort((x, y) => new Date(y.ts) - new Date(x.ts));
          rec.newest = mine[0].ts;
          rec.sample = mine[0].text;
        }
      } catch (e) { rec.nextDataError = String((e && e.message) || e); }
    }
    rec.microdataArticles = body.split('itemType="https://schema.org/SocialMediaPosting"').length - 1;
    if (!rec.tweetsThisAccount && !rec.microdataArticles) rec.head = body.slice(0, 200).replace(/\s+/g, " ");
    out.steps.push(rec);
  }
  return out;
}

/* Instagram answered 429 to a plain request. A real browser also sends Sec-Fetch-*, a Referer and
   an ASBD id; whether those change the answer is worth one probe, because if they do the reader is
   a header fix rather than an architecture change. */
async function deepInstagram(handle) {
  const browserish = {
    "X-IG-App-ID": IG_APP_ID,
    "X-ASBD-ID": "129477",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "*/*",
    Referer: `https://www.instagram.com/${handle}/`,
    Origin: "https://www.instagram.com",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Sec-Ch-Ua": '"Chromium";v="120", "Not:A-Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
  };
  const routes = [
    { name: "web_profile_info + full browser headers",
      url: `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
      headers: browserish },
    { name: "profile page + document headers",
      url: `https://www.instagram.com/${encodeURIComponent(handle)}/`,
      headers: { Accept: "text/html,application/xhtml+xml", "Sec-Fetch-Site": "none",
                 "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Sec-Fetch-User": "?1",
                 "Upgrade-Insecure-Requests": "1" } },
  ];
  const done = [];
  for (const rt of routes) {
    const r = await tryGet(rt.url, rt.headers);
    done.push({ route: rt.name, status: r.status, bytes: (r.body || "").length,
                head: (r.body || "").slice(0, 200).replace(/\s+/g, " "), error: r.error });
  }
  return done;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET." });

  const q = req.query || {};

  /* ?deep=tiktok / ?deep=instagram — structure, not verdicts */
  if (q.deep) {
    const h = String(q.handle || (q.deep === "instagram" ? "sportsfc.vn" : "sportsfc.fans"));
    const which = String(q.deep);
    const body = which === "instagram" ? await deepInstagram(h)
               : which === "ttlist" ? await deepTtList(h)
               : which === "x" ? await deepX(String(q.handle || "Sportsfcvn"))
               : await deepTiktok(h);
    return res.status(200).json({ ok: true, deep: q.deep, handle: h, ranAt: new Date().toISOString(), body });
  }
  const platform = String(q.platform || "both").toLowerCase();
  const ttHandle = String(q.handle || (platform === "instagram" ? "sportsfc.vn" : "sportsfc.fans"));
  const igHandle = String(q.handle || "sportsfc.vn");

  const jobs = [];
  if (platform === "tiktok" || platform === "both") {
    for (const r of tiktokRoutes(ttHandle)) jobs.push({ platform: "tiktok", route: r });
  }
  if (platform === "instagram" || platform === "both") {
    for (const r of instagramRoutes(igHandle)) jobs.push({ platform: "instagram", route: r });
  }

  const done = await Promise.all(jobs.map(async j => {
    const resp = await tryGet(j.route.url, j.route.headers);
    let parsed = null;
    if (j.route.parse && resp.body) {
      try { parsed = j.route.parse(resp.body); }
      catch (e) { parsed = { markers: ["parser threw: " + String((e && e.message) || e)], posts: [] }; }
    }
    return Object.assign({ platform: j.platform }, summarise(j.route, resp, parsed));
  }));

  const winners = done.filter(d => d.posts > 0).map(d => `${d.platform}: ${d.route} (${d.posts} posts)`);

  return res.status(200).json({
    ok: true,
    ranAt: new Date().toISOString(),
    handles: { tiktok: ttHandle, instagram: igHandle },
    /* the whole point of the probe, up front: which free route actually produced posts */
    usable: winners.length ? winners : "none of the free routes returned posts from this host",
    results: done,
  });
};
