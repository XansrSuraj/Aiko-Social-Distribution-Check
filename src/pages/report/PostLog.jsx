import { ArrowUpRight } from "lucide-react";

/* every post, exact time, everything the platform gave — a table on a desk, cards on a phone */
export default function PostLog({ E, vm }) {
  const { rep, logPosts, chanOf } = vm;
  if (!logPosts.length) return <div className="card empty"><b>No timestamped posts in this window.</b></div>;
  return (
    <>
      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="log">
            <thead><tr>
              <th>Time</th><th>Channel</th><th>Lang</th><th>Type</th>
              <th style={{ textAlign: "right" }}>Views</th><th style={{ textAlign: "right" }}>Likes</th>
              <th style={{ textAlign: "right" }}>Comm.</th><th style={{ textAlign: "right" }}>Length</th><th>Caption</th><th />
            </tr></thead>
            <tbody>
              {logPosts.map((p, i) => {
                const c = chanOf(p.channelId), d = E.detectLang(p.text);
                const bad = c.lang && d.lang && d.lang !== c.lang;
                const t = E.clean(p.text);
                return (
                  <tr key={i} className={bad ? "warnrow" : undefined}>
                    <td className="mono" data-l="">{E.hhmmss(p.ts, rep.tz)}</td>
                    <td style={{ fontWeight: 600 }}>{c.name || p.channelId}</td>
                    <td data-l="lang"><span className={`tg${bad ? " warn" : ""}`} title={d.why}>{d.lang || "?"}</span></td>
                    <td data-l="type">{p.kind || "—"}</td>
                    <td className="num" data-l="views">{E.num2(p.views)}</td>
                    <td className="num" data-l="likes">{E.num2(p.likes != null ? p.likes : p.reactions)}</td>
                    <td className="num" data-l="comments">{E.num2(p.comments)}</td>
                    <td className="num" data-l="length">{E.dur(p.duration)}</td>
                    <td className="cap" title={t}>
                      {p.viaCaption && <span className="tg ok" title="paired with the caption that matched this drop">≈{Math.round((p.score || 0) * 100)}% </span>}{" "}
                      {t.slice(0, 90)}{t.length > 90 ? "…" : ""}</td>
                    <td className="wide">{p.permalink && <a href={p.permalink} target="_blank" rel="noopener noreferrer" title="open the post"
                      style={{ color: "var(--red)", display: "inline-flex" }}><ArrowUpRight style={{ width: 17, height: 17 }} /></a>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="foot-note">{logPosts.length} post(s) with timestamps. The Content tab shows each one in full — picture, whole caption, hashtags and every counter.</div>
    </>
  );
}
