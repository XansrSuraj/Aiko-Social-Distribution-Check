import { useState } from "react";
import { ImageOff } from "lucide-react";

/* A thumbnail through this site's image proxy; one that fails (a signed link that expired) shows a
   quiet placeholder instead of a broken-image icon */
export function Thumb({ E, src, alt = "", fallback = null, ...rest }) {
  const [gone, setGone] = useState(false);
  if (!src || gone) return fallback;
  return <img src={E.thumbSrc(src)} alt={alt} loading="lazy" onError={() => setGone(true)} {...rest} />;
}

export default function Drops({ E, vm }) {
  const { rep, nameOf } = vm;
  if (!rep.slots.length) return <div className="card empty"><b>No drops in this window.</b></div>;
  return (
    <div className="drops">
      {rep.slots.map((s, si) => {
        /* every channel accounted for on every drop, from the same cells the matrix draws */
        const went = [], failed = [], unknown = [], wrongLang = [];
        let here = 0;
        for (const r of rep.rows) {
          const st = ((r.cells || [])[si] || {}).state;
          if (st === "na") continue;
          here++;
          if (st === "ok" || st === "okc" || st === "okh" || st === "asm") went.push(r.id);
          else if (st === "lang") wrongLang.push(r.id);
          else if (st === "miss") failed.push(r.id);
          else unknown.push(r.id);
        }
        const seen = new Map();
        for (const p of s.posts) { const d = E.detectLang(p.text); if (d.lang && !seen.has(d.lang)) seen.set(d.lang, p); }
        const caps = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        const th = (s.posts.find(p => p.thumb) || {}).thumb;
        const sent = went.length + wrongLang.length;
        return (
          <div key={si} className={`card drop${s.missing.length ? " gap" : ""}`}>
            <div className="drop-th">
              <Thumb E={E} src={th} fallback={<div className="pc-img" style={{ position: "absolute", inset: 0 }}><span className="ph"><ImageOff /></span></div>} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="drop-time">
                <b className="mono">{E.hhmmss(s.at, rep.tz)}</b>
                <span className="pill un">{s.kinds.join(", ") || "post"}</span>
                <span className={`pill ${failed.length ? "short" : unknown.length ? "sg" : "ok"}`}
                  title={`${sent} went out · ${failed.length} did not · ${unknown.length} could not be checked`}>
                  {sent}/{here} channels{s.regionName ? " · " + s.regionName : ""}</span>
                {(s.late || []).length > 0 && (
                  <span className="pill un" title={s.late.map(l => nameOf(l.id) + " " + E.fmtGap(l.mins) + " behind").join(" · ")}>{s.late.length} late</span>
                )}
              </div>
              <div className="drop-caps">
                {caps.length ? caps.map(([lg, p]) => {
                  const t = E.clean(p.text);
                  return <div key={lg} className="drop-cap"><span className="lang-tag">{lg}</span><span>{t.slice(0, 240)}{t.length > 240 ? "…" : ""}</span></div>;
                }) : <div className="drop-cap" style={{ color: "var(--muted)" }}>No caption text collected for this drop.</div>}
              </div>
              <div className="spread">
                {s.posts.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts)).map((p, i) => {
                  const l = (s.late || []).find(x => x.id === p.channelId);
                  return <span key={i} title={E.hhmmss(p.ts, rep.tz) + (l ? " — " + E.fmtGap(l.mins) + " behind the rest of this drop" : "")}>
                    {nameOf(p.channelId)} <b>{E.hhmm(p.ts, rep.tz)}</b>{l && <i>+{E.fmtGap(l.mins)}</i>}</span>;
                })}
                {(s.byContent || []).map(id => <span key={"c" + id} title="confirmed by caption, not by time">{nameOf(id)} <b>≈</b></span>)}
              </div>
              {failed.length > 0 && <div className="note-miss">Did not go out on {failed.map(nameOf).join(", ")}</div>}
              {wrongLang.length > 0 && <div className="note-warn">Went out in the wrong language on {wrongLang.map(nameOf).join(", ")}</div>}
              {unknown.length > 0 && <div className="note-unk">Could not be checked on {unknown.map(nameOf).join(", ")} — nothing is known either way, so none is counted as a miss.</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
