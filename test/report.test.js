/**
 * api/report.js — the shared daily-check report row.
 *
 * The report used to live only in the browser that ran the check. This endpoint gives it one home
 * so every device sees the same "today". The cases below pin the behaviour that keeps it safe to
 * leave open (there is no login in this tool by design):
 *
 *   · with no Supabase configured it never errors — the browser keeps its own copy (local mode)
 *   · a malformed body is refused, not stored, so a bad client cannot poison the row
 *   · an oversized body is refused, so the row cannot be bloated without bound
 *   · a stale write (someone else saved meanwhile) is refused with 409, not silently clobbered
 *   · a good write round-trips and reports the instant it was stored
 *
 *   node test/report.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "report.js");
const realFetch = global.fetch;

function load() { delete require.cache[require.resolve(MOD)]; return require(MOD); }

function call(method, body, headers) {
  const handler = load();
  return new Promise(resolve => {
    handler({ method, body, headers: headers || {}, query: {} },
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
  /* ── local mode: nothing configured ─────────────────────────────────────── */
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.ADMIN_PASSWORD;

  console.log("── with no cloud storage, the endpoint never breaks the app");
  let r = await call("GET");
  check(r.status === 200 && r.body.mode === "local" && r.body.data === null,
    "GET reports local mode and no shared data", JSON.stringify(r.body));
  r = await call("PUT", { data: { lastRun: "x" } });
  check(r.status === 200 && r.body.saved === false,
    "PUT in local mode is accepted but not saved — the browser keeps its copy", JSON.stringify(r.body));

  /* ── configured mode, Supabase stubbed ──────────────────────────────────── */
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "svc";

  let store = { data: { lastRun: "earlier" }, updated_at: "2026-08-21T10:00:00.000+00:00" };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if ((opts || {}).method === "POST") {
      const sent = JSON.parse(opts.body)[0];
      store = { data: sent.data, updated_at: sent.updated_at };
      return { ok: true, status: 200, json: async () => [store], text: async () => "" };
    }
    // a read (GET row)
    return { ok: true, status: 200, json: async () => (store ? [store] : []), text: async () => "" };
  };

  console.log("\n── with cloud storage, the report has one shared home");
  r = await call("GET");
  check(r.status === 200 && r.body.mode === "cloud" && r.body.data.lastRun === "earlier",
    "GET returns the stored report", JSON.stringify(r.body));

  r = await call("PUT", { data: { lastRun: "now", counts: { "2026-08-21": {} } } });
  check(r.status === 200 && r.body.saved === true && r.body.updatedAt,
    "a good write is stored and reports its instant", JSON.stringify(r.body));
  check(store.data.lastRun === "now", "and the row actually changed", JSON.stringify(store.data));

  console.log("\n── what must never reach the row");
  r = await call("PUT", { data: "not an object" });
  check(r.status === 400, "a non-object body is refused", String(r.status));
  r = await call("PUT", { nope: true });
  check(r.status === 400, "a body with no data field is refused", String(r.status));
  r = await call("PUT", { data: { blob: "x".repeat(2 * 1024 * 1024 + 10) } });
  check(r.status === 413, "an oversized body is refused", String(r.status));

  console.log("\n── a stale write does not clobber a newer one");
  store = { data: { lastRun: "server-newer" }, updated_at: "2026-08-21T12:00:00.000+00:00" };
  r = await call("PUT", { data: { lastRun: "mine" }, baseUpdatedAt: "2026-08-21T10:00:00.000Z" });
  check(r.status === 409 && r.body.conflict, "a write based on an old version is refused with 409", JSON.stringify(r.body));
  check(store.data.lastRun === "server-newer", "and the newer report is left intact", JSON.stringify(store.data));

  console.log("\n── an admin password, if set, gates the write");
  process.env.ADMIN_PASSWORD = "secret";
  r = await call("PUT", { data: { lastRun: "z" } }, { "x-admin-key": "wrong" });
  check(r.status === 401, "a wrong admin key is refused when ADMIN_PASSWORD is set", String(r.status));
  r = await call("PUT", { data: { lastRun: "z" } }, { "x-admin-key": "secret" });
  check(r.status === 200, "the right admin key writes", String(r.status));
  delete process.env.ADMIN_PASSWORD;

  global.fetch = realFetch;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
