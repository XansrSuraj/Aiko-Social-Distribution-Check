import { useState } from "react";
import { ArrowUpRight, Eye, Heart, MessageCircle, Repeat2, Quote, Bookmark, Link as LinkIcon, Music } from "lucide-react";
import { BrandIcon } from "../../app/core.jsx";
import { LANG_NAME, capOf, tagsOf, linkOf, slotIxOf, borrowCap } from "../../app/viewmodel.js";
import { Thumb } from "./Drops.jsx";

/* Every post every reader brought back, as a card: picture, whole caption, hashtags, counters,
   links and which drop it belongs to. A reel with no caption of its own borrows its drop's caption
   from a channel in the same language — labelled as borrowed, never passed off as its own. */
function Card({ E, vm, p }) {
  const { rep, chanOf } = vm;
  const [open, setOpen] = useState(false);
  const c = chanOf(p.channelId), pf = E.platform(c.platform);
  const si = slotIxOf(rep, p);
  const own = capOf(p);
  const lent = own ? null : borrowCap(rep, chanOf, p, c, si);
  const d = E.detectLang(p.text);
  const bad = !!(c.lang && d.lang && d.lang !== c.lang);
  const tags = tagsOf(p), link = linkOf(p), href = E.safeUrl(p.permalink || "");
  const st = (v, I, label) => v === null || v === undefined || v === "" ? null
    : <span title={label}><I /><b>{E.num2(v)}</b></span>;
  const ph = <span className="ph"><BrandIcon platform={c.platform} /></span>;
  return (
    <div className={`card pc${bad ? " bad" : ""}`}>
      <a className="pc-img" {...(href ? { href, target: "_blank", rel: "noopener noreferrer", title: "open the post" } : {})}>
        <Thumb E={E} src={p.thumb} fallback={ph} />
        <span className="pc-plat"><BrandIcon platform={c.platform} /></span>
        {p.duration ? <span className="pc-dur">{E.dur(p.duration)}</span> : null}
      </a>
      <div className="pc-b">
        <div className="pc-h"><b title={c.name || p.channelId}>{c.name || p.channelId}</b><span className="mono" title={p.ts}>{E.fmtWhen(p.ts, rep.tz)}</span></div>
        <div className="pc-tags">
          <span className="tg">{p.kind || "post"}</span>
          {d.lang && <span className={`tg${bad ? " warn" : ""}`}
            title={bad ? `caption is ${LANG_NAME[d.lang] || d.lang}, channel is ${LANG_NAME[c.lang] || c.lang}` : d.why || ""}>
            {d.lang}{bad ? " ≠ " + c.lang : ""}</span>}
          {si >= 0 ? <span className="tg ok" title={`part of the ${rep.slots[si].time} drop`}>drop {rep.slots[si].time}</span>
            : p.viaCaption ? <span className="tg ok">matched by caption</span>
            : <span className="tg" title="no other channel posted at this time">no drop</span>}
        </div>
        {own ? <div className={`pc-text${open ? " open" : ""}`} onClick={() => setOpen(o => !o)} title="click to show all of it">{own}</div>
          : lent ? <>
              <div className={`pc-text lent${open ? " open" : ""}`} onClick={() => setOpen(o => !o)}>{lent.text}</div>
              <div className="pc-note">{pf.name} gives no caption for this post — this is the same drop's caption on {lent.from}</div>
            </>
          : <div className="pc-text none">no caption</div>}
        {tags.length > 0 && <div className="pc-hash">{tags.map(t => <span key={t}>#{t}</span>)}</div>}
        <div className="pc-stats">
          {st(p.views, Eye, "views / plays")}{st(p.likes != null ? p.likes : p.reactions, Heart, "likes")}
          {st(p.comments, MessageCircle, "comments")}{st(p.reposts, Repeat2, "shares / reposts")}
          {st(p.quotes, Quote, "quotes")}{st(p.saves, Bookmark, "saves / bookmarks")}
        </div>
        {(href || (link && E.safeUrl(link)) || p.music || p.author) && (
          <div className="pc-links">
            {href && <a href={href} target="_blank" rel="noopener noreferrer"><ArrowUpRight />open post</a>}
            {link && E.safeUrl(link) && <a href={E.safeUrl(link)} target="_blank" rel="noopener noreferrer" title={link}><LinkIcon />{E.pretty(link)}</a>}
            {p.music && <span className="by" title="sound"><Music style={{ width: 13, height: 13, verticalAlign: -2 }} /> {p.music}</span>}
            {p.author && <span className="by">by {p.author}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Content({ E, vm }) {
  const { logPosts, chanOf } = vm;
  const [plat, setPlat] = useState("all");
  const [lang, setLang] = useState("all");
  if (!logPosts.length) return <div className="card empty"><b>No posts collected in this window yet.</b><br />Press Run everything above.</div>;

  const cPlats = [...new Set(logPosts.map(p => chanOf(p.channelId).platform).filter(Boolean))];
  const cLangs = [...new Set(logPosts.map(p => chanOf(p.channelId).lang).filter(Boolean))];
  const platSel = cPlats.includes(plat) ? plat : "all";
  const langSel = cLangs.includes(lang) ? lang : "all";
  const posts = logPosts.filter(p => { const c = chanOf(p.channelId);
    return (platSel === "all" || c.platform === platSel) && (langSel === "all" || c.lang === langSel); });
  const total = f => posts.reduce((n, p) => typeof p[f] === "number" ? n + p[f] : n, 0);
  const has = f => posts.some(p => typeof p[f] === "number");

  return (
    <>
      <div className="filters">
        {["all", ...cPlats].map(k => (
          <button key={k} className={`chipf${platSel === k ? " on" : ""}`} onClick={() => setPlat(k)}>
            {k !== "all" && <BrandIcon platform={k} />}{k === "all" ? "All platforms" : E.platform(k).name}
            <span className="ct">{logPosts.filter(p => k === "all" || chanOf(p.channelId).platform === k).length}</span>
          </button>
        ))}
        {cLangs.length > 1 && <span className="bar-sep" style={{ height: 24 }} />}
        {cLangs.length > 1 && ["all", ...cLangs].map(l => (
          <button key={l} className={`chipf${langSel === l ? " on" : ""}`} onClick={() => setLang(l)}>{l === "all" ? "All languages" : LANG_NAME[l] || l}</button>
        ))}
      </div>
      <div className="totals">
        <span><b>{posts.length}</b> post{posts.length === 1 ? "" : "s"}</span>
        {has("views") && <span><b>{E.compact(total("views"))}</b> views</span>}
        {has("likes") && <span><b>{E.compact(total("likes"))}</b> likes</span>}
        {has("comments") && <span><b>{E.compact(total("comments"))}</b> comments</span>}
        {has("reposts") && <span><b>{E.compact(total("reposts"))}</b> shares</span>}
      </div>
      {posts.length ? <div className="cgrid">{posts.map(p => <Card key={p.channelId + ":" + (p.externalId || p.ts)} E={E} vm={vm} p={p} />)}</div>
        : <div className="card empty"><b>Nothing matches these filters.</b></div>}
      <div className="foot-note">Every post read in this window, newest first — counters are as of the last read. Click a caption to show all of it.
        Pictures come through this site; a platform's signed link expires after a few days, after which the card shows the platform's mark instead.</div>
    </>
  );
}
