/**
 * GET /api/probe-free — which FREE (no key, no credit) route can actually read TikTok and
 * Instagram from this host?
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
    return { status: r.status, body, ms: Date.now() - started };
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET." });

  const q = req.query || {};
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
