import { useEffect, useState } from "react";
import { Copy, Download, Trash2, Play, Loader2, Server, Merge, TriangleAlert, CheckCheck, CircleHelp } from "lucide-react";
import { useApp, useConfirm, copyText } from "../app/core.jsx";
import { buildReport } from "../app/viewmodel.js";
import { reportText } from "../app/copyReport.js";
import Summary from "./report/Summary.jsx";
import Drops from "./report/Drops.jsx";
import Content from "./report/Content.jsx";
import PostLog from "./report/PostLog.jsx";
import Channels from "./report/Channels.jsx";

const TABS = [["sum", "Summary"], ["drops", "What went out"], ["content", "Content"], ["log", "Post log"], ["chan", "Per channel"]];

export default function Report() {
  const { E, toast, run, running } = useApp();
  const [ask, confirmNode] = useConfirm();
  const [tab, setTab] = useState("sum");
  useEffect(() => { E.refreshApifyUsage(); }, [E]);

  const vm = buildReport(E);
  const { o, checks, rep, wo } = vm;

  const del = async () => {
    if (!await ask("Delete this report?", "Every collected post, count and note goes. Cells you confirmed by hand are kept.", "Delete report")) return;
    E.resetReport();
    toast("Report deleted", "trash-2");
  };

  return (
    <>
      <section className="rp-head">
        <div className="wrap">
          <div className="rp-head-row">
            <div>
              <span className="eyebrow">{o.name} · Report</span>
              <h1 className="display l">Daily <b>check</b></h1>
              <div className="rp-when">
                {wo.mode === "day"
                  ? <><b>{wo.date}</b> · {E.dayRange(rep)}</>
                  : <><b>{E.fmtWhen(rep.from, rep.tz)}</b> → <b>{E.fmtWhen(rep.to, rep.tz)}</b></>}
                {" "}· {E.tzLabel(rep.tz)} · drops grouped within ±{rep.win} min
              </div>
            </div>
            <div className="rp-actions">
              <button className="btn btn-line btn-sm" onClick={() => copyText(reportText(E, vm), toast)}><Copy />Copy</button>
              <button className="btn btn-line btn-sm" onClick={() => E.downloadReportCard(rep, o, wo)}><Download />Download</button>
              <button className="btn btn-danger btn-sm" onClick={del}><Trash2 />Delete</button>
            </div>
          </div>
        </div>
      </section>

      <Controls E={E} vm={vm} />

      <section className="section tight" style={{ paddingTop: 28 }}>
        <div className="wrap">
          <RunCard E={E} vm={vm} run={run} running={running} toast={toast} />
          <Verdict vm={vm} />

          <div className="tabs" role="tablist">
            {TABS.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>
                {l}
                {(k === "log" || k === "content") && <span className="ct">{vm.logPosts.length}</span>}
                {k === "drops" && <span className="ct">{rep.slots.length}</span>}
              </button>
            ))}
          </div>

          <div className="panel" key={tab}>
            {tab === "sum" && <Summary E={E} vm={vm} toast={toast} />}
            {tab === "drops" && <Drops E={E} vm={vm} />}
            {tab === "content" && <Content E={E} vm={vm} />}
            {tab === "log" && <PostLog E={E} vm={vm} />}
            {tab === "chan" && <Channels E={E} vm={vm} />}
          </div>
          <div className="foot-note">{checks.lastRun ? "Collected " + new Date(checks.lastRun).toLocaleString() : "Never collected"}</div>
        </div>
      </section>
      {confirmNode}
    </>
  );
}

