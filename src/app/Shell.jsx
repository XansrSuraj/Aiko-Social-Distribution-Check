import { useEffect, useState } from "react";
import { Menu, X, Play, Loader2 } from "lucide-react";
import { useApp, go, BRANDS } from "./core.jsx";

export const Mark = () => (
  <span className="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M5 18 L12 5 L19 18" fill="none" stroke="var(--mark-ink,#f3efe7)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="14.6" r="2" fill="#e31f24" /></svg>
  </span>
);

/* SportsFC | MatchPulse — each brand opens on the same page it is switched from (overview or report) */
function BrandSwitch({ route, onDark }) {
  const { brand } = useApp();
  const onReport = route.endsWith("/report");
  return (
    <div className={`brand-switch${onDark ? " dk" : ""}`} role="group" aria-label="Brand">
      {BRANDS.map(b => (
        <a key={b.id} href={"#" + (b.base + (onReport ? "/report" : "") || "/")} className={b.id === brand.id ? "on" : ""}
          aria-current={b.id === brand.id ? "true" : undefined}>{b.name}</a>
      ))}
    </div>
  );
}

export function Nav({ route }) {
  const { run, running, brand, path } = useApp();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  /* over the dark hero the bar is see-through with light text; past it, or on any other page, it turns solid */
  const home = path("") || "/";
  const darkTop = route === home;
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on(); addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  useEffect(() => { setOpen(false); }, [route]);
  const solid = scrolled || !darkTop || open;
  const link = (href, label) => <a href={"#" + href} className={route === href ? "on" : ""}>{label}</a>;
  const runIt = () => { go(path("/report")); run(); };
  return (
    <>
      <header className={`nav${solid ? " solid" : ""}`} style={{ "--mark-ink": solid ? "#f3efe7" : "#0b0b0c" }}>
        <div className="wrap">
          <a href={"#" + home} className="brand" aria-label={`${brand.name} daily check — home`}><Mark /><span className="brand-name">{brand.name}</span><small>Daily check</small></a>
          <BrandSwitch route={route} onDark={!solid} />
          <nav className="nav-links" aria-label="Main">
            {link(home, "Overview")}
            {link(path("/report"), "Report")}
            <a href="/fm-deliveries.html">FM Deliveries</a>
          </nav>
          <button className={`btn btn-sm nav-cta ${solid ? "btn-red" : "btn-white"}`} disabled={running} onClick={runIt}>
            {running ? <Loader2 className="spin" /> : <Play />}{running ? "Checking…" : "Run daily check"}
          </button>
          <button className="icon-btn nav-burger" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen(o => !o)}>
            {open ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      <div className={`nav-sheet${open ? " open" : ""}`} aria-hidden={!open}>
        <div className="label" style={{ margin: "4px 0 8px" }}>Brand</div>
        <BrandSwitch route={route} />
        <a href={"#" + home} style={{ marginTop: 14 }}>Overview</a>
        <a href={"#" + path("/report")}>Report</a>
        <a href="/fm-deliveries.html">FM Deliveries</a>
        <button className="btn btn-red btn-lg" style={{ marginTop: 18 }} disabled={running} onClick={runIt}>
          {running ? <Loader2 className="spin" /> : <Play />}{running ? "Checking…" : `Run ${brand.name} check`}
        </button>
      </div>
    </>
  );
}

export function Footer() {
  const { brand, path } = useApp();
  return (
    <footer className="footer">
      <div className="wrap">
        <span>{brand.name} · Daily check — did today's content reach every channel?</span>
        <span>
          {BRANDS.map(b => <a key={b.id} href={"#" + (b.base || "/")}>{b.name}</a>).reduce((a, x) => [...a, " · ", x], []).slice(1)}
          {" · "}<a href={"#" + path("/report")}>Report</a> · <a href="/fm-deliveries.html">FM Deliveries</a>
        </span>
      </div>
    </footer>
  );
}
