/**
 * api/health.js — which readers have their credentials. It says what is present and never the
 * value, because it answers without auth.
 *
 *   node test/health.test.js
 */
function getHealth(query) {
  delete require.cache[require.resolve("../api/health.js")];
  const handler = require("../api/health.js");
  return new Promise(resolve => {
    handler({ method: "GET", headers: {}, query: query || {} },
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
  console.log("── health answers");
  let r = await getHealth();
  check(r.status === 200 && r.body.ok, "health answers 200", JSON.stringify(r.body).slice(0, 80));
  check(!/viber/i.test(JSON.stringify(r.body)), "nothing about Viber is left in it");

  console.log("\n── the readers block says which credentials are present, and never their value");
  delete process.env.YOUTUBE_API_KEY;
  r = await getHealth();
  check(/NO KEY/.test(r.body.readers.youtube),
    "a missing YouTube key is called out — on this host it ends the read, not degrades it",
    r.body.readers.youtube);
  process.env.YOUTUBE_API_KEY = "super-secret-value";
  r = await getHealth();
  check(r.body.readers.youtube === "key set", "and a present one just says so", r.body.readers.youtube);
  check(JSON.stringify(r.body).indexOf("super-secret-value") === -1,
    "the key itself never appears in a response this endpoint serves without auth");
  delete process.env.YOUTUBE_API_KEY;

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
