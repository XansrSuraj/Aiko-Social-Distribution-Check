/**
 * Local dev server —  node dev-server.js
 *
 * Serves index.html and routes /api/<name> to api/<name>.js, giving those handlers the small
 * slice of the Vercel request/response API they actually use. Exists so testing needs nothing
 * more than Node: `vercel dev` wants a CLI download, a login and a linked project before it will
 * serve a single byte, none of which this feature needs.
 *
 * Reads .env if one is present, so pointing at the real Supabase row is optional — without it the
 * app runs in local mode and keeps the directory in the browser, and the daily check works either
 * way. Nothing here writes to the database unless you edit something in the app.
 *
 *   node dev-server.js            → http://localhost:3000
 *   node dev-server.js 4000       → another port
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 3000;

/* ── .env, if there is one ─────────────────────────────────────────────── */
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim().replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
  console.log("  loaded .env");
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
};

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (e) { resolve(raw); }
    });
  });
}

/* the handlers only ever touch setHeader / status / json / end */
function shim(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);

  /* ── api routes ── */
  const api = pathname.match(/^\/api\/([a-z0-9_-]+)\/?$/i);
  if (api) {
    /* who is calling, and what — so a phone forwarding Viber notifications can be seen arriving
       (or seen NOT arriving) instead of guessed at. Remote is the caller's IP: 127.0.0.1/::1 is
       this laptop itself, anything else is another device on the network, e.g. the phone. */
    const remote = (req.socket && req.socket.remoteAddress) || "?";
    const stamp = new Date().toTimeString().slice(0, 8);
    const file = path.join(ROOT, "api", api[1] + ".js");
    if (!fs.existsSync(file)) {
      console.log(`  ${stamp}  ${req.method} /api/${api[1]}  from ${remote}  -> 404 no such route`);
      return shim(res).status(404).json({ ok: false, error: "No such API route: " + api[1] });
    }
    try {
      /* re-require each time so editing a handler does not need a restart */
      delete require.cache[require.resolve(file)];
      const handler = require(file);
      req.body = await readBody(req);
      req.query = Object.fromEntries(url.searchParams);
      const s = shim(res);
      let code = 200;
      const setStatus = s.status;
      s.status = c => { code = c; return setStatus(c); };
      await handler(req, s);
      console.log(`  ${stamp}  ${req.method} /api/${api[1]}  from ${remote}  -> ${code}`);
    } catch (err) {
      console.error(`  ! /api/${api[1]}`, err);
      if (!res.writableEnded) {
        shim(res).status(500).json({ ok: false, error: String((err && err.message) || err) });
      }
    }
    return;
  }

  /* ── static files ── */
  if (pathname === "/") pathname = "/index.html";
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end("Forbidden"); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; return res.end("Not found: " + pathname);
  }
  res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  const cloud = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY;
  console.log(`\n  Aiko dev server  →  http://localhost:${PORT}\n`);
  console.log(`  storage   ${cloud ? "cloud (reading the real Supabase row)" : "local — the browser keeps the directory"}`);
  console.log(`  admin     ${process.env.ADMIN_PASSWORD ? "ADMIN_PASSWORD is set" : "no ADMIN_PASSWORD — editing stays local"}`);
  console.log(`\n  Ctrl+C to stop\n`);
});
