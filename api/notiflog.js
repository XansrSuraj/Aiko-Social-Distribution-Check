/**
 * GET /api/notiflog  — the live feed of everything the phone has forwarded for Viber.
 *
 * Read-only and public (like /api/health): it carries only what the phone already put on its own
 * notification shade — the community, the notification text, when it was sent, and what the tool
 * did with it (stored / ignored / duplicate). No keys, no other apps, no personal messages. The
 * dashboard polls this every few seconds to show the log in real time.
 *
 * Never throws: an unreachable store returns an empty list rather than a 500.
 */
const store = require("../ingest-store.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET." });

  let log = [];
  try { log = await store.notifLog(); } catch (e) { log = []; }
  return res.status(200).json({ ok: true, now: new Date().toISOString(), count: log.length, log });
};
