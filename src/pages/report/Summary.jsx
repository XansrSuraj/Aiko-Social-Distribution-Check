import { BrandIcon } from "../../app/core.jsx";
import { LANG_NAME } from "../../app/viewmodel.js";

/* What a cell's hover says — the reason behind the glyph, from the reader's own evidence */
function tipOf(E, c) {
  const d = E.CELL[c.state] || E.CELL.none;
  const base = c.state === "lang" && c.detected ? `caption looks ${c.detected.lang.toUpperCase()} — ${c.detected.why}`
    : c.state === "okc" ? (c.match && c.match.total ? `caption match: all ${c.match.total} words — the same reel went out`
                                                     : `${Math.round((c.score || 0) * 100)}% caption match — ${d.t}`)
    : c.state === "miss" && c.match && c.match.total
      ? `reel did NOT go out — closest caption matched ${c.match.matched}/${c.match.total} words` +
        (c.match.missing && c.match.missing.length ? ` · ${c.match.missing.length} do NOT match: ${c.match.missing.slice(0, 10).join(", ")}` : "")
    : c.state === "miss" && c.score != null ? `best caption match was only ${Math.round(c.score * 100)}%`
    : c.lateBy ? `posted, but ${E.fmtGap(c.lateBy)} behind the rest of this drop`
    : c.state === "ok" && c.extra ? `${c.extra + 1} posts in this drop` : d.t;
  const ask = !c.askable ? "" : c.state === "okh" ? " · click to mark it missing" : c.state === "miss" ? " · click to clear" : " · click to confirm it went out";
  return base + ask;
}

