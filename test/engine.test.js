/**
 * The React app's engine (src/engine/engine.js), loaded the way the browser loads it — as an ES
 * module, through createEngine() — with the few browser globals it touches stubbed out. Checks the
 * channel list it reports on (every region, no Viber left anywhere), that a report builds on an
 * empty store and on a seeded one, and that update() saves and redraws.
 *
 *   node test/engine.test.js
 */
const path = require("path");
const { pathToFileURL } = require("url");

let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };

const store = {};
const mem = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
Object.assign(globalThis, {
  localStorage: mem, sessionStorage: { ...mem },
  location: { protocol: "file:", href: "file:///", origin: "null", search: "", hash: "" },
  addEventListener() {}, removeEventListener() {}, postMessage() {},
});
globalThis.window = globalThis;

(async () => {
  const { createEngine } = await import(pathToFileURL(path.join(__dirname, "..", "src", "engine", "engine.js")).href);
  let redraws = 0;
  const E = createEngine({ toast() {}, onChange: () => redraws++ });

  console.log("── channels");
  const all = E.dcChannels(E.SPORTSFC);
  ok(all.length === 14, "14 channels across every region", String(all.length));
  ok(!all.some(c => /viber/i.test(c.platform + c.id + c.url)), "no Viber channel left");
  ok(!/viber/i.test(JSON.stringify(E.DEF_PLATFORMS)), "no Viber platform left");
  ok(E.dcChannels(E.SPORTSFC, "br").length === 3, "Brazil has its 3 channels");
  ok(E.dcChannels(E.SPORTSFC, "br").every(c => c.lang === "pt"), "Brazil's channels are Portuguese");

  console.log("── report");
  const ropt = { tz: 7, win: 15, maxPerPeriod: 4, ...E.windowOpt() };
  const merged = E.mergeReports(E.REGIONS.map(([id, name]) => ({ region: id, name, rep: E.reconcile(E.dcChannels(E.SPORTSFC, id), ropt) })));
  ok(merged.rows.length === 14 && merged.slots.length === 0, "an empty store builds an empty report, every channel listed");

  const now = Date.now(), at = m => new Date(now - m * 60e3).toISOString();
  E.update(c => {
    c.posts["yt-vn"] = [{ externalId: "1", ts: at(30), text: "Tây Ban Nha có thể phá vỡ kỷ lục", kind: "short" }];
    c.posts["tg-vn"] = [{ externalId: "2", ts: at(28), text: "Tây Ban Nha có thể phá vỡ kỷ lục", kind: "post" }];
    c.window = "24";
  });
  ok(redraws >= 1, "update() redraws");
  ok(JSON.parse(store["orghub.checks"] || "{}").window === "24", "update() saves the store");
  const r = E.reconcile(E.dcChannels(E.SPORTSFC, "main"), { tz: 7, win: 15, maxPerPeriod: 4, ...E.windowOpt() });
  ok(r.slots.length === 1 && r.slots[0].present.length === 2, "two posts minutes apart are one drop on two channels",
     `${r.slots.length} drop(s)`);

  E.resetReport();
  ok(Object.keys(E.checks.posts).length === 0 && E.checks.window === "24", "Delete report clears posts but keeps the settings");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
