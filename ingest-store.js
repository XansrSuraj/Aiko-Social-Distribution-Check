/**
 * The store for posts pushed in from outside.
 *
 * Most channels are read by asking the platform — api/collect.js for the ones a server can reach,
 * the extension for the ones that need a logged-in session. Viber answers to neither: its invite
 * page carries no posts, it ships no web client for the extension to drive, and the desktop app's
 * message store is encrypted. Every route into Viber is shut.
 *
 * So the direction is reversed. Rather than reading the platform, this accepts what the thing that
 * *publishes* to it already knows. That is strictly the better source anyway — it cannot be broken
 * by a change on Viber's side, because Viber is not involved.
 *
 * Anything can feed it: the publishing system that already stamps every post with utm_source, a
 * phone rule that forwards the community's notifications, a scheduled job, a person with curl.
 * The endpoint is api/ingest.js and the shape it wants is documented there.
 *
 * Storage follows the same graceful-degradation rule as the rest of the app: the Supabase row when
 * one is configured — durable, and reachable from a deployment — and a file beside the app when
 * not, so a purely local setup still works end to end. Kept in its own row (id 2), never mixed
 * into the directory row every visitor reads.
 */
const fs = require("fs");
const path = require("path");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const TABLE = "orghub_state";
const ROW_ID = 2;
const FILE = path.join(__dirname, ".ingest.json");

/* A daily check never looks back further than a week, and the report widens to seven days at
   most — a fortnight leaves room to spare without letting the store grow forever. */
const MAX_DAYS = 14;
const MAX_PER_CHANNEL = 500;

const configured = () => !!(SB_URL && SB_KEY);
const sbHeaders = extra => Object.assign({
  apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json",
}, extra || {});

async function readAll() {
  if (configured()) {
    const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data`, { headers: sbHeaders() });
    if (!r.ok) throw new Error(`ingest read failed (${r.status})`);
    const rows = await r.json();
    return (Array.isArray(rows) && rows[0] && rows[0].data) || {};
  }
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; }
  catch (e) { return {}; }                       // absent or unreadable is simply "nothing yet"
}

async function writeAll(all) {
  if (configured()) {
    const w = await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: sbHeaders({ Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify([{ id: ROW_ID, data: all, updated_at: new Date().toISOString() }]),
    });
    if (!w.ok) throw new Error(`ingest write failed (${w.status}): ${await w.text()}`);
    return;
  }
  fs.writeFileSync(FILE, JSON.stringify(all), "utf8");
}

/* An id is what makes a repeated push harmless. A sender that re-posts the same day's list every
   hour — which a cron will — must not multiply the count, so anything already known by id is left
   exactly as it was rather than appended again. */
function normalise(p) {
  const ts = new Date(p && p.ts).getTime();
  if (!p || !isFinite(ts)) return null;
  const id = String(p.externalId || p.id || "").trim() || ("ts-" + ts);
  const out = {
    externalId: id,
    ts: new Date(ts).toISOString(),
    kind: String(p.kind || "post").slice(0, 24),
    text: String(p.text || ""),
    permalink: String(p.permalink || p.url || ""),
  };
  for (const k of ["views", "likes", "comments", "reposts", "duration"]) {
    const v = p[k];
    if (v !== undefined && v !== null && v !== "" && isFinite(Number(v))) out[k] = Number(v);
  }
  if (p.thumb) out.thumb = String(p.thumb);
  return out;
}

async function addPosts(channelId, posts) {
  const all = await readAll();
  const have = Array.isArray(all[channelId]) ? all[channelId] : [];
  const byId = new Map(have.map(p => [p.externalId, p]));

  let added = 0;
  for (const raw of posts || []) {
    const p = normalise(raw);
    if (!p) continue;
    if (byId.has(p.externalId)) continue;
    byId.set(p.externalId, p);
    added++;
  }

  const cutoff = Date.now() - MAX_DAYS * 86400e3;
  all[channelId] = [...byId.values()]
    .filter(p => new Date(p.ts).getTime() >= cutoff)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, MAX_PER_CHANNEL);

  await writeAll(all);
  return { added, total: all[channelId].length };
}

async function getPosts(channelId) {
  const all = await readAll();
  return Array.isArray(all[channelId]) ? all[channelId] : [];
}

module.exports = { addPosts, getPosts, readAll, writeAll, configured, MAX_DAYS };
