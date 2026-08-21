/**
 * Popup: pull the channel list from the dashboard, run the collection, hand the result back.
 *
 * The channel list is read from the dashboard's own public GET /api/data, so the extension has
 * no separate copy to keep in sync — add a Facebook Page in the app and it shows up here.
 */

const $ = id => document.getElementById(id);
const msg = (t, err) => { $("msg").textContent = t || ""; $("msg").className = "msg" + (err ? " err" : ""); };

let channels = [];
let orgs = [];
let lastRun = null;

/* ── remember the dashboard URL between opens ───────────────────────────── */
chrome.storage.local.get(["dashboardUrl", "lastRun"]).then(s => {
  $("url").value = s.dashboardUrl || "http://localhost:3000";
  if (s.lastRun) { lastRun = s.lastRun; renderResults(s.lastRun.results, true); }
});

const base = () => $("url").value.trim().replace(/\/+$/, "");

/* Facebook and Instagram both keep the useful identifier in the first path segment. */
function usernameOf(url, handle) {
  let p = "";
  try { p = new URL(url).pathname.replace(/^\/+|\/+$/g, ""); } catch (e) {}
  const first = (p.split("/")[0] || "").replace(/^@/, "");
  if (first && !/^(profile\.php|pages|pg|p|reel|reels)$/.test(first)) return first;
  return String(handle || "").replace(/^@/, "").trim();
}

/* ── load channels ──────────────────────────────────────────────────────── */
$("load").onclick = async () => {
  const url = base();
  if (!url) return msg("Enter the dashboard URL first.", true);
  chrome.storage.local.set({ dashboardUrl: url });
  msg("Loading…");
  try {
    let data = null;
    try {
      const r = await fetch(url + "/api/data", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) data = j.data;
    } catch (e) { /* offline or no server — the tab fallback below still works */ }

    /* No database configured (or no server at all) means the directory lives in the dashboard
       tab's own storage, so read it from there instead of giving up. */
    if (!data) {
      msg("No data from the server — reading the open dashboard tab…");
      const patterns = [new URL(url).origin + "/*"];
      const res = await chrome.runtime.sendMessage({ type: "readLocalDirectory", dashboardPatterns: patterns });
      if (!res || !res.ok) throw new Error((res && res.error) || "Could not read the directory.");
      data = res.data;
    }

    /* Only ever collect one organization. Sweeping the whole directory opened tabs for channels
       from unrelated orgs and mixed their posts into the report — the earlier version pulled in
       Matchpulse pages while SportsFC was the one being checked. */
    orgs = (data.orgs || []).filter(o => (o.socials || [])
      .some(s => s.platform === "facebook" || s.platform === "instagram"));
    if (!orgs.length) return msg("No Facebook or Instagram channels in that directory.", true);

    /* default to whatever the dashboard tab currently has open — #/<org-id> */
    const current = await openOrgId(url);
    const pick = orgs.find(o => o.id === current) || orgs[0];
    renderOrgs(pick.id);
    selectOrg(pick.id);
  } catch (e) {
    msg("Could not load: " + ((e && e.message) || e), true);
  }
};

/* which organization the dashboard tab is looking at, from its #/<org-id> hash */
async function openOrgId(base) {
  try {
    const tabs = await chrome.tabs.query({ url: new URL(base).origin + "/*" });
    for (const t of tabs) {
      const m = (t.url || "").match(/#\/([\w-]+)/);
      if (m) return m[1];
    }
  } catch (e) {}
  return null;
}

function renderOrgs(selectedId) {
  $("orgWrap").style.display = orgs.length > 1 ? "block" : "none";
  $("org").innerHTML = orgs.map(o => {
    const n = (o.socials || []).filter(s => s.platform === "facebook" || s.platform === "instagram").length;
    return `<option value="${esc(o.id)}"${o.id === selectedId ? " selected" : ""}>${esc(o.name)} — ${n} channel(s)</option>`;
  }).join("");
  $("org").onchange = () => selectOrg($("org").value);
}

function selectOrg(orgId) {
  const org = orgs.find(o => o.id === orgId);
  if (!org) return;
  channels = [];
  for (const s of org.socials || []) {
    if (s.platform !== "facebook" && s.platform !== "instagram") continue;
    const username = usernameOf(s.url, s.handle);
    if (!username) continue;
    channels.push({ id: s.id, platform: s.platform, url: s.url, username, org: org.name });
  }
  $("run").disabled = !channels.length;
  $("out").innerHTML = `<div class="list">${channels.map(c => `
    <div class="it"><b>${esc(c.platform)} · ${esc(c.username)}</b></div>`).join("")}</div>`;
  $("push").style.display = "none";
  msg(channels.length
    ? `${esc(org.name)}: ${channels.filter(c => c.platform === "instagram").length} Instagram, ` +
      `${channels.filter(c => c.platform === "facebook").length} Facebook.`
    : `${esc(org.name)} has no Facebook or Instagram channels.`);
}

/* ── run ────────────────────────────────────────────────────────────────── */
$("run").onclick = async () => {
  $("run").disabled = true; $("load").disabled = true;
  msg("Starting…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "collect", channels });
    if (!res || !res.ok) throw new Error((res && res.error) || "collection failed");
    lastRun = { collectedAt: res.collectedAt, results: res.results };
    renderResults(res.results, false);
    const good = res.results.filter(r => r.ok).length;
    msg(`Done — ${good}/${res.results.length} collected.`);
  } catch (e) {
    msg("Failed: " + ((e && e.message) || e), true);
  } finally {
    $("run").disabled = false; $("load").disabled = false;
  }
};

chrome.runtime.onMessage.addListener(m => { if (m && m.type === "progress") msg(m.text); });

function renderResults(results, stale) {
  $("out").innerHTML = `<div class="list">${results.map(r => {
    /* Read articleCount, which no longer exists — Facebook results carry posts and captions now,
       so every Facebook row showed "0 suggested" however well the run went. */
    const posts = (r.posts || []).length;
    const caps = (r.captions || []).length;
    const pill = !r.ok
      ? `<span class="pill no">${r.dead ? "no such account" : "failed"}</span>`
      : r.suggested && r.todayCount != null
        ? `<span class="pill sg">${r.todayCount} suggested</span>`
      : posts || caps
        ? `<span class="pill ok">${posts ? posts + " post" + (posts === 1 ? "" : "s") : ""}` +
          `${posts && caps ? " · " : ""}${caps ? caps + " caption" + (caps === 1 ? "" : "s") : ""}</span>`
        : `<span class="pill sg">nothing read</span>`;
    return `<div class="it"><b>${esc(r.platform)} · ${esc(r.username || r.channelId)}</b>${pill}</div>` +
           (r.note ? `<div class="sub">${esc(r.note)}</div>` : "");
  }).join("")}</div>`;
  $("push").style.display = "block";
  $("push").textContent = stale ? "Send last run to dashboard" : "Send to dashboard";
}

/* ── hand off ───────────────────────────────────────────────────────────── */
$("push").onclick = async () => {
  if (!lastRun) return msg("Nothing to send yet.", true);
  const url = base();
  let patterns;
  try {
    const u = new URL(url);
    patterns = [u.origin + "/*"];
  } catch (e) { return msg("The dashboard URL is not valid.", true); }

  msg("Sending…");
  const res = await chrome.runtime.sendMessage({ type: "push", run: lastRun, dashboardPatterns: patterns });
  if (!res || !res.ok) return msg((res && res.error) || "Could not send.", true);
  msg("Sent — the dashboard picked it up.");
};

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