/* ── the sticky controls: which region, which stretch of time, how it is judged ── */
function Controls({ E, vm }) {
  const { o, checks, view } = vm;
  const set = (key, num) => e => { const v = e.target.value; E.update(c => { c[key] = num ? Number(v) : v; }); };
  const today = E.contentDate(new Date().toISOString(), Number(checks.tz) || 0);
  return (
    <div className="rp-bar">
      <div className="wrap">
        <div className="seg" role="group" aria-label="Region">
          {[["all", "All regions", o.socials.length],
            ...E.REGIONS.map(([v, l]) => [v, l, o.socials.filter(s => E.regionOf(s) === v).length])].map(([v, l, n]) => (
            <button key={v} className={view === v ? "on" : ""} onClick={() => E.update(c => { c.regionView = v; })}
              title="Each region is always judged on its own schedule of drops">{l} · {n}</button>
          ))}
        </div>
        <span className="bar-sep" />
        <label className="fld"><span>Window</span>
          <select value={String(checks.window || "today")} onChange={set("window")}>
            {E.WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        {String(checks.window) === "date" && (
          <label className="fld"><span>Date</span>
            <input type="date" value={checks.date || today} max={today} onChange={set("date")} /></label>
        )}
        <label className="fld"><span>Timezone</span>
          <select value={Number(checks.tz) || 0} onChange={set("tz", true)}>
            {E.TZS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        <label className="fld"><span>Same drop within</span>
          <select value={checks.win} onChange={set("win", true)}>
            {[5, 10, 15, 30, 60].map(v => <option key={v} value={v}>±{v} min</option>)}
          </select></label>
        <label className="fld"><span>Flag above</span>
          <select value={checks.maxPer || 4} onChange={set("maxPer", true)}>
            {[2, 3, 4, 5, 6, 8].map(v => <option key={v} value={v}>max {v}</option>)}
          </select></label>
      </div>
    </div>
  );
}

/* ── one press reads everything; the two source rows say what answered ── */
function RunCard({ E, vm, run, running, toast }) {
  const { srvIds, brwIds, platNames, gotFrom, silent, apifyNote, pendingN } = vm;
  const msg = E.extReady && E.extStale()
    ? <>Extension is v{E.extVersion} but this build needs v{E.EXT_WANT} — reload it at chrome://extensions</>
    : E.apifyInfo && E.apifyInfo.configured === false && brwIds.length
      ? <>Apify isn't configured — Facebook, Instagram and TikTok are read free; X needs Apify</>
      : <><b>Every channel, server-side, one press.</b> Free readers first, Apify only where they fail.</>;
  const row = (name, ids, note) => {
    const have = gotFrom(ids), total = ids.length;
    return (
      <div className="src">
        <span className={`dot ${!total ? "" : have === total ? "ok" : have ? "warn" : "bad"}`} />
        <div><div className="src-name">{name}</div><div className="src-what">{total ? platNames(ids) : "no channels of this kind here"}</div></div>
        {total ? <div className="src-n">{have}/{total} channel{total === 1 ? "" : "s"}</div> : <span />}
        {total && note ? <div className="src-note">{note}</div> : null}
      </div>
    );
  };
  return (
    <div className="run on-dark">
      <div className="run-top">
        <button className="btn btn-red" disabled={running} onClick={() => run()}>
          {running ? <Loader2 className="spin" /> : <Play />}{running ? "Checking…" : "Run everything"}
        </button>
        <div className="run-msg">{msg}</div>
        {pendingN > 0 && (
          <button className="btn btn-ghost-dk btn-sm" onClick={() => { if (!E.absorbBrowserRun()) toast("That run had nothing new in it", "info"); }}>
            <Merge />Merge {pendingN} waiting</button>
        )}
        <button className="btn btn-ghost-dk btn-sm" disabled={running} onClick={() => run(true)}
          title="Read every channel server-side, without asking the extension for the ones that fail"><Server />Server only</button>
      </div>
      {silent.length > 0 && (
        <div className="why-list">{silent.map(x => <div key={x.id}><b>{x.name}</b> — {x.note}</div>)}</div>
      )}
      <div className="sources">
        {row("Server · free", srvIds)}
        {row("Server · social", brwIds, apifyNote)}
      </div>
    </div>
  );
}

/* ── the headline: problems, all clear, or nothing yet ── */
function Verdict({ vm }) {
  const { rep, srvIds, brwIds, platNames } = vm;
  const [all, setAll] = useState(false);
  const n = rep.alerts.length;
  /* a long list would push the report itself off a phone screen — the first few, then a button */
  const SHOW = 4;
  const shown = all ? rep.alerts : rep.alerts.slice(0, SHOW);
  if (n) return (
    <div className="verdict bad">
      <div className="verdict-h"><TriangleAlert />{n} problem{n === 1 ? "" : "s"}</div>
      <div className="alerts">
        {shown.map((a, i) => (
          <div key={i} className="alert">
            <span className={`kind ${a.kind}`}>{a.kind === "lang" ? "language" : a.kind}</span>
            <span className="txt"><b>{a.name}</b> — {a.text}</span>
          </div>
        ))}
      </div>
      {n > SHOW && (
        <button className="btn btn-line btn-sm" style={{ marginTop: 12 }} onClick={() => setAll(v => !v)}>
          {all ? "Show fewer" : `Show all ${n} problems`}</button>
      )}
    </div>
  );
  if (rep.expected === null) return (
    <div className="verdict wait">
      <div className="verdict-h"><CircleHelp />Nothing measured yet</div>
      <div className="verdict-sub">Press <b>Run everything</b> — the server reads {platNames(srvIds) || "the free channels"}
        {brwIds.length ? <> and {platNames(brwIds)}, free first with Apify as the fallback</> : null}, all in one go.</div>
    </div>
  );
  return (
    <div className="verdict good">
      <div className="verdict-h"><CheckCheck />All clear</div>
      <div className="verdict-sub">
        {rep.regions
          ? <>Every collected channel got all its posts — {rep.regions.filter(g => g.expected !== null).map(g => g.name + ": " + g.expected).join(" · ")}</>
          : <>Every collected channel got all {rep.expected} post{rep.expected === 1 ? "" : "s"}</>}
        {rep.sum && rep.sum.unknown ? <>. {rep.sum.unknown} channel(s) still have no data.</> : "."}
      </div>
    </div>
  );
}
