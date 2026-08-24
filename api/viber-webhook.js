/**
 * POST /api/viber-webhook?s=<secret>[&community=viber:<handle>]
 *
 * The reliable, phone-free way in: a Viber bot connected to a community makes Viber push every post
 * here in real time (retried on their side), so nothing depends on a phone staying awake. It feeds
 * the SAME store as the phone forwarder (api/notif) through the shared core in ../viber-ingest.js,
 * so a post is de-duped across both doors and shows in the same report and live log.
 *
 * Setup on the Viber side (the bot's owner does this, keeping the token — see the README):
 *   1. create a bot at partners.viber.com   2. add it to the community   3. point its webhook here.
 *
 * Because one bot's webhook cannot say which community a post came from, the RELIABLE routing is one
 * bot per community, each pointing at this URL with its own ?community= — e.g.
 *   .../api/viber-webhook?s=SECRET&community=viber:sportsfc.vn
 *   .../api/viber-webhook?s=SECRET&community=viber:sportsfc.fans
 * With no ?community=, it falls back to matching the community name out of the sender/text.
 *
 * Auth is the ?s= secret in the URL — VIBER_WEBHOOK_SECRET if set, else the existing INGEST_KEY. It
 * always answers 200 (Viber disables a webhook that returns errors), and it captures every event
 * raw in the live log so the exact payload can be confirmed once real posts start flowing.
 */
const crypto = require("crypto");
const viber = require("../viber-ingest.js");
const store = require("../ingest-store.js");

const SECRET = process.env.VIBER_WEBHOOK_SECRET || process.env.INGEST_KEY || "";

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

/* Viber posts a media-only message with no text; still a real post, so give it a caption derived
   from its type so it is counted (and de-duped) rather than dropped as an empty bundle. */
function textOf(m) {
  const t = String((m && m.text) || "").trim();
  if (t) return t;
  const kind = String((m && m.type) || "").trim();
  return kind && kind !== "text" ? "[" + kind + " post]" : "";
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  /* a plain GET is handy for eyeballing the URL in a browser; it does nothing */
  if (req.method === "GET") return res.status(200).json({ ok: true, endpoint: "viber-webhook", ready: !!SECRET });
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

  const q = req.query || {};
  if (SECRET) {
    if (!safeEqual(q.s || q.secret || req.headers["x-ingest-key"] || "", SECRET)) {
      /* 200, not 401 — never give a scanner a signal, and never let Viber mark the hook failing */
      return res.status(200).json({ ok: false, ignored: "bad or missing secret" });
    }
  }

  let body = {};
  if (req.body && typeof req.body === "object") body = req.body;
  else if (typeof req.body === "string" && req.body) { try { body = JSON.parse(req.body); } catch (e) { body = {}; } }

  const event = String(body.event || "").toLowerCase();

  /* Viber's set-webhook handshake — it POSTs {event:"webhook"} once and expects a clean 200. */
  if (event === "webhook") return res.status(200).json({ status: 0, status_message: "ok" });

  /* Only a real posted message becomes a post. Everything else (delivered/seen/subscribed/…) is
     acknowledged and ignored — but still logged raw the first times, so the shape can be verified. */
  if (event !== "message") {
    try {
      await store.logNotif({ at: new Date().toISOString(), title: "(viber event: " + (event || "?") + ")",
        text: "", postedAt: "", ts: new Date().toISOString(), community: "", outcome: "ignored — not a post", source: "viber-bot" });
    } catch (e) {}
    return res.status(200).json({ ok: true, ignored: "event " + (event || "unknown") });
  }

  const sender = body.sender || {};
  const title = String(q.community || sender.name || sender.id || "").trim();
  const text = textOf(body.message);
  const rawPostedAt = String(body.timestamp || (body.message && body.message.timestamp) || "");
  const explicitChannelId = /^viber:/i.test(String(q.community || "")) ? String(q.community) : "";

  const { response } = await viber.record({
    title: explicitChannelId ? "" : title, text, rawPostedAt, explicitChannelId, source: "viber-bot",
  });
  /* always 200 to Viber, whatever the store decided — the outcome is in the reply + the live log */
  return res.status(200).json(response);
};
