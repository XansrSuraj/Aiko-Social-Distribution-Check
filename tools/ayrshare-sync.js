/**
 * Ayrshare → /api/ingest
 *
 *   node tools/ayrshare-sync.js [--days 2] [--dry] [--dashboard http://localhost:3000]
 *
 * Reads what Ayrshare actually published and pushes it into the daily check.
 *
 * Why bother, when most of these platforms already have a collector? Because reading a platform is
 * always a reconstruction — a feed, a rendered page, captions matched by similarity — while the
 * publisher simply knows. Three channels gain outright:
 *
 *   facebook   stops being matched on captions (≈) and gets real instants, so a drop it received
 *              can no longer read as missing because its page would not render
 *   instagram  stops needing Chrome open and a logged-in session
 *   tiktok     goes from "nothing can read this" to readable
 *
 * Viber is NOT in this — Ayrshare does not support it (its History API covers bluesky, facebook,
 * gmb, instagram, linkedin, pinterest, reddit, snapchat, telegram, threads, tiktok, twitter,
 * youtube). Whatever posts to Viber has to push to /api/ingest itself; the shape is in the README.
 *
 * Needs AYRSHARE_API_KEY. Add AYRSHARE_PROFILE_KEY if the account uses multiple profiles, and
 * INGEST_KEY if the dashboard has one set.
 */
const path = require("path");

const API = "https://api.ayrshare.com/api/history";
const KEY = process.env.AYRSHARE_API_KEY || "";
const PROFILE = process.env.AYRSHARE_PROFILE_KEY || "";
const INGEST_KEY = process.env.INGEST_KEY || "";

const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : fallback;
};
const DAYS = Math.max(1, Number(arg("days", 2)) || 2);
const DASH = String(arg("dashboard", "http://localhost:3000")).replace(/\/+$/, "");
const DRY = process.argv.includes("--dry");

/* Ayrshare names a few platforms differently from the directory. Everything else matches. */
const PLATFORM_ALIAS = { twitter: "x", gmb: "gbp" };

/* The identifier a channel is known by on its own platform, taken from its URL — the same first
   path segment the rest of the app uses. This is what lets two Facebook Pages be told apart:
   Ayrshare reports one postUrl per network, and the Page it names is the Page it went to. */
function handleOf(url) {
  try {
    const p = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
    return (p.split("/")[0] || "").replace(/^@/, "").toLowerCase();
  } catch (e) { return ""; }
}

async function loadChannels() {
  const r = await fetch(DASH + "/api/data", { cache: "no-store" });
  const j = await r.json();
  if (!j.ok || !j.data) {
    throw new Error("Could not read the directory from " + DASH + "/api/data. " +
      "In local mode the directory lives in the browser — export it and pass it another way, " +
      "or connect Supabase.");
  }
  const out = [];
  for (const o of j.data.orgs || [])
    for (const s of o.socials || [])
      out.push({ id: s.id, platform: s.platform, url: s.url,
                 handle: (s.handle || "").replace(/^@/, "").toLowerCase() || handleOf(s.url),
                 org: o.name });
  return out;
}

async function fetchHistory() {
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400e3);
  const qs = new URLSearchParams({
    startDate: start.toISOString().replace(/\.\d+Z$/, "Z"),
    endDate: end.toISOString().replace(/\.\d+Z$/, "Z"),
    limit: "1000",
  });
  const headers = { Authorization: "Bearer " + KEY };
  if (PROFILE) headers["Profile-Key"] = PROFILE;

  const r = await fetch(API + "?" + qs, { headers });
  const body = await r.text();
  if (!r.ok) throw new Error(`Ayrshare history failed (HTTP ${r.status}): ${body.slice(0, 300)}`);
  let j; try { j = JSON.parse(body); } catch (e) { throw new Error("Ayrshare did not return JSON"); }
  return Array.isArray(j.history) ? j.history : Array.isArray(j) ? j : [];
}

/* One Ayrshare post fans out to several networks, so it becomes one post per channel. The instant
   is the post's own — scheduleDate when it was scheduled, created otherwise — never "now", or a
   backfill would stamp last week's posts as today's. */
function toChannelPosts(history, channels) {
  const byChannel = new Map();
  const unmatched = [];

  for (const h of history) {
    if (h.status && h.status !== "success") continue;
    const ts = h.scheduleDate || h.created;
    if (!ts || isNaN(new Date(ts).getTime())) continue;

    for (const pid of h.postIds || []) {
      if (pid.status && pid.status !== "success") continue;
      const platform = PLATFORM_ALIAS[pid.platform] || pid.platform;
      const url = pid.postUrl || "";
      const cands = channels.filter(c => c.platform === platform);
      /* one account on this network → unambiguous. Several → the postUrl names which. */
      const hit = cands.length === 1 ? cands[0]
        : cands.find(c => c.handle && url.toLowerCase().includes(c.handle));
      if (!hit) { unmatched.push({ platform, url: url.slice(0, 90) }); continue; }

      const list = byChannel.get(hit.id) || [];
      list.push({
        externalId: String(pid.id || h.id),
        ts: new Date(ts).toISOString(),
        kind: pid.isVideo ? "video" : "post",
        text: h.post || "",
        permalink: url,
      });
      byChannel.set(hit.id, list);
    }
  }
  return { byChannel, unmatched };
}

async function push(channelId, posts) {
  const headers = { "Content-Type": "application/json" };
  if (INGEST_KEY) headers["x-ingest-key"] = INGEST_KEY;
  const r = await fetch(DASH + "/api/ingest", {
    method: "POST", headers, body: JSON.stringify({ channelId, posts }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`ingest refused ${channelId}: ${j.error || r.status}`);
  return j;
}

(async () => {
  if (!KEY) {
    console.error("AYRSHARE_API_KEY is not set.\n" +
      "  PowerShell:  $env:AYRSHARE_API_KEY = \"…\"\n" +
      "  bash:        export AYRSHARE_API_KEY=…");
    process.exit(1);
  }
  const channels = await loadChannels();
  console.log(`directory: ${channels.length} channel(s) from ${DASH}`);

  const history = await fetchHistory();
  console.log(`ayrshare : ${history.length} post(s) in the last ${DAYS} day(s)\n`);

  const { byChannel, unmatched } = toChannelPosts(history, channels);
  if (!byChannel.size) console.log("  nothing matched a channel in the directory");

  for (const [channelId, posts] of byChannel) {
    const c = channels.find(x => x.id === channelId);
    const label = `${c.platform} · ${c.handle || c.id}`;
    if (DRY) { console.log(`  would push ${String(posts.length).padStart(3)} → ${label}`); continue; }
    const out = await push(channelId, posts);
    console.log(`  pushed ${String(out.added).padStart(3)} new (${out.total} held) → ${label}`);
  }

  if (unmatched.length) {
    /* named rather than silently dropped: an account published to but absent from the directory is
       a real gap, and the only symptom would otherwise be a channel that never fills in */
    const seen = new Set();
    console.log("\n  published but not in the directory:");
    for (const u of unmatched) {
      const k = u.platform + u.url;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`    ${u.platform.padEnd(10)} ${u.url}`);
    }
  }
  console.log(DRY ? "\ndry run — nothing was pushed" : "\ndone");
})().catch(e => { console.error("failed:", e.message); process.exit(1); });
