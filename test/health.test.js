/**
 * api/health.js — the pipeline monitor the dashboard polls.
 *
 * It answers two questions without any auth or post content: is the phone's forwarder still
 * touching the server (lastSeen + age), and is each watched community actually receiving posts.
 * The cases below pin what the dashboard's "connected / went silent" indicator relies on:
 *
 *   · with nothing heard yet, lastSeen is null (the monitor shows "no signal", not a false green)
 *   · a heartbeat touch sets lastSeen and a small age
 *   · a real post both stores under its community AND counts as a heartbeat
 *   · it never throws — an unreachable store degrades to nulls, never a 500
 *
 *   node test/health.test.js
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

function getHealth() {
  delete require.cache[require.resolve("../api/health.js")];
  const handler = require("../api/health.js");
  return new Promise(resolve => {
    handler({ method: "GET", headers: {}, query: {} },
      { setHeader() {}, status(c) { this._c = c; return this; },
        end() { resolve({ status: this._c || 200, body: null }); },
        json(p) { resolve({ status: this._c || 200, body: p }); } });
  });
}

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

(async () => {
  const store = fresh();

  console.log("── nothing heard yet");
  let r = await getHealth();
  check(r.status === 200 && r.body.ok, "health answers 200", JSON.stringify(r.body).slice(0, 80));
  check(r.body.lastSeen === null && r.body.ageSeconds === null,
    "lastSeen is null — the monitor shows 'no signal', not a false green");
  check(Array.isArray(r.body.channels) && r.body.channels.length === 2,
    "both watched communities are listed", JSON.stringify(r.body.channels.map(c => c.channelId)));
  check(r.body.channels.every(c => c.count === 0 && c.lastPost === null),
    "each starts empty");

  console.log("\n── a heartbeat touch marks the phone alive");
  await store.touch();
  r = await getHealth();
  check(typeof r.body.lastSeen === "string" && r.body.ageSeconds !== null && r.body.ageSeconds < 5,
    "lastSeen is set and the age is fresh", `age=${r.body.ageSeconds}`);

  console.log("\n── a real post stores under its community and also counts as alive");
  await store.addPosts("viber:sportsfc.fans", [
    { externalId: "h1", ts: new Date().toISOString(), text: "Sportsfc.fans match preview" }]);
  r = await getHealth();
  const fans = r.body.channels.find(c => c.channelId === "viber:sportsfc.fans");
  check(fans && fans.count === 1 && fans.lastPost, "the fans community shows 1 post with a lastPost",
    JSON.stringify(fans));
  const vn = r.body.channels.find(c => c.channelId === "viber:sportsfc.vn");
  check(vn && vn.count === 0, "the vn community is still empty — counts do not bleed across");
  check(r.body.ageSeconds !== null && r.body.ageSeconds < 5, "and lastSeen refreshed on the post");

  console.log(`\n  ${pass} passed, ${fail} failed`);
  try { BACKUP === null ? fs.unlinkSync(STORE_FILE) : fs.writeFileSync(STORE_FILE, BACKUP, "utf8"); }
  catch (e) {}
  process.exit(fail ? 1 : 0);
})();
