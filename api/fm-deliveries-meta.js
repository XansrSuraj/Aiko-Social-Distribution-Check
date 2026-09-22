/**
 * GET /api/fm-deliveries-meta?env=dev|test|prod
 *
 * Read-only proxy for GET /api/fm-deliveries-feed/meta — the CMS's own live vocabulary (states,
 * outcomes, failure stages, maxLimit), so the dashboard's filter UI reads the real list instead of
 * carrying a hardcoded copy that can drift (see docs §10: "state and outcome vocabularies can gain
 * values"). Same server-side-key setup as api/fm-deliveries.js — see fm-deliveries-client.js.
 */
const { upstreamGet } = require("../fm-deliveries-client.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET — this dashboard is read-only." });

  const { status, body } = await upstreamGet(req.query && req.query.env, "/api/fm-deliveries-feed/meta", {});
  return res.status(status).json(body);
};
