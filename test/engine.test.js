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

  console.log("── MatchPulse, a second brand");
  const MP = createEngine({ brand: "matchpulse", toast() {}, onChange() {} });
  const mp = MP.dcChannels(MP.ORG);
  ok(MP.ORG.name === "MatchPulse" && mp.length === 9, "9 MatchPulse channels", String(mp.length));
  ok(MP.REGIONS.map(r => r[0]).join() === "hi,en", "two regions, Hindi and English");
  ok(MP.dcChannels(MP.ORG, "hi").every(c => c.lang === "hi") && MP.dcChannels(MP.ORG, "en").every(c => c.lang === "en"),
     "every Hindi channel is hi, every English one en");
  ok(mp.every(c => c.id.startsWith("mp-")) && !mp.some(c => all.some(s => s.id === c.id)), "no channel id shared with SportsFC");
  ok(MP.checks.tz === 5.5, "MatchPulse reports in India time by default");
  MP.update(c => {
    /* the same post, measured: English at 20:44, Hindi at 21:21 — two regions, each one drop */
    c.window = "24";
    c.posts["mp-tg-en"] = [{ externalId: "e1", ts: at(80), text: "PAK vs IND 👀 Game on! Who draws first blood? Your pick" }];
    c.posts["mp-yt-en"] = [{ externalId: "e2", ts: at(79), text: "PAK vs IND 👀 Game on! Who draws first blood? Your pick" }];
    c.posts["mp-tg-hi"] = [{ externalId: "h1", ts: at(43), text: "PAK vs IND 👀 रोमांचक टक्कर — आपका दांव किस पर? विजेता" }];
    c.posts["mp-yt-hi"] = [{ externalId: "h2", ts: at(42), text: "PAK vs IND 👀 रोमांचक टक्कर — आपका दांव किस पर? विजेता" }];
  });
  ok(JSON.parse(store["orghub.checks.matchpulse"] || "{}").posts["mp-tg-hi"], "saved under its own key");
  ok(!JSON.parse(store["orghub.checks"] || "{}").posts["mp-tg-hi"], "and never into SportsFC's report");
  const mopt = { tz: 5.5, win: 15, maxPerPeriod: 4, ...MP.windowOpt() };
  const mrep = MP.mergeReports(MP.REGIONS.map(([id, name]) => ({ region: id, name, rep: MP.reconcile(MP.dcChannels(MP.ORG, id), mopt) })));
  ok(mrep.slots.length === 2 && mrep.slots.every(s => s.present.length === 2),
     "37 minutes apart in two languages = one drop in each region, not two half-missed ones", `${mrep.slots.length} drop(s)`);
  ok(!mrep.alerts.some(a => a.kind === "lang"), "Hindi captions on the Hindi channels raise no language flag");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
