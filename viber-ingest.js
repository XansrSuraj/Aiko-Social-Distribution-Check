/**
 * The shared core for turning a single Viber community post into a stored post — used by BOTH
 * ways a post reaches us:
 *   · api/notif.js        — a phone forwards the on-screen notification (the always-on fallback)
 *   · api/viber-webhook.js — Viber's own bot webhook pushes the post server-side (the reliable one)
 *
 * Keeping the routing, de-duplication and logging here means both doors behave identically: the
 * same community mapping, the same "one post per piece of content within 6 minutes" rule, the same
 * live-log entry. A post that arrives through both doors is stored once, not twice.
 */
const crypto = require("crypto");
const store = require("./ingest-store.js");

/* community name (as Viber shows it) -> the channel id it belongs to. Case-insensitive substring,
   because Viber labels a post variously ("Sportsfc.vn", "Sportsfc.vn: Admin", name + a count). */
const COMMUNITIES = (process.env.VIBER_COMMUNITIES ||
  "Sportsfc.vn=viber:sportsfc.vn,Sportsfc.fans=viber:sportsfc.fans")
  .split(",").map(s => s.trim()).filter(Boolean)
  .map(pair => {
    const i = pair.indexOf("=");
    return { name: pair.slice(0, i).trim().toLowerCase(), channelId: pair.slice(i + 1).trim() };
  }).filter(c => c.name && c.channelId);

/* a bundle ("3 new messages", "tin nhắn mới") carries no post — Viber collapsing several */
const BUNDLE = /^\s*(\d+\s+new\s+messages?|new\s+message|you\s+have|tin nhắn mới|\d+\s+tin nhắn)/i;

/* {postedAt} may be epoch millis, epoch seconds, or ISO — accept all; now only when truly absent */
function toIso(v) {
  if (v === undefined || v === null || v === "") return new Date().toISOString();
  if (/^\d{13}$/.test(String(v))) return new Date(Number(v)).toISOString();
  if (/^\d{10}$/.test(String(v))) return new Date(Number(v) * 1000).toISOString();
  const t = new Date(v).getTime();
  return isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

/* Find the community a post belongs to. An explicit channelId (a per-community webhook that carries
   ?community=viber:sportsfc.vn) wins outright; otherwise match the name out of the title/text. */
function matchCommunity(title, text, explicitChannelId) {
  if (explicitChannelId) {
    const known = COMMUNITIES.find(c => c.channelId === explicitChannelId);
    return known || { name: "", channelId: explicitChannelId };
  }
  const hay = (String(title || "") + " " + String(text || "")).toLowerCase();
  return COMMUNITIES.find(c => hay.includes(c.name)) || null;
}

/* Record one Viber post: route it, de-dup it, store it, and log it raw with its outcome. Returns
   { outcome, response, hit, ts } — the caller only has to send `response` back. Never throws. */
async function record({ title, text, rawPostedAt, explicitChannelId, source }) {
  title = String(title || "").trim();
  text = String(text || "").replace(/\\n/g, "\n").trim();
  const ts = toIso(rawPostedAt);
  const hit = matchCommunity(title, text, explicitChannelId);

  /* Viber re-notifies the same post once the sender name resolves ("Unknown: …" → "Sportsfc.vn: …"),
     so strip a leading "<sender>:" prefix before comparing, and collapse anything within 6 min. */
  const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripSender = t => !hit || !hit.name ? String(t || "").trim()
    : String(t || "").replace(new RegExp("^\\s*(unknown|" + reEsc(hit.name) + ")\\s*:\\s*", "i"), "").trim();

  let outcome, response;
  if (!hit) {
    outcome = "ignored — not a watched community";
    response = { ok: true, ignored: "no watched community matched", title, watching: COMMUNITIES.map(c => c.name) };
  } else if (!text || BUNDLE.test(text)) {
    outcome = "skipped — bundle / no caption";
    response = { ok: true, ignored: "bundle or empty — no single post to file", channelId: hit.channelId, text };
  } else {
    const idText = stripSender(text) || text;
    const bucket = Math.floor(new Date(ts).getTime() / (3 * 60e3));
    const externalId = "notif-" + crypto.createHash("sha1")
      .update(hit.channelId + "|" + bucket + "|" + idText).digest("hex").slice(0, 16);
    try {
      const DEDUP_MS = 6 * 60e3;
      const existing = await store.getPosts(hit.channelId);
      const already = existing.some(p =>
        stripSender(p.text) === idText && Math.abs(new Date(p.ts).getTime() - new Date(ts).getTime()) <= DEDUP_MS);
      if (already) {
        outcome = "duplicate — already have this one";
        response = { ok: true, channelId: hit.channelId, added: 0, total: existing.length, deduped: "same post already within 6 min" };
      } else {
        const out = await store.addPosts(hit.channelId, [{ externalId, ts, text, kind: "post" }]);
        outcome = "stored";
        response = { ok: true, channelId: hit.channelId, ...out };
      }
    } catch (err) {
      outcome = "error";
      response = { ok: false, error: String((err && err.message) || err) };
    }
  }

  try {
    await store.logNotif({
      at: new Date().toISOString(), title, text, postedAt: String(rawPostedAt || ""), ts,
      community: hit ? hit.channelId : "", outcome, source: source || "",
    });
  } catch (e) { try { await store.touch(); } catch (e2) {} }

  return { outcome, response, hit, ts };
}

module.exports = { COMMUNITIES, BUNDLE, toIso, matchCommunity, record };
