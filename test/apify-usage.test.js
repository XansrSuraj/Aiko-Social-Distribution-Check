/**
 * api/apify-usage.js — credit used/left, this project's recent runs, and (?runs=) each named run's
 * own bill and whether it has settled. Stubbed fetch playing Apify's API; nothing real is called.
 *
 * Pinned: unrelated actors' runs never show up as a daily-check cost, no dataset id or token leaks
 * out, malformed run ids are not passed on, and a run whose dollars do not yet cover its charged
 * events reads as unsettled.
 *
 *   node test/apify-usage.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "apify-usage.js");
const realFetch = global.fetch;

let pass = 0, fail = 0;
const check = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };

const IDS = { "apify~instagram-post-scraper": "A1", "apify~facebook-reels-scraper": "A2",
              "clockworks~tiktok-scraper": "A3", "xquik~x-tweet-scraper": "A4" };
const RUNS = {
  runSettledFb: { id: "runSettledFb", actId: "A2", status: "SUCCEEDED", usageTotalUsd: 0.03,
                  chargedEventCounts: { "apify-default-dataset-item": 6 }, defaultDatasetId: "SECRET-DS" },
  runPartialFb: { id: "runPartialFb", actId: "A2", status: "SUCCEEDED", usageTotalUsd: 0.001,
                  chargedEventCounts: { "apify-default-dataset-item": 6 } },
  runOtherActor: { id: "runOtherActor", actId: "ZZ", status: "SUCCEEDED", usageTotalUsd: 9 },
};

function call(query) {
  const asked = [];
  global.fetch = async u => {
    asked.push(String(u));
    const p = new URL(u).pathname.replace("/v2", "");
    const J = d => ({ status: 200, json: async () => ({ data: d }) });
    if (p === "/users/me/limits") return J({ monthlyUsageCycle: { startAt: "s", endAt: "e" },
                                             limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 3.6 } });
    if (p === "/users/me") return J({ plan: { id: "FREE" } });
    if (p.startsWith("/acts/")) return J({ id: IDS[decodeURIComponent(p.slice(6))] });
    if (p === "/actor-runs") return J({ items: Object.values(RUNS) });
    const m = p.match(/^\/actor-runs\/([^/]+)$/);
    if (m && RUNS[m[1]]) return J(RUNS[m[1]]);
    return { status: 404, json: async () => ({ error: { message: "nope" } }) };
  };
  process.env.APIFY_TOKEN = "tok";
  delete require.cache[require.resolve(MOD)];
  const handler = require(MOD);
  return new Promise(resolve => handler({ method: "GET", query, url: "/api/apify-usage" },
    { setHeader() {}, status() { return this; }, json: j => resolve({ j, asked }) }))
    .finally(() => { global.fetch = realFetch; delete process.env.APIFY_TOKEN; });
}

(async () => {
  console.log("── credit and recent runs");
  {
    const { j } = await call({});
    check(j.ok && j.usedUsd === 3.6 && j.limitUsd === 5 && j.remainingUsd === 1.4 && j.plan === "FREE",
      "used, limit and remaining come from the account's own limits", JSON.stringify({ u: j.usedUsd, r: j.remainingUsd }));
    check(j.runs.length === 2 && j.runs.every(r => r.actor === "apify~facebook-reels-scraper"),
      "only this project's actors' runs are listed", JSON.stringify(j.runs.map(r => r.actor)));
    check(!JSON.stringify(j).includes("SECRET-DS") && !JSON.stringify(j).includes("tok"),
      "no dataset id and no token in the answer");
    check(!("settle" in j), "no settle block unless runs were asked for");
  }

  console.log("\n── ?runs= settles a press's bill");
  {
    const { j, asked } = await call({ runs: "runSettledFb,runPartialFb,runOtherActor,bad id!,../x" });
    const by = Object.fromEntries(j.settle.map(s => [s.runId, s]));
    check(by.runSettledFb && by.runSettledFb.settled === true && by.runSettledFb.usd === 0.03,
      "a run whose dollars cover its six reels is settled", JSON.stringify(by.runSettledFb));
    check(by.runPartialFb && by.runPartialFb.settled === false && by.runPartialFb.usd === 0.001,
      "a run showing six reels charged beside $0.001 is not", JSON.stringify(by.runPartialFb));
    check(by.runOtherActor && by.runOtherActor.error && by.runOtherActor.usd === undefined,
      "another actor's run is not answered for", JSON.stringify(by.runOtherActor));
    check(j.settle.length === 3 && !asked.some(u => /bad|\.\./.test(u)),
      "malformed run ids are dropped, never passed on to Apify", String(j.settle.length));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
