/**
 * GET /api/apify-usage  — how much of this month's Apify credit is used, how much is left, and what
 * the most recent runs of this project's actors cost. Read-only: it never starts a run, and it
 * returns figures only — never the token, and never a dataset id (Apify storages are readable by
 * anyone who has the id).
 *
 *   -> { ok, configured, plan, usedUsd, limitUsd, remainingUsd, cycleStart, cycleEnd,
 *        runs: [ { actor, status, startedAt, finishedAt, usd } ] }
 *
 * GET /api/apify-usage?runs=<id>,<id>  — the same, plus each named run's own bill and whether it has
 * settled yet: Apify fills in a run's bill some time after the run stops (see apify-actors.js), so
 * the dashboard asks for its press's runs again a little later to replace a provisional figure.
 *
 *   -> { …, settle: [ { runId, actor, status, usd, settled } ] }
 *
 * usedUsd comes from Apify's own account limits and can trail a run that just finished by a minute
 * or so; each run's usd is that run's own billed figure.
 */

const { APIFY_ACTORS, isSettled, actorById } = require("../apify-actors.js");

const API = "https://api.apify.com/v2";

/* only this project's actors are listed, so unrelated runs on the same account (a test in the Apify
   console, another project) never show up as a daily-check cost */
const ACTORS = [...new Set(Object.values(APIFY_ACTORS).map(a => a.id))];

async function call(path, params) {
  const u = new URL(API + path);
  u.searchParams.set("token", process.env.APIFY_TOKEN);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(u.toString(), { signal: ctl.signal });
    const j = await r.json().catch(() => null);
    if (r.status !== 200 || !j || !j.data) {
      throw new Error("Apify answered HTTP " + r.status + ((j && j.error && j.error.message) ? ": " + j.error.message : ""));
    }
    return j.data;
  } finally { clearTimeout(timer); }
}

const usd = n => (typeof n === "number" && isFinite(n) ? Math.round(n * 1e6) / 1e6 : null);

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET." });

  if (!process.env.APIFY_TOKEN) return res.status(200).json({ ok: true, configured: false });

  /* run ids are Apify's own 17-character ids; anything else is ignored rather than passed on */
  const q = (req.query && req.query.runs) || new URL(req.url || "/", "http://x").searchParams.get("runs") || "";
  const runIds = [...new Set(String(q).split(",").map(s => s.trim()).filter(s => /^[A-Za-z0-9]{8,32}$/.test(s)))].slice(0, 12);

  try {
    const [limits, me] = await Promise.all([call("/users/me/limits"), call("/users/me").catch(() => null)]);
    const used = usd(((limits.current || {}).monthlyUsageUsd));
    const cap = usd(((limits.limits || {}).maxMonthlyUsageUsd));
    const cycle = limits.monthlyUsageCycle || {};

    /* Recent runs of this project's actors, newest first. The run list carries actId (an opaque id),
       so each actor name is resolved to its id once here. Best-effort: a failure leaves runs empty. */
    const byId = new Map();
    let runs = [];
    try {
      const acts = await Promise.all(ACTORS.map(a => call("/acts/" + a).then(d => [d.id, a]).catch(() => null)));
      for (const e of acts.filter(Boolean)) byId.set(e[0], e[1]);
      const list = await call("/actor-runs", { desc: 1, limit: 40 });
      runs = (list.items || []).filter(r => byId.has(r.actId)).slice(0, 20).map(r => ({
        actor: byId.get(r.actId), status: r.status,
        startedAt: r.startedAt || null, finishedAt: r.finishedAt || null,
        usd: usd(r.usageTotalUsd),
      }));
    } catch (e) { runs = []; }

    /* each named run's full record — only runs of this project's actors are answered for */
    const settle = await Promise.all(runIds.map(async id => {
      try {
        const r = await call("/actor-runs/" + id);
        const name = byId.get(r.actId) || null;
        const actor = name && actorById(name);
        if (!actor) return { runId: id, error: "not a run of this project's actors" };
        return { runId: id, actor: name, status: r.status, usd: usd(r.usageTotalUsd), settled: isSettled(actor, r) };
      } catch (e) { return { runId: id, error: String(e.message || e) }; }
    }));

    return res.status(200).json({
      ok: true, configured: true,
      plan: (me && me.plan && me.plan.id) || null,
      usedUsd: used, limitUsd: cap,
      remainingUsd: used != null && cap != null ? usd(Math.max(0, cap - used)) : null,
      cycleStart: cycle.startAt || null, cycleEnd: cycle.endAt || null,
      runs,
      ...(runIds.length ? { settle } : {}),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, configured: true, error: String(e.message || e) });
  }
};
