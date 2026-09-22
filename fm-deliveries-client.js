/**
 * Shared upstream client for the FM Deliveries feed (see docs: "FM Deliveries API — consumer
 * guide"). One CMS deployment per environment, each with its own host + key, kept server-side only
 * — the browser never sees either. Required by api/fm-deliveries.js and api/fm-deliveries-meta.js.
 *
 * GET-only on purpose: this is a read-only viewer, so there is no code path here that could ever
 * construct a PUT/POST/DELETE against the CMS.
 */
const ENVS = ["dev", "test", "prod"];

function configFor(env) {
  const key = String(env || "").toLowerCase().trim();
  if (!ENVS.includes(key)) return null;
  const suffix = key.toUpperCase();
  return {
    host: (process.env[`FM_DELIVERIES_API_HOST_${suffix}`] || "").replace(/\/+$/, ""),
    apiKey: process.env[`FM_DELIVERIES_API_KEY_${suffix}`] || "",
  };
}

function configuredEnvs() {
  return ENVS.filter(e => { const c = configFor(e); return !!(c.host && c.apiKey); });
}

/* path is "/api/fm-deliveries-feed" or "/api/fm-deliveries-feed/meta". query is a plain object of
   string values, forwarded to the upstream untouched — this never reinterprets or defaults a filter,
   so a 400 from a bad one reaches the caller exactly as the CMS worded it. */
async function upstreamGet(env, path, query) {
  const cfg = configFor(env);
  if (!cfg) {
    return { status: 400, body: { ok: false, error: `Unknown environment "${env}". Use dev, test, or prod.` } };
  }
  if (!cfg.host || !cfg.apiKey) {
    return {
      status: 503,
      body: {
        ok: false,
        error: `FM Deliveries is not configured for "${env}" on this deployment.`,
        missing: [!cfg.host && `FM_DELIVERIES_API_HOST_${env.toUpperCase()}`, !cfg.apiKey && `FM_DELIVERIES_API_KEY_${env.toUpperCase()}`].filter(Boolean),
      },
    };
  }

  const url = new URL(cfg.host + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, v);
  }

  let r;
  try {
    r = await fetch(url.toString(), { method: "GET", headers: { "x-api-key": cfg.apiKey } });
  } catch (err) {
    return { status: 502, body: { ok: false, error: `Could not reach the ${env} CMS: ${String((err && err.message) || err)}` } };
  }

  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = { ok: false, error: text || `Upstream returned HTTP ${r.status} with no body.` }; }
  return { status: r.status, body };
}

module.exports = { ENVS, configFor, configuredEnvs, upstreamGet };
