import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./report.css";
import { EngineProvider, useRoute } from "./app/core.jsx";
import { Nav, Footer } from "./app/Shell.jsx";
import Home from "./pages/Home.jsx";
import Report from "./pages/Report.jsx";

function App() {
  const route = useRoute();
  return (
    <>
      <Nav route={route} />
      <main>{route.startsWith("/report") ? <Report /> : <Home />}</main>
      <Footer />
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode><EngineProvider><App /></EngineProvider></React.StrictMode>
);
