/* Everything the report page draws, worked out from the engine in one place — a straight port of the
   data half of the old dailyCheckModal() draw(). No markup here: components read this object. */

export function buildReport(E) {
  const o = E.SPORTSFC;
  const checks = E.checks;
  const view = E.regionSel();
  const chans = E.dcChannels(o, view === "all" ? undefined : view);
  const wo = E.windowOpt();
  const ropt = { tz: checks.tz, win: checks.win, maxPerPeriod: checks.maxPer || 4, ...wo };
  const rep = view === "all"
    ? E.mergeReports(E.REGIONS.map(([id, name]) => {
        const cs = E.dcChannels(o, id);
        return cs.length ? { region: id, name, rep: E.reconcile(cs, ropt) } : null;
      }))
    : E.reconcile(chans, ropt);
  const nameOf = id => (chans.find(c => c.id === id) || {}).name || id;
  const chanOf = id => chans.find(c => c.id === id) || {};

  /* ── sources: the free readers, and the social ones (free first, Apify as fallback) ── */
  const srvIds = chans.filter(c => E.EXT_PLATFORMS.indexOf(c.platform) === -1).map(c => c.id);
  const brwIds = chans.filter(c => E.EXT_PLATFORMS.indexOf(c.platform) !== -1).map(c => c.id);
  const platNames = ids => [...new Set(chans.filter(c => ids.indexOf(c.id) !== -1)
    .map(c => E.platform(c.platform).name))].join(" · ");
  const readOk = id => { const m = (checks.meta || {})[id]; return !(m && m.ok === false); };
  const hasData = id => readOk(id) && ((checks.posts[id] || []).length ||
    ((checks.captions || {})[id] || []).length ||
    Object.keys(checks.counts || {}).some(d => (checks.counts[d] || {})[id]));
  const gotFrom = ids => ids.filter(hasData).length;
  const silent = brwIds.filter(id => !hasData(id))
    .map(id => ({ id, name: nameOf(id), note: ((checks.meta || {})[id] || {}).note || "" }))
    .filter(x => x.note);

  const money = n => "$" + (n < 0.1 ? n.toFixed(4) : n.toFixed(2));
  const apifyNote = (() => {
    const bits = [];
    const srcOf = id => String(((checks.meta || {})[id] || {}).source || "");
    const nFree = brwIds.filter(id => /-free$/.test(srcOf(id))).length;
    const nApify = brwIds.filter(id => /-apify$|-reels$/.test(srcOf(id))).length;
    if (nFree || nApify) bits.push(`${nFree} free · ${nApify} via Apify`);
    const last = checks.apifyLast;
    if (last) bits.push(last.runs ? (last.settled === false ? `last press ≥ ${money(last.usd)} (settling)` : `last press ${money(last.usd)}`)
                                  : "last press $0");
    const ai = E.apifyInfo;
    if (ai && ai.ok && ai.configured && ai.remainingUsd != null) {
      bits.push(`${money(ai.remainingUsd)} of ${money(ai.limitUsd)} Apify credit left`);
      const per = checks.apifyCheckUsd;
      if (per > 0) bits.push(`≈ ${Math.floor(ai.remainingUsd / per)} more checks`);
    }
    return bits.join(" · ");
  })();

  /* ── post log: every post in the window; a textless content-matched post borrows its caption ── */
  const rowOf = id => rep.rows.find(r => r.id === id);
  const matchAt = (channelId, ts) => {
    const r = rowOf(channelId);
    if (!r || r.mode !== "content") return null;
    const i = rep.slots.findIndex(s => Math.abs(new Date(s.at) - new Date(ts)) <= rep.win * 60e3);
    const cell = i >= 0 ? r.cells[i] : null;
    return cell && cell.state === "okc" ? { post: cell.post, score: cell.score } : null;
  };
  const logPosts = [];
  for (const c of chans)
    for (const p of (checks.posts[c.id] || []))
      if (new Date(p.ts) >= new Date(rep.from) && new Date(p.ts) <= new Date(rep.to)) {
        const m = (p.text || "").trim() ? null : matchAt(c.id, p.ts);
        logPosts.push(m
          ? { ...p, channelId: c.id, text: m.post.text, thumb: p.thumb || m.post.thumb,
              permalink: p.permalink || m.post.permalink, viaCaption: true, score: m.score }
          : { ...p, channelId: c.id });
      }
  logPosts.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  return { o, checks, view, chans, wo, rep, nameOf, chanOf, srvIds, brwIds, platNames, gotFrom, hasData,
           silent, apifyNote, logPosts, pendingN: E.pendingBrowserRuns() };
}

/* ── shared helpers for the content views ── */
export const LANG_NAME = { vi: "Vietnamese", en: "English", pt: "Portuguese", th: "Thai", zh: "Chinese" };

/* Instagram's own page summary leads with 'N likes, N comments - handle on DATE: "' — the platform's
   wrapper, not the caption */
const IG_WRAP = /^\s*[\d.,]+[KkMm]?\s+likes?,\s*[\d.,]+[KkMm]?\s+comments?\s+-\s+[\w.]+\s+on\s+[^:]{3,40}:\s*["“]/;
export const capOf = p => {
  let t = String((p && p.text) || "");
  if (IG_WRAP.test(t)) t = t.replace(IG_WRAP, "").replace(/["”]\.?\s*$/, "");
  return t.replace(/https?:\/\/\S+/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};
export const tagsOf = p => (Array.isArray(p.hashtags) && p.hashtags.length ? p.hashtags
  : [...String(p.text || "").matchAll(/#([\p{L}\p{N}_]+)/gu)].map(m => m[1])).slice(0, 12);
export const linkOf = p => p.link || (String(p.text || "").match(/https?:\/\/(?!t\.co\/)[^\s)]+/) || [""])[0];
export const slotIxOf = (rep, p) => rep.slots.findIndex(s => s.posts.some(q => q.channelId === p.channelId && q.externalId === p.externalId));
export function borrowCap(rep, chanOf, p, c, si) {
  if (si < 0) return null;
  const q = rep.slots[si].posts.find(q => q.channelId !== p.channelId && capOf(q) && chanOf(q.channelId).lang === c.lang);
  return q ? { text: capOf(q), from: chanOf(q.channelId).name || q.channelId } : null;
}
