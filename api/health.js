/**
 * GET /api/health  — is the phone's forwarder still alive, and is each watched Viber community
 * actually receiving posts?  Public and read-only: it exposes only timing/status (no post content,
 * no keys), so the dashboard can poll it without auth and show a live "connected / went silent"
 * monitor.
 *
 *   lastSeen   — the last time ANY authenticated hit reached /api/notif (a post OR a heartbeat
 *                ping). The forwarder touches this on every notification and on a periodic ping, so
 *                a killed listener stops refreshing it and the age climbs — which is exactly the
 *                signal the monitor turns red on.
 *   channels   — per watched community: its most recent stored post and how many are held. This is
 *                what says the end-to-end pipeline is not just "phone alive" but "posts landing".
 *
 * Never throws: an unreachable store returns lastSeen:null rather than a 500, so the monitor
 * degrades to "unknown" instead of taking the dashboard down with it.
 */
const store = require("../ingest-store.js");

/* the watched communities, in the same shape api/notif.js routes by — display name (original case)
   on the left, channel id on the right. Kept in sync via the same env var. */
const COMMUNITIES = (process.env.VIBER_COMMUNITIES ||
  "Sportsfc.vn=viber:sportsfc.vn,Sportsfc.fans=viber:sportsfc.fans")
  .split(",").map(s => s.trim()).filter(Boolean)
  .map(pair => {
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i).trim(), channelId: pair.slice(i + 1).trim() };
  }).filter(c => c.name && c.channelId);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET." });

  const now = new Date();
  let lastSeen = null;
  let beats = [];
  const channels = [];

  try {
    lastSeen = await store.lastSeen();
    try { beats = await store.beats(); } catch (e) { beats = []; }
    for (const c of COMMUNITIES) {
      let posts = [];
      try { posts = await store.getPosts(c.channelId); } catch (e) { posts = []; }
      const latest = posts.reduce((m, p) => {
        const t = new Date(p.ts).getTime();
        return isFinite(t) && t > m ? t : m;
      }, 0);
      channels.push({
        name: c.name,
        channelId: c.channelId,
        lastPost: latest ? new Date(latest).toISOString() : null,
        count: posts.length,
      });
    }
  } catch (e) {
    /* store unreachable — report what we can rather than 500 */
  }

  const seenMs = lastSeen ? new Date(lastSeen).getTime() : null;
  const ageSeconds = seenMs && isFinite(seenMs) ? Math.max(0, Math.round((now.getTime() - seenMs) / 1000)) : null;

  return res.status(200).json({
    ok: true,
    now: now.toISOString(),
    lastSeen,
    ageSeconds,
    configured: store.configured(),
    channels,
    /* the heartbeat log — the dashboard uses it to tell a real Viber miss (phone was online then)
       from an unverifiable one (phone was offline then) */
    beats,
    /* Which server-side readers currently have what they need. Presence only, never the value, so
       this stays safe to poll without auth.

       YouTube is the one worth watching. Its keyless path works from a desk and is refused from a
       datacenter — Google gates the IP — so on this host a missing key does not degrade the read,
       it ends it. That failure is loud in the report either way, but seeing it here means noticing
       before the next daily check rather than during it. */
    readers: {
      youtube: process.env.YOUTUBE_API_KEY ? "key set" : "NO KEY — unreadable from this host",
      x: process.env.TWITTERAPI_KEY ? "key set" : "no key",
      apify: process.env.APIFY_TOKEN ? "token set" : "no token",
      telegramBot: process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION
        ? "session set" : "no session",
    },
  });
};
