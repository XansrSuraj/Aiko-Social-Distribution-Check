/**
 * GET /api/fm-deliveries?env=dev|test|prod&<filters>
 *
 * Read-only proxy in front of the real FM Deliveries feed (docs: "FM Deliveries API — consumer
 * guide"). Exists so the dashboard's own x-api-key per environment stays server-side
 * (FM_DELIVERIES_API_KEY_DEV/TEST/PROD in fm-deliveries-client.js) instead of shipping to the
 * browser. Every filter the upstream accepts is passed through as-is — nothing here defaults,
 * renames or validates a value beyond what the query string already says, so a 400 for a bad filter
 * is the CMS's own message, not a guess of ours.
 *
 * GET only. There is no other method handler because this dashboard never writes anything.
 */
const { upstreamGet } = require("../fm-deliveries-client.js");

const PASSTHROUGH = [
  "since", "until", "timeField", "channel", "language", "state", "outcome",
  "cardId", "setId", "matchId", "attempts", "limit", "page",
];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET — this dashboard is read-only." });

  const query = {};
  for (const k of PASSTHROUGH) {
    const v = req.query ? req.query[k] : undefined;
    if (v === undefined) continue;
    query[k] = Array.isArray(v) ? v.join(",") : v;
  }

  const { status, body } = await upstreamGet(req.query && req.query.env, "/api/fm-deliveries-feed", query);
  return res.status(status).json(body);
};
