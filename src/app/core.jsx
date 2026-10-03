import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createEngine } from "../engine/engine.js";
import { siYoutube, siTelegram, siX, siFacebook, siInstagram, siTiktok } from "simple-icons";
import { AtSign, Bell, Check, CheckCheck, CircleAlert, Copy, Download, Info, Loader2, Trash2, TriangleAlert } from "lucide-react";

/* ── the engine, one per page, and the bits of React state around it ── */
const Ctx = createContext(null);

const TOAST_ICONS = { check: Check, "check-check": CheckCheck, copy: Copy, download: Download, "trash-2": Trash2,
  "triangle-alert": TriangleAlert, info: Info, loader: Loader2, chrome: Bell, "circle-alert": CircleAlert };

/* ── brands: each has its own engine, channels and report; the route says which is on screen ── */
export const BRANDS = [
  { id: "sportsfc", name: "SportsFC", base: "" },
  { id: "matchpulse", name: "MatchPulse", base: "/matchpulse" },
];
export const brandOf = route => BRANDS.find(b => b.base && (route === b.base || route.startsWith(b.base + "/"))) || BRANDS[0];

export function EngineProvider({ children }) {
  const [ver, bump] = useReducer(n => n + 1, 0);
  const [toasts, setToasts] = useState([]);
  const [running, setRunning] = useState({});           // brand id -> a check is in progress
  const engines = useRef({});
  const route = useRoute();
  const brand = brandOf(route);
  const toast = useCallback((msg, icon) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t.filter(x => x.icon !== "loader" || icon === "loader").slice(-2), { id, msg, icon }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), icon === "loader" ? 6000 : 3200);
  }, []);
  /* created on first visit and kept, so switching brands mid-check loses nothing */
  if (!engines.current[brand.id]) {
    const e = createEngine({ brand: brand.id, toast: (m, i) => toast(m, i), onChange: () => bump() });
    engines.current[brand.id] = e;
  }
  const E = engines.current[brand.id];
  const booted = useRef(new Set());
  useEffect(() => { if (!booted.current.has(brand.id)) { booted.current.add(brand.id); E.boot(); } }, [E, brand.id]);

  /* one press reads every channel of every region of this brand; the page follows along */
  const run = useCallback(async (serverOnly) => {
    const id = brand.id;
    if (running[id]) return;
    setRunning(r => ({ ...r, [id]: true }));
    try { if (serverOnly) { await E.collectServer(E.ORG); E.absorbBrowserRun(); } else await E.runEverything(E.ORG); }
    finally { setRunning(r => ({ ...r, [id]: false })); bump(); }
  }, [E, brand.id, running]);

  /* ver changes on every engine redraw, so every page reading the engine repaints with it */
  const value = useMemo(() => ({ E, ver, toast, running: !!running[brand.id], run, refresh: bump, route, brand,
    path: p => brand.base + p }), [E, ver, toast, running, run, route, brand]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map(t => { const I = TOAST_ICONS[t.icon] || Check;
          return <div key={t.id} className="toast"><I className={t.icon === "loader" ? "spin" : ""} /><span>{t.msg}</span></div>; })}
      </div>
    </Ctx.Provider>
  );
}
export const useApp = () => useContext(Ctx);

/* ── a small hash router: #/ and #/report for SportsFC, #/matchpulse and #/matchpulse/report ── */
export function useRoute() {
  const get = () => (location.hash.replace(/^#/, "") || "/");
  const [route, setRoute] = useState(get);
  useEffect(() => {
    const on = () => { setRoute(get()); window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" }); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
export const go = path => { location.hash = path; };

/* ── brand marks ── */
const SI = { youtube: siYoutube, telegram: siTelegram, tgbot: siTelegram, x: siX, facebook: siFacebook, instagram: siInstagram, tiktok: siTiktok };
export function BrandIcon({ platform, ...rest }) {
  const icon = SI[platform];
  if (!icon) return <AtSign {...rest} />;
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}><path d={icon.path} /></svg>;
}
export const brandColor = platform => (SI[platform] ? "#" + SI[platform].hex : "#525252");

/* ── fade-up as it scrolls into view (aiko's reveal) ── */
export function Reveal({ as: Tag = "div", delay = 0, className = "", children, ...rest }) {
  const ref = useRef(null);
  const [inView, setIn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) { setIn(true); return; }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setIn(true); io.disconnect(); } },
      { rootMargin: "0px 0px -8% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <Tag ref={ref} className={`reveal${inView ? " in" : ""} ${className}`} style={{ "--d": delay + "s" }} {...rest}>{children}</Tag>;
}

/* ── confirm dialog ── */
export function useConfirm() {
  const [state, setState] = useState(null);
  const ask = useCallback((title, body, action = "Delete") => new Promise(res => setState({ title, body, action, res })), []);
  const close = v => { if (state) state.res(v); setState(null); };
  useEffect(() => {
    if (!state) return;
    const k = e => { if (e.key === "Escape") close(false); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  });
  const node = state && (
    <div className="veil" onClick={e => { if (e.target === e.currentTarget) close(false); }}>
      <div className="dialog" role="dialog" aria-modal="true">
        <h3>{state.title}</h3>
        <p>{state.body}</p>
        <div className="dialog-actions">
          <button className="btn btn-line" onClick={() => close(false)}>Cancel</button>
          <button className="btn btn-red" autoFocus onClick={() => close(true)}>{state.action}</button>
        </div>
      </div>
    </div>
  );
  return [ask, node];
}

export function copyText(txt, toast) {
  const done = () => toast("Report copied to the clipboard", "copy");
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt).then(done, fallback);
  fallback();
  function fallback() {
    const a = document.createElement("textarea");
    a.value = txt; a.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(a); a.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed", "triangle-alert"); }
    a.remove();
  }
}
