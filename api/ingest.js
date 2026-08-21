/**
 * POST /api/ingest   { channelId, posts:[ { externalId, ts, text, … } ] }
 *   -> { ok, added, total }
 *
 * GET  /api/ingest?channelId=…   -> { ok, channelId, posts:[…] }   (read back what was pushed)
 *
 * The way in for channels nothing can read. Viber is the reason it exists — no public post list,
 * no web client for the extension, an encrypted local store — so instead of reading the platform,
 * this takes what the system that publishes to it already knows.
 *
 * The one required field per post is a timestamp; supply an externalId too and re-sending the same
 * day's list is harmless, which is what makes a cron safe to point at this.
 *
 *   curl -X POST http://localhost:3000/api/ingest \
 *     -H "Content-Type: application/json" -H "x-ingest-key: $INGEST_KEY" \
 *     -d '{"channelId":"vb-vn","posts":[
 *           {"externalId":"2026-08-16-arsenal","ts":"2026-08-16T07:48:00Z",
 *            "text":"Arsenal đối đầu Manchester City …","permalink":"https://sfc.my/r/d8wUU87R"}]}'
 *
 * Auth: the INGEST_KEY environment variable, compared in constant time. If it is not set the
 * endpoint answers only to localhost — enough for a machine talking to itself, and closed by
 * default anywhere else, so a deployment can never be written to by a stranger who guessed a
 * channel id.
 */
const crypto = require("crypto");
const store = require("../ingest-store.js");

const KEY = process.env.INGEST_KEY || "";
const MAX_POSTS = 500;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

/* Only ever true for a socket that really is loopback — a header cannot forge this, which matters
   because the no-key path depends on it. */
function fromLocalhost(req) {
  const s = req.socket || req.connection || {};
  const ip = String(s.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function authorised(req) {
  if (KEY) return safeEqual(req.headers["x-ingest-key"] || "", KEY);
  return fromLocalhost(req);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-ingest-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (!authorised(req)) {
    return res.status(401).json({ ok: false, error: KEY
      ? "Wrong or missing x-ingest-key."
      : "INGEST_KEY is not set on this deployment, so /api/ingest only answers to localhost." });
  }

  try {
    if (req.method === "GET") {
      const channelId = String((req.query && req.query.channelId) || "").trim();
      if (!channelId) return res.status(400).json({ ok: false, error: "Pass ?channelId=…" });
      const posts = await store.getPosts(channelId);
      return res.status(200).json({ ok: true, channelId, posts, keptForDays: store.MAX_DAYS });
    }

    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

    let body = req.body;
    if (typeof body === "string") {
      const raw = body;
      try { body = JSON.parse(raw); }
      catch (e) {
        /* a phone automation rule is often only able to send a form post, so accept that too */
        body = null;
        try {
          const p = new URLSearchParams(raw);
          if (p.get("channelId")) body = Object.fromEntries(p.entries());
        } catch (e2) { /* not form-encoded either */ }
      }
    }

    const channelId = String((body && (body.channelId || body.channel)) || "").trim();
    /* The full shape is { channelId, posts:[…] }. A single post may also be sent flat —
       { channelId, ts, text } — because that is all a notification-forwarding rule on a phone can
       usually build, and requiring it to construct a nested array is how a working setup fails at
       the last step. Both arrive at the same place. */
    let posts = body && Array.isArray(body.posts) ? body.posts : null;
    if (!posts && body && (body.ts || body.text || body.date)) {
      posts = [{ externalId: body.externalId || body.id,
                 ts: body.ts || body.date, text: body.text || body.message || "",
                 permalink: body.permalink || body.url, kind: body.kind }];
    }
    if (!channelId || !posts) {
      return res.status(400).json({ ok: false,
        error: 'Send { "channelId": "…", "posts": [ { "ts": "ISO-8601", "text": "…" } ] } ' +
               '— or a single post flat: { "channelId": "…", "ts": "…", "text": "…" }.' });
    }
    if (posts.length > MAX_POSTS) {
      return res.status(413).json({ ok: false, error: `At most ${MAX_POSTS} posts per request.` });
    }

    const out = await store.addPosts(channelId, posts);
    return res.status(200).json({ ok: true, channelId, ...out, storage: store.configured() ? "cloud" : "local file" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
