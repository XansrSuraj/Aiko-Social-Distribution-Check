/**
 * POST /api/notif   — a phone forwards one Viber notification here, verbatim.
 *
 * The other door into the store, api/ingest.js, wants a channelId already worked out. A phone
 * cannot work one out: a notification-forwarding app knows the app it came from and the words on
 * screen, nothing about our directory. So this door takes the raw notification and does the
 * matching itself — which community it belongs to, from the title — and files it under that
 * channel. One forwarding rule on the phone then covers every Viber community at once; the routing
 * lives here in code, not in fiddly per-community phone setup.
 *
 * Shape (matches the NotificationForwarder payload template — {appName}/{title}/{text}/{postedAt}):
 *
 *   { "app":"Viber", "title":"Sportsfc.vn", "text":"Arsenal vs Man City …", "postedAt":"…" }
 *
 * Auth is the same INGEST_KEY as /api/ingest, sent as x-ingest-key. Without a key set the endpoint
 * answers only to localhost, closed by default anywhere deployed.
 *
 * Which communities to watch, and the channel each maps to, is the VIBER_COMMUNITIES env var —
 * "name=channelId" pairs, comma-separated. It defaults to the two SportsFC communities, keyed by
 * the same "viber:<handle>" alias api/collect.js already resolves a Viber channel to, so nothing
 * in the directory has to change.
 */
const crypto = require("crypto");
const store = require("../ingest-store.js");

const KEY = process.env.INGEST_KEY || "";

/* name shown in the notification -> the channel id it belongs to. Match is case-insensitive and
   substring, because Viber titles a community post variously ("Sportsfc.vn", "Sportsfc.vn: Admin",
   or the name with a trailing count) and all of those are the same community. */
const COMMUNITIES = (process.env.VIBER_COMMUNITIES ||
  "Sportsfc.vn=viber:sportsfc.vn,Sportsfc.fans=viber:sportsfc.fans")
  .split(",").map(s => s.trim()).filter(Boolean)
  .map(pair => {
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i).trim().toLowerCase(), channelId: pair.slice(i + 1).trim() };
  }).filter(c => c.name && c.channelId);

/* Viber's own app, by the name a forwarder reports or its package id. Anything else is ignored —
   this endpoint is for Viber community posts, not the phone's whole notification shade. */
const IS_VIBER = s => /viber/i.test(String(s || ""));

/* A bundle notification ("3 new messages", "Bạn có tin nhắn mới") carries no post — it is Viber
   collapsing several. Filing it as one post would both undercount and store junk, so it is skipped
   and the reply says so. The busy-day gap is what the dashboard's manual ✓ is there to close. */
