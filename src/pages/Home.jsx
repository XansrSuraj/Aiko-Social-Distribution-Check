import { useMemo } from "react";
import { ArrowRight, Play, Loader2, ScanSearch, GitMerge, Flag } from "lucide-react";
import { useApp, go, BrandIcon, brandColor, Reveal } from "../app/core.jsx";
import { buildReport, LANG_NAME as LANG } from "../app/viewmodel.js";

const ago = ts => {
  if (!ts) return "never";
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60e3);
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago";
};
/* "A, B and C" */
const listOf = a => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
const DELIVERED = ["ok", "okc", "okh", "asm"];

export default function Home() {
  const { E, run, running, path } = useApp();
  const vm = buildReport(E);
  const { rep, checks } = vm;

  /* the numbers the HUD and the stats strip show, straight from the current report */
  const judged = rep.rows.flatMap(r => r.cells).filter(c => c && c.state !== "na" && c.state !== "none" && c.state !== "unseen");
  const delivered = judged.filter(c => DELIVERED.includes(c.state)).length;
  const pct = judged.length ? Math.round(delivered / judged.length * 100) : null;
  const rowsJudged = rep.rows.filter(r => r.mode !== "none" && r.status !== "unknown");
  const onTime = rowsJudged.filter(r => r.status === "ok").length;
  const langIssues = rep.alerts.filter(a => a.kind === "lang").length;
  const perCheck = checks.apifyCheckUsd;
  const all = E.dcChannels(E.ORG);
  const postsToday = vm.logPosts.length;

  const chips = [
    { k: "Drops in window", v: <><em>{rep.slots.length}</em> {rep.slots.length === 1 ? "drop" : "drops"}</>, x: 6, y: 8, d: .5 },
    { k: "Channels on time", v: <><em>{onTime}</em>/{rowsJudged.length || "—"}</>, x: 66, y: 4, d: .65 },
    { k: "Problems", v: <><em>{rep.alerts.length}</em> {rep.alerts.length === 1 ? "flag" : "flags"}</>, x: 0, y: 46, d: .8 },
    { k: "Wrong language", v: <><em>{langIssues}</em> {langIssues === 1 ? "post" : "posts"}</>, x: 70, y: 52, d: .95 },
    { k: "Last checked", v: <>{ago(checks.lastRun)}</>, x: 8, y: 84, d: 1.1 },
    { k: "Cost per check", v: <><em>{perCheck != null ? "$" + perCheck.toFixed(3) : "free"}</em></>, x: 60, y: 88, d: 1.25 },
  ];

  const marquee = useMemo(() => all.map(c => ({ id: c.id, platform: c.platform, label: c.handle || c.name })), [all.length]);
  const lastPost = id => (checks.posts[id] || [])[0];
  const status = id => {
    const m = (checks.meta || {})[id];
    if (!m) return { cls: "", txt: "not read yet" };
    if (m.ok === false) return { cls: "bad", txt: "could not read" };
    const src = String(m.source || "");
    return { cls: "ok", txt: /-free$/.test(src) ? "read free" : /apify|reels/.test(src) ? "via Apify" : "read" };
  };

  return (
    <>
      {/* ── hero ── */}
      <section className="hero on-dark">
        <div className="wrap">
          <div className="hero-grid">
            <div>
              <Reveal><span className="eyebrow">{E.ORG.name} · Daily check</span></Reveal>
              <Reveal delay={.1} as="h1" className="display xl">Did today's content <b>reach every channel?</b></Reveal>
              <Reveal delay={.2}><p className="lead">Every post on every channel, read the moment you ask — matched drop by drop across{" "}
                {listOf(E.REGIONS.map(r => r[1]))}, with what went out, when, and in which language.</p></Reveal>
              <Reveal delay={.3} className="hero-cta">
                <button className="btn btn-white btn-lg" disabled={running} onClick={() => { go(path("/report")); run(); }}>
                  {running ? <Loader2 className="spin" /> : <Play />}{running ? "Checking…" : "Run daily check"}
                </button>
                <a href={"#" + path("/report")} className="btn btn-ghost-dk btn-lg">Open the report <ArrowRight /></a>
              </Reveal>
            </div>
            <div className="hud" aria-label="Today at a glance">
              <svg className="wires" viewBox="0 0 100 86" preserveAspectRatio="none" aria-hidden="true">
                {chips.map((c, i) => {
                  const cx = 50, cy = 43, tx = c.x + 10, ty = c.y + 5;
                  const d = `M${cx},${cy} L${(cx + tx) / 2},${cy} L${(cx + tx) / 2},${ty} L${tx},${ty}`;
                  return <g key={i}><path className="wire" d={d} style={{ "--d": c.d - .3 + "s", "--len": 140 }} vectorEffect="non-scaling-stroke" />
                    <circle className="node" cx={(cx + tx) / 2} cy={ty} r=".7" /></g>;
                })}
              </svg>
              <div className="hud-core"><div><b>{pct != null ? pct + "%" : "—"}</b><span>delivered</span></div></div>
              {chips.map((c, i) => (
                <div key={i} className="hud-chip" style={{ left: c.x + "%", top: c.y + "%", "--d": c.d + "s" }}>
                  <div className="k">{c.k}</div><div className="v">{c.v}</div>
                </div>
              ))}
            </div>
          </div>
          <Reveal delay={.2} className="hero-foot">
            <span><b>{all.length}</b> channels · <b>{new Set(all.map(c => c.lang)).size}</b> languages · <b>{E.REGIONS.length}</b> regions</span>
            <span>The intelligence layer for content delivery</span>
          </Reveal>
        </div>
      </section>

      {/* ── every channel, scrolling past ── */}
      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[...marquee, ...marquee].map((m, i) => (
            <span key={i} className="marquee-item"><BrandIcon platform={m.platform} />{m.label}</span>
          ))}
        </div>
      </div>

      {/* ── the numbers ── */}
      <section className="section tight">
        <div className="wrap">
          <Reveal className="stats">
            <div className="stat"><div className="v">{all.length}</div><div className="k label">Channels watched</div><div className="s">across {E.REGIONS.length} regions</div></div>
            <div className="stat"><div className="v">{postsToday}</div><div className="k label">Posts read</div><div className="s">in the report's window</div></div>
            <div className="stat"><div className="v"><em>{rep.alerts.length}</em></div><div className="k label">Problems flagged</div><div className="s">missing, late, wrong language</div></div>
            <div className="stat"><div className="v">{pct != null ? pct + "%" : "—"}</div><div className="k label">Delivered</div><div className="s">last checked {ago(checks.lastRun)}</div></div>
          </Reveal>
        </div>
      </section>

      {/* ── channels, by region and language ── */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="sec-head">
            <Reveal>
              <span className="eyebrow">Channels watched</span>
              <h2 className="display l">Every channel. <b>Every language.</b></h2>
            </Reveal>
            <Reveal delay={.15} className="sec-aside">One schedule per region.<br />Each judged on its own drops.</Reveal>
          </div>
          <div className="regions">
            {E.REGIONS.map(([rid, rname], ri) => {
              const cs = E.dcChannels(E.ORG, rid);
              if (!cs.length) return null;
              const langs = [...new Set(cs.map(c => c.lang))];
              return (
                <Reveal key={rid} delay={ri * .1} className="region">
                  <div className="region-h"><h3>{rname}</h3><span className="label">{cs.length} channels</span></div>
                  {langs.map(lg => (
                    <div className="lang-group" key={lg}>
                      <div className="lang-name"><span className="lang-tag">{lg}</span><span className="label">{LANG[lg] || lg}</span></div>
                      <div className="ch-grid">
                        {cs.filter(c => c.lang === lg).map(c => {
                          const st = status(c.id), lp = lastPost(c.id);
                          return (
                            <a key={c.id} className="ch" href={c.url} target="_blank" rel="noopener noreferrer" style={{ "--c": brandColor(c.platform) }}>
                              <span className="ch-icon"><BrandIcon platform={c.platform} /></span>
                              <span className="ch-meta">
                                <span className="ch-name">{E.platform(c.platform).name}</span>
                                <span className="ch-handle" style={{ display: "block" }}>{c.handle || E.pretty(c.url)}</span>
                              </span>
                              <span className="ch-state" title={lp ? "newest post " + new Date(lp.ts).toLocaleString() : ""}>
                                <span className={`dot ${st.cls}`} />{lp ? ago(lp.ts) : st.txt}
                              </span>
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── how it works ── */}
      <section className="section dark on-dark">
        <div className="wrap">
          <div className="sec-head">
            <Reveal>
              <span className="eyebrow">How it works</span>
              <h2 className="display l">One press. <span className="red"><b>Every channel.</b></span></h2>
            </Reveal>
          </div>
          <div className="steps">
            {[
              { n: "01", I: ScanSearch, h: "Read", p: "Every channel is read server-side — free from each platform's own public page, with Apify only as the fallback. Nothing to install." },
              { n: "02", I: GitMerge, h: "Match", p: "Posts that land within minutes of each other become one drop, so you see which content reached which channel — per region, on its own schedule." },
              { n: "03", I: Flag, h: "Flag", p: "Missing, late, posted twice, or in the wrong language — each flagged with the exact time and the caption it saw, never a guess." },
            ].map((s, i) => (
              <Reveal key={s.n} delay={i * .12} className="step">
                <div className="n">{s.n}</div>
                <h4>{s.h}</h4>
                <p>{s.p}</p>
              </Reveal>
            ))}
          </div>
          <Reveal delay={.2} style={{ marginTop: 44 }}>
            <button className="btn btn-red btn-lg" disabled={running} onClick={() => { go(path("/report")); run(); }}>
              {running ? <Loader2 className="spin" /> : <Play />}{running ? "Checking…" : "Run today's check"}
            </button>
          </Reveal>
        </div>
      </section>
    </>
  );
}
