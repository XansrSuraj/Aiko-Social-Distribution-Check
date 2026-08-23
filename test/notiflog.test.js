/**
 * The Viber live log — /api/notif records every Viber notification it receives (raw + outcome),
 * and /api/notiflog reads them back for the dashboard's real-time panel.
 *
 *   · a stored post, an ignored one, and a bundle all land in the log with the right outcome
 *   · the log is newest-first and carries the raw text the phone sent
 *   · a non-Viber hit and a heartbeat ping are NOT logged (the log is Viber-only)
 *   · /api/notiflog returns the list without any key
 *
 *   node test/notiflog.test.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const STORE_FILE = path.join(ROOT, ".ingest.json");
const BACKUP = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, "utf8") : null;

function fresh() {
  try { fs.unlinkSync(STORE_FILE); } catch (e) {}
  delete require.cache[require.resolve("../ingest-store.js")];
  return require("../ingest-store.js");
}
function notif(body) {
  delete require.cache[require.resolve("../api/notif.js")];
  const h = require("../api/notif.js");
  return new Promise(r => h({ method: "POST", body, headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    { setHeader() {}, status(c) { this._c = c; return this; }, json(p) { r({ status: this._c || 200, body: p }); } }));
}
function readLog() {
  delete require.cache[require.resolve("../api/notiflog.js")];
  const h = require("../api/notiflog.js");
  return new Promise(r => h({ method: "GET", headers: {} },
    { setHeader() {}, status(c) { this._c = c; return this; }, json(p) { r({ status: this._c || 200, body: p }); } }));
}

let pass = 0, fail = 0;
const check = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };

(async () => {
  const store = fresh();
  const now = Date.now();

  console.log("── every Viber notification is logged with its outcome");
  await notif({ app: "Viber", title: "Sportsfc.vn", text: "Sportsfc.vn: match preview", postedAt: String(now) });
  await notif({ app: "Viber", title: "Some Group", text: "hello all" });                 // no community
  await notif({ app: "Viber", title: "Sportsfc.fans", text: "3 new messages" });          // bundle

  let r = await readLog();
  check(r.status === 200 && r.body.ok && Array.isArray(r.body.log), "/api/notiflog returns the log with no key", String(r.status));
  check(r.body.log.length === 3, "all three Viber hits were logged", String(r.body.log.length));

  const byOutcome = r.body.log.map(e => e.outcome);
  check(byOutcome.some(o => /stored/.test(o)), "the real post is logged as stored", JSON.stringify(byOutcome));
  check(byOutcome.some(o => /not a watched community/.test(o)), "the unknown community is logged as ignored");
  check(byOutcome.some(o => /bundle/.test(o)), "the bundle is logged as skipped");

  console.log("\n── newest first, and the raw text is kept");
  check(r.body.log[0].text === "Sportsfc.fans: 3 new messages" || /3 new messages/.test(r.body.log[0].text) || r.body.log[0].outcome.includes("bundle"),
    "the most recent hit is at the top", JSON.stringify(r.body.log[0]));
  const stored = r.body.log.find(e => /stored/.test(e.outcome));
  check(stored && stored.text === "Sportsfc.vn: match preview" && stored.community === "viber:sportsfc.vn",
    "a logged entry carries the exact text and community", JSON.stringify(stored));

  console.log("\n── the log is Viber-only: a ping and a non-Viber hit are not logged");
  const before = (await readLog()).body.log.length;
  await notif({ app: "ping" });
  await notif({ app: "WhatsApp", title: "Mom", text: "call me" });
  const after = (await readLog()).body.log.length;
  check(after === before, "a heartbeat ping and a WhatsApp notification add nothing to the Viber log", `${before} → ${after}`);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  try { BACKUP === null ? fs.unlinkSync(STORE_FILE) : fs.writeFileSync(STORE_FILE, BACKUP, "utf8"); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
