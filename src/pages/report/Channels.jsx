import { ArrowUpRight } from "lucide-react";
import { BrandIcon } from "../../app/core.jsx";
import { Thumb } from "./Drops.jsx";

export default function Channels({ E, vm }) {
  const { rep, checks, logPosts } = vm;
  return (
    <div className="chans">
      {rep.rows.map(r => {
        const meta = checks.meta[r.id] || {};
        /* a caption-matched channel has no usable timestamps: list the drops it accounted for instead,
           borrowing the drop's artwork when its own was not read — and saying so */
        const mine = r.mode === "content"
          ? r.cells.map((x, i) => {
              if (x.state !== "okc" || !x.post) return null;
              const slot = rep.slots[i];
              const own = x.post.thumb || "";
              const shared = !own && slot ? (slot.posts.find(p => p.thumb) || {}).thumb : "";
              return { ...x.post, channelId: r.id, ts: slot ? slot.at : null, slotTime: slot ? slot.time : "", score: x.score,
                       kind: x.post.kind || "post", thumb: own || shared || "", borrowedThumb: !own && !!shared };
            }).filter(Boolean)
          : logPosts.filter(p => p.channelId === r.id);
        const sum = f => mine.reduce((n, p) => (typeof p[f] === "number" ? n + p[f] : n), 0);
        const stat = (v, label) => v == null || v === "" ? null : <span>{typeof v === "number" ? E.compact(v) : v} {label}</span>;
        return (
          <div key={r.id} className="card chc">
            <div className="chc-h">
              <BrandIcon platform={r.platform} style={{ width: 17, height: 17 }} />
              <b>{r.name}</b>
              <span className="lang-tag">{r.lang || "—"}</span>
              {r.mode === "none" ? <span className="pill un">{meta.unsupported ? "not supported" : "no data"}</span>
                : <span className={`pill ${r.status === "ok" ? "ok" : r.status === "short" ? "short" : "sg"}`}>{r.count}{r.expected === null ? "" : "/" + r.expected}</span>}
              {r.suggested && <span className="pill sg">suggested</span>}
              <span className="sp" />
              {mine.some(p => typeof p.views === "number") && <span className="sn">{E.compact(sum("views"))} views</span>}
              {mine.some(p => p.likes != null) && <span className="sn">{E.compact(sum("likes"))} likes</span>}
            </div>
            {r.missedAt.length > 0 && <div className="note-miss">Nothing at {r.missedAt.join(", ")}</div>}
            {meta.note && <div className="chc-note">{meta.note}</div>}
            {r.mode === "content" && r.cells.map((x, i) => x.state === "miss" && rep.slots[i]
              ? <div key={i} className="note-miss">Reel did not go out for the {rep.slots[i].time} drop — closest caption matched{" "}
                  {x.match ? x.match.matched + "/" + x.match.total : Math.round((x.score || 0) * 100) + "%"} words
                  {x.match && x.match.missing && x.match.missing.length
                    ? " · " + x.match.missing.length + " do not match: " + x.match.missing.slice(0, 15).join(", ") +
                      (x.match.missing.length > 15 ? " (+" + (x.match.missing.length - 15) + " more)" : "") : ""}</div>
              : x.state === "okc" && rep.slots[i] && x.match
                ? <div key={i} className="chc-note" style={{ color: "var(--ok)" }}>✓ {rep.slots[i].time} drop — caption matched all {x.match.total} words</div>
                : null)}
            {mine.length > 0 && (
              <div className="plist">
                {mine.map((p, i) => {
                  const d = E.detectLang(p.text), bad = r.lang && d.lang && d.lang !== r.lang;
                  const t = E.clean(p.text);
                  return (
                    <div key={i} className="pli" style={bad ? { borderColor: "var(--warn-line)" } : undefined}>
                      <Thumb E={E} src={p.thumb} fallback={<span />}
                        title={p.borrowedThumb ? "this drop's artwork, taken from another channel — not read from this one" : "read from this channel's own post"} />
                      <div style={{ minWidth: 0 }}>
                        <div className="pli-m">
                          <b className="mono">{p.ts ? E.hhmmss(p.ts, rep.tz) : (p.timeLabel || p.slotTime || "—")}</b>
                          {p.borrowedThumb && <span className="tg">borrowed art</span>}
                          <span className="tg">{p.kind || "post"}</span>
                          <span className={`tg${bad ? " warn" : ""}`}>{d.lang || "?"}</span>
                          {p.score != null && <span className="tg ok" title="caption match">≈{Math.round(p.score * 100)}%</span>}
                          {stat(p.views, "views")}{stat(p.likes, "likes")}{stat(p.reactions, "reactions")}
                          {stat(p.comments, "comments")}{stat(p.reposts, "reposts")}
                          {p.duration != null && <span>{E.dur(p.duration)}</span>}
                          {p.permalink && <a href={p.permalink} target="_blank" rel="noopener noreferrer" style={{ color: "var(--red)", display: "inline-flex" }}>
                            <ArrowUpRight style={{ width: 15, height: 15 }} /></a>}
                        </div>
                        <div className="pli-t">{t.slice(0, 220)}{t.length > 220 ? "…" : ""}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
