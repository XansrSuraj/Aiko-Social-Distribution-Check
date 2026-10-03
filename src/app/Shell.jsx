import { useEffect, useState } from "react";
import { Menu, X, Play, Loader2 } from "lucide-react";
import { useApp, go } from "./core.jsx";

export const Mark = () => (
  <span className="brand-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M5 18 L12 5 L19 18" fill="none" stroke="var(--mark-ink,#fff)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="14.6" r="2" fill="#e31f24" /></svg>
  </span>
);

export function Nav({ route }) {
  const { run, running } = useApp();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  /* over the dark hero the bar is see-through and white; past it, or on any other page, it turns solid */
  const darkTop = route === "/";
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on(); addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  useEffect(() => { setOpen(false); }, [route]);
  const solid = scrolled || !darkTop || open;
  const link = (href, label) => <a href={"#" + href} className={route === href ? "on" : ""}>{label}</a>;
  return (
    <>
      <header className={`nav${solid ? " solid" : ""}`} style={{ "--mark-ink": solid ? "#fff" : "#0b0b0c" }}>
        <div className="wrap">
          <a href="#/" className="brand" aria-label="SportsFC daily check — home"><Mark />SportsFC<small>Daily check</small></a>
          <nav className="nav-links" aria-label="Main">
            {link("/", "Overview")}
            {link("/report", "Report")}
            <a href="/fm-deliveries.html">FM Deliveries</a>
          </nav>
          <button className={`btn btn-sm nav-cta ${solid ? "btn-red" : "btn-white"}`} disabled={running}
            onClick={() => { go("/report"); run(); }}>
            {running ? <Loader2 className="spin" /> : <Play />}{running ? "Checking…" : "Run daily check"}
          </button>
          <button className="icon-btn nav-burger" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen(o => !o)}>
            {open ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      <div className={`nav-sheet${open ? " open" : ""}`} aria-hidden={!open}>
        <a href="#/">Overview</a>
        <a href="#/report">Report</a>
        <a href="/fm-deliveries.html">FM Deliveries</a>
        <button className="btn btn-red btn-lg" style={{ marginTop: 18 }} disabled={running}
          onClick={() => { go("/report"); run(); }}>
          {running ? <Loader2 className="spin" /> : <Play />}{running ? "Checking…" : "Run daily check"}
        </button>
      </div>
    </>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <span>SportsFC · Daily check — did today's content reach every channel?</span>
        <span><a href="#/report">Report</a> · <a href="/fm-deliveries.html">FM Deliveries</a></span>
      </div>
    </footer>
  );
}
