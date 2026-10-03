/* The plain-text report Copy puts on the clipboard — ported from the old dailyCheckModal(). */
export function reportText(E, vm) {
  const { o, rep, wo, checks, srvIds, brwIds, gotFrom, logPosts, nameOf, chanOf, pendingN } = vm;
  const nn = v => (v === null || v === undefined || v === "" ? "—" : v);
  const L = [`${o.name} — daily check`,
    wo.mode === "day"
      ? `${wo.date}  ${E.hhmm(rep.from, rep.tz)}–${E.hhmm(rep.to, rep.tz)}  (${E.tzLabel(rep.tz)})`
      : `${E.fmtWhen(rep.from, rep.tz)} → ${E.fmtWhen(rep.to, rep.tz)}  (${E.tzLabel(rep.tz)})`,
    `expected ${rep.expected === null ? "— nothing measured"
      : rep.regions ? rep.regions.map(g => g.name + " " + (g.expected === null ? "—" : g.expected)).join(", ") + " post(s) per channel"
      : rep.expected + " post(s) per channel"}`, "",
    "SOURCES",
    `  free readers   ${gotFrom(srvIds)}/${srvIds.length} channel(s)` +
      (checks.lastRun ? `  last collected ${new Date(checks.lastRun).toLocaleString()}` : "  never collected"),
    `  social         ${gotFrom(brwIds)}/${brwIds.length} channel(s)  ` +
      (E.extReady ? "extension standing by" + (E.extVersion ? ` v${E.extVersion}` : "") : "extension not detected") +
      (pendingN ? `  ${pendingN} run(s) waiting to be merged` : ""),
    ""];

  L.push(rep.alerts.length ? `PROBLEMS (${rep.alerts.length})` : "PROBLEMS — none");
  for (const a of rep.alerts) L.push(`  [${a.kind}] ${a.name} — ${a.text}`);

  L.push("", "COUNTS");
  for (const lg of rep.langs) {
    L.push(`  [${lg === "—" ? "no language" : lg}]`);
    for (const r of rep.rows.filter(x => (x.lang || "—") === lg)) {
      const meta = checks.meta[r.id] || {};
      const v = r.mode === "none" ? (meta.unsupported ? "not supported" : meta.dead ? "LINK DEAD" : "no data")
        : r.expected === null ? `${r.count} (no target)` : `${r.count}/${r.expected}`;
      L.push(`    ${r.status === "ok" ? "ok   " : r.status === "short" ? "SHORT" : r.status === "over" ? "OVER " :
                    r.status === "seen" ? "seen " : r.status === "review" ? "CHECK" : "  -  "} ${r.name} — ${v}` +
        (r.missedAt.length ? `  (nothing at ${r.missedAt.join(", ")})` : "") + (r.suggested ? " [suggested]" : ""));
      if (meta.note) L.push(`            how: ${meta.note}`);
      else if (r.mode === "none" && !meta.at) L.push(`            how: never attempted`);
    }
  }

  L.push("", "EVERY POST, EXACT TIME");
  for (const p of logPosts) {
    const c = chanOf(p.channelId), d = E.detectLang(p.text);
    const bad = c.lang && d.lang && d.lang !== c.lang;
    L.push(`  ${E.hhmmss(p.ts, rep.tz)}  ${(c.name || "").padEnd(26)} ${(d.lang || "?").padEnd(3)}` +
      `${bad ? " WRONG-LANG" : "          "} ${(p.kind || "").padEnd(8)}` +
      ` views=${String(nn(p.views)).padStart(6)} likes=${String(nn(p.likes)).padStart(5)}` +
      ` len=${String(nn(p.duration)).padStart(4)}s`);
    const t = E.clean(p.text);
    if (t) L.push(`            "${t.slice(0, 100)}${t.length > 100 ? "…" : ""}"`);
    if (p.permalink) L.push(`            ${p.permalink}`);
  }

  L.push("", "DROPS");
  for (const s of rep.slots) {
    L.push(`  ${E.hhmmss(s.at, rep.tz)}  ${s.present.length} channel(s)  ${s.kinds.join(",")}` +
      (s.regionName ? `  [${s.regionName}]` : "") +
      (s.missing.length ? `  MISSING: ${s.missing.map(nameOf).join(", ")}` : "") +
      ((s.late || []).length ? `  LATE: ${s.late.map(l => `${nameOf(l.id)} +${E.fmtGap(l.mins)}`).join(", ")}` : ""));
    for (const p of s.posts.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts))) {
      const l = (s.late || []).find(x => x.id === p.channelId);
      L.push(`        ${E.hhmmss(p.ts, rep.tz)}  ${nameOf(p.channelId)}` + (l ? `  (+${E.fmtGap(l.mins)} behind)` : ""));
    }
  }
  return L.join("\n");
}
