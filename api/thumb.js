/**
 * GET /api/thumb?u=<image url>  — a post's thumbnail, passed through this server.
 *
 * Why it exists: Instagram's image CDN answers with `Cross-Origin-Resource-Policy: same-origin`
 * (measured on the thumbnails Apify hands back, 2026-10-02), so a browser refuses to draw them on
 * any other site — the dashboard's post cards came out blank. Fetched here and served from this
 * origin, the same image draws normally.
 *
 * Not an open proxy: only https images from the social platforms' own CDNs are fetched, the final
 * address after any redirect is checked against the same list, only image responses are passed on,
 * and anything over 4 MB is refused. Read-only, no credentials, nothing stored. Cached at the edge
 * for a day, so a report opened twice does not fetch every thumbnail twice. (A signed CDN link still
 * expires on the platform's schedule — usually a few days — after which there is nothing to fetch.)
 */

const HOSTS = [
  "cdninstagram.com", "fbcdn.net",                         // Instagram, Facebook
  "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", // TikTok
  "twimg.com",                                             // X
  "ytimg.com", "ggpht.com",                                // YouTube
  "telesco.pe", "cdn-telegram.org",                        // Telegram
];
const MAX_BYTES = 4 * 1024 * 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function allowed(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  return HOSTS.some(d => h === d || h.endsWith("." + d));
}

module.exports = async (req, res) => {
  if (req.method !== "GET") { res.statusCode = 405; return res.end("Use GET."); }
  const raw = String((req.query && req.query.u) || new URL(req.url || "/", "http://x").searchParams.get("u") || "");
  if (!allowed(raw)) { res.statusCode = 400; return res.end("Not an image address this proxy serves."); }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(raw, { signal: ctl.signal, redirect: "follow",
                                 headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" } });
    const type = String(r.headers.get("content-type") || "");
    if (!allowed(r.url || raw) || r.status !== 200 || !/^image\//i.test(type)) {
      res.statusCode = r.status === 200 ? 415 : (r.status === 403 || r.status === 404 || r.status === 410 ? 404 : 502);
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.end("Image not available.");
    }
    if (Number(r.headers.get("content-length")) > MAX_BYTES) { res.statusCode = 413; return res.end("Too large."); }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) { res.statusCode = 413; return res.end("Too large."); }
    res.statusCode = 200;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.end(buf);
  } catch (e) {
    res.statusCode = 504;
    return res.end("Image fetch failed.");
  } finally { clearTimeout(timer); }
};