const BUNDLE = /^\s*(\d+\s+new\s+messages?|new\s+message|you\s+have|tin nhắn mới|\d+\s+tin nhắn)/i;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}
function fromLocalhost(req) {
  const ip = String((req.socket || req.connection || {}).remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
/* Auth is checked inside the handler, after parsing, so the key can arrive in the header, a ?key=
   query param, or the JSON body (see there). fromLocalhost + safeEqual are the primitives it uses. */

/* {postedAt} may arrive as epoch millis, epoch seconds, or an ISO string — accept all, and fall
   back to now only when it is genuinely absent (a notification with no time is still a real post). */
function toIso(v) {
  if (v === undefined || v === null || v === "") return new Date().toISOString();
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString();
  if (/^\d{10}$/.test(String(v))) return new Date(Number(v) * 1000).toISOString();
  const t = new Date(v).getTime();
  return isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-ingest-key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

  /* Parse defensively, and NEVER fail. A phone forwarder queues sends and retries whatever gets a
     non-2xx — so a single un-parseable body (real Viber posts carry quotes, newlines, emoji and
     links, which a naive JSON template turns into invalid JSON) would fail, retry forever, and jam
     the queue behind it: nothing new gets through until the queue is cleared by hand. That was the
     "clear the queue every time" symptom. The cure is that this endpoint always answers 200, and
     pulls the fields out of whatever shape arrives — clean JSON, form-encoded, query params, or
     even broken JSON via a last-ditch regex. */
  const raw = typeof req.body === "string" ? req.body : "";
  let body = {};
  if (req.body && typeof req.body === "object") body = req.body;
  else if (raw) {
    try { body = JSON.parse(raw); }
    catch (e) {
      try {
        const p = Object.fromEntries(new URLSearchParams(raw).entries());
        if (Object.keys(p).length) body = p; else throw new Error("not form");
      } catch (e2) {
        const grab = k => (raw.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')) || [])[1];
        body = { app: grab("app"), title: grab("title") || grab("from") || grab("message_from"),
                 text: grab("text") || grab("body") || grab("message_body"),
                 postedAt: grab("postedAt") || grab("when"), key: grab("key") };
      }
    }
  }
  const q = req.query || {};
  const pick = (...keys) => { for (const k of keys) { if (q[k]) return q[k]; if (body[k]) return body[k]; } return ""; };

  /* Auth AFTER parsing, so the key can ride in the header, a ?key= query param, OR the JSON body.
     The body path is what lets a forwarder that cannot set custom headers (e.g. Message Mirror)
     still authenticate — it just embeds the key as a literal field in its payload template. */
  if (KEY) {
    const supplied = req.headers["x-ingest-key"] || q.key || q["x-ingest-key"] || body.key || body["x-ingest-key"] || "";
    if (!safeEqual(supplied, KEY)) return res.status(401).json({ ok: false, error: "Wrong or missing key." });
  } else if (!fromLocalhost(req)) {
    return res.status(401).json({ ok: false, error: "INGEST_KEY not set — this endpoint only answers to localhost." });
  }

  /* Field names vary by forwarder — Message Mirror sends message_from / message_body / message_date,
     others send title / text / postedAt. Accept them all so any app works. The community name lives
     in the notification's title/"from" ("Sportsfc.vn: Admin"); the post is the body/text. */
  const app = pick("app", "appName", "packageName");
  const title = String(pick("title", "from", "message_from", "conversation") || "").trim();
  const text = String(pick("text", "body", "message_body", "message") || "").replace(/\\n/g, "\n").trim();

  /* TEMP DEBUG — capture every raw hit so we can see exactly what Tasker sends (remove after). */
  try {
    await store.addPosts("__debug", [{
      externalId: "dbg-" + Date.now() + "-" + Math.round(Math.random() * 9999),
      ts: new Date().toISOString(),
      text: JSON.stringify({ app: String(app).slice(0, 24), title: title.slice(0, 40),
        text: text.slice(0, 40), postedAt: String(pick("postedAt", "when", "date", "message_date", "time", "timestamp")).slice(0, 30) }),
    }]);
  } catch (e) {}

  /* Any authenticated hit is proof the phone's forwarder is alive — record it so the dashboard's
     monitor can tell "connected" from "went silent, since when". Never let a store hiccup fail the
     reply (the forwarder must always get its 200). A real post refreshes this via addPosts instead. */
  const beat = () => store.touch().catch(() => {});

  /* An explicit heartbeat ping (a periodic Tasker rule) carries no post — it exists only to keep
     the monitor green on a quiet day. Recognised early and answered plainly. */
  if (/^\s*(ping|heartbeat)\s*$/i.test(String(app)) || pick("ping", "heartbeat")) {
    await beat();
    return res.status(200).json({ ok: true, heartbeat: true });
  }

  if (!IS_VIBER(app)) {
    /* not an error — the forwarder may pass everything through; just decline quietly */
    await beat();
    return res.status(200).json({ ok: true, ignored: "not a Viber notification", app: String(app) });
  }

  const hay = (title + " " + text).toLowerCase();
  const hit = COMMUNITIES.find(c => hay.includes(c.name));
  if (!hit) {
    await beat();
    return res.status(200).json({ ok: true, ignored: "no watched community matched",
      title, watching: COMMUNITIES.map(c => c.name) });
  }
  if (!text || BUNDLE.test(text)) {
    await beat();
    return res.status(200).json({ ok: true, ignored: "bundle or empty — no single post to file",
      channelId: hit.channelId, text });
  }

  const ts = toIso(pick("postedAt", "when", "date", "message_date", "time", "timestamp"));
  /* The id decides what counts as "the same post". Viber posts one notification and then UPDATES it
     when the sender name resolves, so the very same video arrives twice — once as "Unknown: Video
     message" and once as "Sportsfc.vn: Video message", often a minute apart. Two things make those
     collapse instead of double-counting:
       · strip the "<sender>:" prefix (the only part that differs between the two), and
       · bucket the time to 3 minutes, so a re-notify that crosses a minute boundary still lands on
         the same id (real Viber posts are spaced far wider than this, so distinct ones never merge). */
  const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idText = text.replace(new RegExp("^\\s*(unknown|" + reEsc(hit.name) + ")\\s*:\\s*", "i"), "").trim() || text;
  const bucket = Math.floor(new Date(ts).getTime() / (3 * 60e3));
  const externalId = "notif-" + crypto.createHash("sha1")
    .update(hit.channelId + "|" + bucket + "|" + idText).digest("hex").slice(0, 16);

  try {
    const out = await store.addPosts(hit.channelId, [{ externalId, ts, text, kind: "post" }]);
    return res.status(200).json({ ok: true, channelId: hit.channelId, ...out });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
