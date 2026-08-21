/**
 * POST /api/check  { urls: [ "https://…", … ] }
 *   -> [ { url, ok, verified, status, ms, note } ]
 *
 * Runs server-side because the browser cannot check other domains (CORS).
 * HEAD first (cheap); some servers reject HEAD, so fall back to GET.
 *
 * Social links need more than an HTTP status. Instagram answers 200 with the same ~610 KB
 * JavaScript shell whether the profile is live, dead or never existed — so a plain status
 * check reports a broken channel as healthy. Facebook does the same behind its login wall.
 * Each platform therefore gets a verifier that asks a question the platform answers honestly:
 *
 *   instagram — the public profile endpoint: 200 with JSON = live, 404 = no such profile
 *   telegram  — t.me/s/<channel>: post markup present = live and public
 *   youtube   — the channel page carries "externalId":"UC…" only for a real channel
 *   x         — no honest signal exists: a dead handle serves the same 200 client shell as a
 *               live one, so reported as reachable-but-unverified, same as Facebook below
 *   viber     — the invite page names the community in og:title; a broken invite code falls back
 *               to a generic "Community Landing Page", which is a real 404 in disguise
 *   facebook  — no honest signal exists; reported as reachable-but-unverified
 *   tiktok    — refuses server requests outright; same treatment
 *
 * `verified` distinguishes the three real outcomes, which `ok` alone cannot express:
 *   ok && verified   the target genuinely exists
 *   ok && !verified  the URL resolves but the platform will not confirm the target
 *   !ok              broken — including a 404 from a verifier, which is a real failure
 */
const LIMIT = 40;
const TIMEOUT = 9000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IG_APP_ID = "936619743392459";

async function send(url, method, extraHeaders) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      redirect: "follow",
      signal: ctl.signal,
      headers: Object.assign({ "User-Agent": UA, Accept: "*/*" }, extraHeaders || {}),
    });
    return { status: r.status, ms: Date.now() - t0, res: r };
  } finally {
    clearTimeout(timer);
  }
}
const probe = (url, method) => send(url, method);

/* ═══════════════════ platform verifiers ═══════════════════ */
/* Each returns { ok, verified, status, ms, note }, or null to fall through to the plain probe. */

function pathParts(url) {
  try { return new URL(url).pathname.replace(/^\/+|\/+$/g, "").split("/"); }
  catch (e) { return []; }
}

async function verifyInstagram(url) {
  const user = (pathParts(url)[0] || "").replace(/^@/, "");
  if (!user || ["p", "reel", "reels", "stories", "explore", "tv"].indexOf(user) !== -1) return null;
  const { status, ms, res } = await send(
    "https://www.instagram.com/api/v1/users/web_profile_info/?username=" + encodeURIComponent(user),
    "GET", { "X-IG-App-ID": IG_APP_ID, Accept: "application/json" }
  );
  if (status === 404) {
    return { ok: false, verified: true, status, ms, note: "No Instagram profile with that username" };
  }
  if (status === 200) {
    const body = await res.text().catch(() => "");
    if (/"username"\s*:/.test(body)) return { ok: true, verified: true, status, ms, note: "" };
  }
  /* 400 / 429 here means Instagram is rate-limiting this server, not that the link is bad */
  return { ok: true, verified: false, status, ms,
           note: "Instagram would not confirm this one (rate-limited) — open it to be sure" };
}

async function verifyTelegram(url) {
  const p = pathParts(url);
  const name = (p[0] === "s" ? p[1] : p[0]) || "";
  if (!name || /^(joinchat|\+)/.test(name)) return null;
  const { status, ms, res } = await send("https://t.me/s/" + encodeURIComponent(name), "GET");
  if (status !== 200) return { ok: false, verified: true, status, ms, note: "t.me returned HTTP " + status };
  const body = await res.text().catch(() => "");
  if (/data-post="/.test(body)) return { ok: true, verified: true, status, ms, note: "" };
  return { ok: true, verified: false, status, ms,
           note: "Channel exists but has no public preview (private, or nothing posted yet)" };
}

/* Viber does answer honestly, which is worth taking: the invite page carries the community's real
   name in og:title, and an invite code that is wrong by a single character falls back to the
   generic "Community Landing Page on Viber". Measured on a live link and three broken ones. */
const VIBER_GENERIC = /^community landing page\b/i;
async function verifyViber(url) {
  const { status, ms, res } = await send(url, "GET");
  if (status !== 200) return { ok: false, verified: true, status, ms, note: "Viber returned HTTP " + status };
  const body = await res.text().catch(() => "");
  const title = (body.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) || [])[1] || "";
  if (!title) {
    return { ok: true, verified: false, status, ms,
             note: "Viber served no community details — open it to be sure" };
  }
  if (VIBER_GENERIC.test(title.replace(/\s+on Viber$/i, ""))) {
    return { ok: false, verified: true, status, ms,
             note: "Viber does not recognise this invite — the community may have been deleted" };
  }
  return { ok: true, verified: true, status, ms, note: "" };
}

