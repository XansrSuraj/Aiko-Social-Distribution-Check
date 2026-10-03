/**
 * GET /api/health  — which server-side readers have what they need, so a missing credential is
 * noticed before the next daily check rather than during it. Public and read-only: it reports
 * presence only, never a value, so it is safe to poll without auth.
 *
 * GET /api/health?probe=1 (also /api/probe-free) — the free-route probe, which shares this function
 * to stay inside the Hobby plan's function limit; see probe-free.js.
 */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET." });

  /* the free-route probe (probe-free.js) shares this function — see its header for why */
  if (req.query && req.query.probe) return require("../probe-free.js")(req, res);

  return res.status(200).json({
    ok: true,
    now: new Date().toISOString(),
    /* YouTube is the one worth watching. Its keyless path works from a desk and is refused from a
       datacenter — Google gates the IP — so on this host a missing key does not degrade the read,
       it ends it. */
    readers: {
      youtube: process.env.YOUTUBE_API_KEY ? "key set" : "NO KEY — unreadable from this host",
      free: process.env.FREE_READERS === "off" ? "switched off" : "on — Facebook, Instagram, TikTok read free first",
      x: process.env.APIFY_TOKEN ? "via Apify" : process.env.TWITTERAPI_KEY ? "twitterapi.io key set" : "free page read only",
      apify: process.env.APIFY_TOKEN ? "token set — the fallback for every social reader" : "no token",
      telegramBot: process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION
        ? "session set" : "no session",
    },
  });
};
