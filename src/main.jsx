import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./report.css";
import { useEffect } from "react";
import { EngineProvider, useApp } from "./app/core.jsx";
import { Nav, Footer } from "./app/Shell.jsx";
import Home from "./pages/Home.jsx";
import Report from "./pages/Report.jsx";

function App() {
  const { route, brand } = useApp();
  const isReport = route === brand.base + "/report" || route.startsWith(brand.base + "/report/");
  useEffect(() => { document.title = `${brand.name} — Daily check`; }, [brand.name]);
  /* key on the brand: switching brands starts the page fresh (tabs, filters) rather than carrying
     one brand's view state into the other */
  return (
    <>
      <Nav route={route} />
      <main key={brand.id}>{isReport ? <Report /> : <Home />}</main>
      <Footer />
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode><EngineProvider><App /></EngineProvider></React.StrictMode>
);