async function verifyYouTube(url) {
  const p = pathParts(url);
  const first = p[0] || "";
  if (!(first === "channel" || first === "c" || first === "user" || first.startsWith("@"))) return null;
  const { status, ms, res } = await send(url, "GET");
  if (status === 404) return { ok: false, verified: true, status, ms, note: "No such YouTube channel" };
  if (status !== 200) return { ok: true, verified: false, status, ms, note: "HTTP " + status };
  const body = await res.text().catch(() => "");
  if (/"externalId"\s*:\s*"UC[\w-]{20,}"/.test(body)) {
    return { ok: true, verified: true, status, ms, note: "" };
  }
  return { ok: true, verified: false, status, ms, note: "Page loaded but carried no channel id" };
}

const NO_HONEST_SIGNAL = {
  facebook: "Facebook serves the same page whether or not this exists — open it to be sure",
  tiktok: "TikTok refuses server-side checks — open it to be sure",
  /* Confirmed directly: a handle that has never existed answers HTTP 200 with the same
     client-rendered shell x.com serves everyone before the client-side app decides what to show. */
  x: "X serves the same page whether or not this exists — open it to be sure",
};

function hostKind(url) {
  let h = "";
  try { h = new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; }
  if (/(^|\.)instagram\.com$/.test(h)) return "instagram";
  if (/^(t\.me|telegram\.me)$/.test(h)) return "telegram";
  if (/(^|\.)youtube\.com$/.test(h) || h === "youtu.be") return "youtube";
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(h)) return "facebook";
  if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
  if (/(^|\.)(x\.com|twitter\.com)$/.test(h)) return "x";
  if (/(^|\.)viber\.com$/.test(h)) return "viber";
  return "";
}

/* ═══════════════════ main check ═══════════════════ */

async function check(url) {
  const t0 = Date.now();
  const kind = hostKind(url);

  /* Platforms that never answer honestly. Don't probe them at all: whatever they return says
     nothing about the link. Facebook 400s at a server it dislikes and TikTok burns the whole
     timeout before refusing, and neither outcome means the page is dead — reporting red there
     would be as wrong as the old false green. Unverified is the truthful answer, and skipping
     the request also takes ~11s off a full check. */
  if (NO_HONEST_SIGNAL[kind]) {
    return { url, ok: true, verified: false, status: 0, ms: 0, note: NO_HONEST_SIGNAL[kind] };
  }

  const verifier = { instagram: verifyInstagram, telegram: verifyTelegram,
                     youtube: verifyYouTube, viber: verifyViber }[kind];
  if (verifier) {
    try {
      const v = await verifier(url);
      if (v) return { url, ok: v.ok, verified: v.verified, status: v.status, ms: v.ms, note: v.note };
    } catch (err) { /* fall through to the plain probe */ }
  }

  /* ordinary websites: the HTTP status is the honest answer */
  try {
    let r = await probe(url, "HEAD");
    // plenty of servers answer HEAD with 403/404/405 even when the page is fine
    if (r.status === 403 || r.status === 404 || r.status === 405 || r.status === 501) {
      try { r = await probe(url, "GET"); } catch (e) { /* keep the HEAD result */ }
    }
    const ok = r.status >= 200 && r.status < 400;
    return {
      url, ok, verified: ok, status: r.status, ms: r.ms,
      note: ok ? "" : (r.status === 403 ? "Blocked by the site (may still be live)" : "HTTP " + r.status),
    };
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || String(err).includes("aborted"));
    return {
      url, ok: false, verified: false, status: 0, ms: Date.now() - t0,
      note: aborted ? "Timed out after 9s" : "Could not connect",
    };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }

  const urls = (body && Array.isArray(body.urls) ? body.urls : [])
    .map(u => String(u || "").trim())
    .filter(u => /^https?:\/\//i.test(u))
    .slice(0, LIMIT);

  if (!urls.length) return res.status(400).json({ ok: false, error: "Send { urls: [...] } with http(s) URLs." });

  const results = await Promise.all(urls.map(check));
  return res.status(200).json({ ok: true, checkedAt: new Date().toISOString(), results });
};
