/**
 * GET  /api/data  -> read the whole state (public, read-only)
 * PUT  /api/data  -> replace the whole state (requires x-admin-key header)
 *
 * Storage: one row in Supabase (id = 1, data jsonb). No npm packages — plain REST.
 * If the env vars are missing the API reports mode:"local" and the frontend
 * transparently falls back to browser storage, so the site is never broken.
 */
const crypto = require("crypto");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ADMIN  = process.env.ADMIN_PASSWORD || "";
const TABLE  = "orghub_state";
const ROW_ID = 1;

const configured = () => !!(SB_URL && SB_KEY);

function sbHeaders(extra) {
  return Object.assign({
    apikey: SB_KEY,
    Authorization: "Bearer " + SB_KEY,
    "Content-Type": "application/json",
  }, extra || {});
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    // still burn a comparison so length isn't leaked by timing
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();

  /* ---------------- not configured yet: local mode ---------------- */
  if (!configured()) {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true, mode: "local", configured: false, data: null,
        message: "Cloud storage not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.",
      });
    }
    return res.status(503).json({ ok: false, error: "Cloud storage is not configured on this deployment." });
  }

  try {
    /* ---------------- read ---------------- */
    if (req.method === "GET") {
      const r = await fetch(
        `${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data,updated_at`,
        { headers: sbHeaders() }
      );
      if (!r.ok) throw new Error(`Supabase read failed (${r.status}): ${await r.text()}`);

      const rows = await r.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      return res.status(200).json({
        ok: true, mode: "cloud", configured: true,
        adminReady: !!ADMIN,
        data: row ? row.data : null,
        updatedAt: row ? row.updated_at : null,
      });
    }

    /* ---------------- write ---------------- */
    if (req.method === "PUT") {
      if (!ADMIN) {
        return res.status(503).json({ ok: false, error: "ADMIN_PASSWORD is not set on this deployment." });
      }
      if (!safeEqual(req.headers["x-admin-key"] || "", ADMIN)) {
        return res.status(401).json({ ok: false, error: "Wrong admin password." });
      }

      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body.data !== "object" || body.data === null) {
        return res.status(400).json({ ok: false, error: "Expected a JSON body of the form { data: {...} }." });
      }

      // optimistic concurrency: refuse the write if someone else saved in the meantime.
      // Compare instants, never raw strings — Postgres hands back
      // "2026-07-29T10:22:40.993424+00:00" while Date#toISOString produces
      // "2026-07-29T10:22:40.993Z". Those are the same moment but different text,
      // so a string compare reports a conflict on every single save.
      if (body.baseUpdatedAt !== undefined) {
        const cur = await fetch(
          `${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=updated_at`,
          { headers: sbHeaders() }
        );
        if (cur.ok) {
          const rows = await cur.json();
          const server = rows && rows[0] ? rows[0].updated_at : null;
          if (server && body.baseUpdatedAt) {
            const a = new Date(server).getTime();
            const b = new Date(body.baseUpdatedAt).getTime();
            if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
              return res.status(409).json({
                ok: false, conflict: true, updatedAt: server,
                error: "This data was changed on another device. Reload to get the latest version.",
              });
            }
          }
        }
      }

      const now = new Date().toISOString();
      // return=representation so the response carries the value Postgres actually stored,
      // which is what the client must echo back on its next write.
      const w = await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
        method: "POST",
        headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }),
        body: JSON.stringify([{ id: ROW_ID, data: body.data, updated_at: now }]),
      });
      if (!w.ok) throw new Error(`Supabase write failed (${w.status}): ${await w.text()}`);

      let stored = now;
      try {
        const back = await w.json();
        if (Array.isArray(back) && back[0] && back[0].updated_at) stored = back[0].updated_at;
      } catch (e) { /* fall back to the value we sent */ }

      return res.status(200).json({ ok: true, updatedAt: stored });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed." });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
