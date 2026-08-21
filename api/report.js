/**
 * GET  /api/report  -> read the shared daily-check report (public, read-only)
 * PUT  /api/report  -> replace it        (body: { data: {...}, baseUpdatedAt?: "…" })
 *
 * Why this exists
 * ---------------
 * The daily check used to live only in the browser that ran it (localStorage). That means a check
 * run on the office laptop was invisible on a phone, and two people could not see the same "today"
 * picture. This endpoint gives the report ONE home in Supabase, so every device that opens the
 * dashboard reads the same last run, the same counts, and the same manual ✓ confirmations.
 *
 * Storage: one row in the same orghub_state table api/data.js uses, id = 3 (id 1 is the directory,
 * id 2 is the ingest store). Plain REST, no npm packages. If Supabase is not configured the endpoint
 * reports mode:"local" and the browser keeps using localStorage — the check still works, it just is
 * not shared. That is the first fallback; the browser keeping its own copy either way is the second.
 *
 * Security posture (deliberate, documented)
 * -----------------------------------------
 * The report is non-sensitive operational data — post counts, timestamps, and which channel a drop
 * landed on. There is no login in this tool by design, so the write is not gated by a client secret
 * (a secret shipped to the browser would not be secret). Instead:
 *   · the payload is shape-checked and size-capped here, so a malformed or oversized body cannot
 *     poison the row or blow past Postgres limits;
 *   · a stale write is refused with 409 (optimistic concurrency), same as api/data.js;
 *   · the deployment itself should sit behind Vercel Deployment Protection (password / SSO) — that
 *     protects the dashboard AND every /api route at the platform layer, which is the right place to
 *     keep an internal tool private. See README.
 * If ADMIN_PASSWORD is set, the write additionally requires the x-admin-key header — a belt-and-
 * braces option for anyone who wants app-level gating on top of platform protection.
 */
const crypto = require("crypto");

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ADMIN  = process.env.ADMIN_PASSWORD || "";
const TABLE  = "orghub_state";
const ROW_ID = 3;

/* a report is small — counts, a few captions, some confirms. Cap the stored blob well under any
   Postgres/PostgREST limit so a runaway client (or a bad actor) cannot bloat the row. */
const MAX_BYTES = 2 * 1024 * 1024;

const configured = () => !!(SB_URL && SB_KEY);

function sbHeaders(extra) {
  return Object.assign({
    apikey: SB_KEY,
    Authorization: "Bearer " + SB_KEY,
    "Content-Type": "application/json",
  }, extra || {});
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();

  /* ---------------- not configured: local mode ---------------- */
  if (!configured()) {
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, mode: "local", configured: false, data: null });
    }
    /* a PUT in local mode is not an error — the browser simply keeps its own copy */
    return res.status(200).json({ ok: true, mode: "local", configured: false, saved: false });
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
        data: row ? row.data : null,
        updatedAt: row ? row.updated_at : null,
      });
    }

    /* ---------------- write ---------------- */
    if (req.method === "PUT") {
      /* optional app-level gate, only when the deployment opts in with ADMIN_PASSWORD */
      if (ADMIN && !safeEqual(req.headers["x-admin-key"] || "", ADMIN)) {
        return res.status(401).json({ ok: false, error: "Wrong admin password." });
      }

      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || typeof body.data !== "object" || body.data === null || Array.isArray(body.data)) {
        return res.status(400).json({ ok: false, error: "Expected a JSON body of the form { data: {...} }." });
      }
      const serialized = JSON.stringify(body.data);
      if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
        return res.status(413).json({ ok: false, error: "Report is too large to store." });
      }

      /* optimistic concurrency, byte-for-byte the same instant comparison api/data.js uses:
         Postgres returns "…+00:00", Date#toISOString returns "…Z" — compare moments, not text. */
      if (body.baseUpdatedAt !== undefined && body.baseUpdatedAt) {
        const cur = await fetch(
          `${SB_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=updated_at`,
          { headers: sbHeaders() }
        );
        if (cur.ok) {
          const rows = await cur.json();
          const server = rows && rows[0] ? rows[0].updated_at : null;
          if (server) {
            const a = new Date(server).getTime(), b = new Date(body.baseUpdatedAt).getTime();
            if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
              return res.status(409).json({
                ok: false, conflict: true, updatedAt: server,
                error: "The report was updated on another device. Reload to get the latest.",
              });
            }
          }
        }
      }

      const now = new Date().toISOString();
      const w = await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
        method: "POST",
        headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=representation" }),
        body: JSON.stringify([{ id: ROW_ID, data: body.data, updated_at: now }]),
      });
      if (!w.ok) throw new Error(`Supabase write failed (${w.status}): ${await w.text()}`);

      let stored = now;
      try { const back = await w.json(); if (Array.isArray(back) && back[0] && back[0].updated_at) stored = back[0].updated_at; }
      catch (e) {}
      return res.status(200).json({ ok: true, mode: "cloud", saved: true, updatedAt: stored });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed." });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