export default function Summary({ E, vm, toast }) {
  const { rep, checks, chanOf, nameOf } = vm;
  if (!rep.slots.length && !rep.rows.some(r => r.mode !== "none"))
    return <div className="card empty"><b>Nothing collected in this window yet.</b><br />Press Run everything above.</div>;

  const covTotal = rep.rows.filter(r => r.mode !== "none").length;
  const cols = rep.slots.length + 3;

  /* the cells a person answers: unanswered → went out → did not go out → unanswered */
  const toggle = (id, at) => E.update(c => {
    c.confirms = c.confirms || {}; c.confirms[id] = c.confirms[id] || {};
    const cur = c.confirms[id][at];
    if (cur === undefined) c.confirms[id][at] = true;
    else if (cur === true) c.confirms[id][at] = false;
    else delete c.confirms[id][at];
  });
  const confirmAll = r => {
    const own = rep.slots.filter(s => !s.region || s.region === r.region);
    E.update(c => { c.confirms = c.confirms || {}; c.confirms[r.id] = c.confirms[r.id] || {}; for (const s of own) c.confirms[r.id][s.at] = true; });
    toast(`${own.length} drop(s) confirmed on ${nameOf(r.id)}`, "check-check");
  };
  const clearAll = id => E.update(c => { delete (c.confirms || {})[id]; });

  const total = r => {
    const meta = checks.meta[r.id] || {};
    if (r.mode === "none" || r.status === "unknown") return <span className="pill un">{meta.unsupported ? "n/a" : "—"}</span>;
    if (r.expected === null) return <span className="pill un">{r.count}</span>;
    const cls = r.suggested ? "guess" : r.status === "ok" ? "ok" : r.status === "short" ? "short" : "sg";
    return <span className={`pill ${cls}`} title={r.suggested ? "read off the page — confirm it below" : undefined}>{r.count}/{r.expected}</span>;
  };
  const why = r => {
    const meta = checks.meta[r.id] || {};
    if (r.mode === "none") return meta.dead ? "link is dead" : meta.unsupported ? "not supported" : meta.note ? meta.note
      : r.platform === "facebook" && (checks.posts[r.id] || []).length ? "no captions to match on — its dates cannot prove absence"
      : meta.browserRequired ? "run the extension" : "not collected";
    if (r.status === "short" && meta.note) return meta.note;
    return r.suggested ? "suggested — confirm below" : "";
  };

  const has = f => rep.rows.some(r => r.cells.some(f));
  const manualRows = rep.rows.filter(r => r.mode !== "timeline");
  const day = E.contentDate(rep.to, checks.tz);
  const setCount = (id, raw) => {
    const v = String(raw).trim();
    E.update(c => {
      c.counts[day] = c.counts[day] || {};
      if (v === "") delete c.counts[day][id];
      else c.counts[day][id] = { n: Math.max(0, parseInt(v, 10) || 0), source: "manual" };
    });
  };

  return (
    <>
      <div className="card">
        <div className="mx-wrap">
          <table className="mx">
            <thead>
              <tr>
                <th className="stick left">Channel</th>
                {rep.slots.map((s, i) => {
                  const got = s.present.length, cov = s.cov != null ? s.cov : covTotal;
                  return (
                    <th key={i} title={E.fmtWhen(s.at, rep.tz) + (s.regionName ? " · " + s.regionName + " drop" : "")}>
                      <span className="t">{s.time}</span>
                      {rep.hours > 24 && <span className="cov" style={{ color: "var(--muted)" }}>{s.day.slice(5)}</span>}
                      {s.region && s.region !== "main" && <span className="rg">{s.region.toUpperCase()}</span>}
                      {cov ? <span className={`cov${got < cov ? " short" : ""}`} title={`${got} of ${cov} channel(s) got this drop`}>{got}/{cov}</span> : null}
                    </th>
                  );
                })}
                <th>Total</th>
                <th className="left">Why</th>
              </tr>
            </thead>
            <tbody>
              {rep.langs.map(lg => {
                const rows = rep.rows.filter(r => (r.lang || "—") === lg);
                return [
                  <tr key={"g" + lg} className="grp">
                    <td className="stick">{lg === "—" ? "No language set" : LANG_NAME[lg] || lg} · {rows.length}</td>
                    <td colSpan={cols - 1} />
                  </tr>,
                  ...rows.map(r => {
                    const askable = r.cells.some(x => x.askable);
                    const ch = chanOf(r.id);
                    return (
                      <tr key={r.id}>
                        <td className="stick"><span className="chn"><BrandIcon platform={r.platform || ch.platform} />{r.name}</span></td>
                        {r.cells.map((c, i) => {
                          const d = E.CELL[c.state] || E.CELL.none;
                          return (
                            <td key={i} className={`c${c.askable ? " ask" : ""}`} title={tipOf(E, c)}
                              onClick={c.askable ? () => toggle(r.id, c.at) : undefined}>
                              <span className={`cl ${d.cls}${c.lateBy ? " lt" : ""}`}>{d.g}{c.state === "ok" && c.extra ? <sup>+{c.extra}</sup> : null}</span>
                            </td>
                          );
                        })}
                        <td className="c">{total(r)}</td>
                        <td className="why">
                          {askable ? (
                            <div className="ask-row">
                              <button onClick={() => confirmAll(r)} title="mark every drop as delivered on this channel">
                                ✓ all {rep.slots.filter(s => !s.region || s.region === r.region).length}</button>
                              {r.cells.some(x => x.state === "okh" || x.state === "miss") && <button onClick={() => clearAll(r.id)}>clear</button>}
                              {ch.url && <a href={ch.url} target="_blank" rel="noopener noreferrer">open</a>}
                            </div>
                          ) : why(r)}
                        </td>
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
        </div>

        {/* phones: the same matrix as one card per channel, so nothing scrolls sideways — each card
            shows only its own region's drops, the times printed under each mark */}
        <div className="mxm">
          <div className="mxm-drops">
            {rep.slots.map((s, i) => {
              const got = s.present.length, cov = s.cov != null ? s.cov : covTotal;
              return (
                <span key={i} className="mxm-drop" title={E.fmtWhen(s.at, rep.tz)}>
                  <b>{s.time}</b>
                  {s.region && s.region !== "main" && <span className="rg">{s.region.toUpperCase()}</span>}
                  {cov ? <span className={`cov${got < cov ? " short" : ""}`}>{got}/{cov}</span> : null}
                </span>
              );
            })}
          </div>
          {rep.langs.map(lg => {
            const rows = rep.rows.filter(r => (r.lang || "—") === lg);
            return (
              <div key={lg}>
                <div className="mxm-grp">{lg === "—" ? "No language set" : LANG_NAME[lg] || lg} · {rows.length}</div>
                {rows.map(r => {
                  const askable = r.cells.some(x => x.askable);
                  const ch = chanOf(r.id);
                  const w = askable ? "" : why(r);
                  return (
                    <div key={r.id} className="mxm-row">
                      <div className="mxm-h">
                        <span className="chn"><BrandIcon platform={r.platform || ch.platform} />{r.name}</span>
                        {total(r)}
                      </div>
                      <div className="mxm-cells">
                        {r.cells.map((c, i) => {
                          if (c.state === "na") return null;
                          const d = E.CELL[c.state] || E.CELL.none;
                          const Tag = c.askable ? "button" : "span";
                          return (
                            <Tag key={i} className={`mxm-cell${c.askable ? " ask" : ""}`} title={tipOf(E, c)}
                              onClick={c.askable ? () => toggle(r.id, c.at) : undefined}>
                              <span className={`cl ${d.cls}${c.lateBy ? " lt" : ""}`}>{d.g}{c.state === "ok" && c.extra ? <sup>+{c.extra}</sup> : null}</span>
                              <span className="mxm-t">{(rep.slots[i] || {}).time}</span>
                            </Tag>
                          );
                        })}
                      </div>
                      {askable ? (
                        <div className="ask-row" style={{ marginTop: 10 }}>
                          <button onClick={() => confirmAll(r)}>✓ all {rep.slots.filter(s => !s.region || s.region === r.region).length}</button>
                          {r.cells.some(x => x.state === "okh" || x.state === "miss") && <button onClick={() => clearAll(r.id)}>clear</button>}
                          {ch.url && <a href={ch.url} target="_blank" rel="noopener noreferrer">open</a>}
                        </div>
                      ) : w ? <div className="mxm-why">{w}</div> : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="legend">
          <span><span className="cl ok">✓</span>posted</span>
          {rep.slots.some(s => (s.late || []).length) && <span><span className="cl ok lt">✓</span>posted, but behind the rest</span>}
          <span><span className="cl okc">≈</span>same content, matched by caption</span>
          {has(x => x.askable) && <span><span className="cl okh">✓</span>confirmed by hand — click these cells</span>}
          <span><span className="cl miss">✗</span>missing</span>
          <span><span className="cl lang">⚠</span>wrong language</span>
          {rep.regions && <span><span className="cl na">–</span>another region's drop</span>}
          <span><span className="cl none">·</span>no data</span>
        </div>
      </div>

      {manualRows.length > 0 && (
        <div className="counts">
          <h3>Counts by hand</h3>
          <div className="card">
            {manualRows.map(r => {
              const meta = checks.meta[r.id] || {};
              const val = r.mode === "count" ? String(r.count) : "";
              return (
                <div className="counts-row" key={r.id + ":" + val}>
                  <span className="chn" style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600 }}>
                    <BrandIcon platform={r.platform} style={{ width: 15, height: 15, color: "var(--muted)" }} />{r.name}</span>
                  <input type="number" min="0" inputMode="numeric" placeholder="–" defaultValue={val}
                    className={r.suggested ? "guess" : ""} disabled={!!meta.unsupported} aria-label={"Posts in window on " + r.name}
                    title={r.suggested ? "read off the page — this is a guess until you confirm it" : undefined}
                    onBlur={e => { if (e.target.value !== val) setCount(r.id, e.target.value); }}
                    onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                  <span className="note">{r.suggested ? (meta.note || "read off the page — confirm it")
                    : meta.unsupported ? "nothing can read this one" : meta.note || ""}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
