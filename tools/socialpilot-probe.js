/**
 * SocialPilot MCP — what can it actually tell us?
 *
 *   SOCIALPILOT_API_KEY=… node tools/socialpilot-probe.js
 *   SOCIALPILOT_API_KEY=… node tools/socialpilot-probe.js --call <tool> --args '{"…":"…"}'
 *
 * Read-only, and it prints nothing anywhere but this terminal. Run it before anything is built
 * against SocialPilot, because the one thing that decides whether X can be read for free is
 * whether SocialPilot will hand back posts it has ALREADY PUBLISHED — with the text, the exact
 * time, and which account they went to.
 *
 * Why this and not their REST API: that API is write-only and its documentation domains no longer
 * resolve. Its whole post surface was POST /post/update and POST /post/updatewithimage — nothing
 * that reads. The MCP server (April 2026) is the only live programmatic surface, and SocialPilot's
 * own material says it tracks "queued, published, and unscheduled posts" together. Says. That
 * claim is marketing copy until this script prints a tool list, which is the entire point of it.
 *
 * The key goes in an environment variable and is never printed, not even in an error. Generate one
 * at SocialPilot → profile icon → Security → API Key.
 */

const KEY = process.env.SOCIALPILOT_API_KEY || "";
const BASE = "https://mcp.socialpilot.co";

const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : fallback;
};

if (!KEY) {
  console.error("Set SOCIALPILOT_API_KEY first — the key is read from the environment so it never\n" +
                "lands in a shell history file or a transcript.\n\n" +
                "  SocialPilot → profile icon → Security → API Key → Generate\n" +
                "  export SOCIALPILOT_API_KEY=…      (PowerShell: $env:SOCIALPILOT_API_KEY=\"…\")");
  process.exit(1);
}

/* Never let the key reach a console, however this fails. */
const scrub = s => String(s).split(KEY).join("<KEY>");

let sessionId = "";

/* MCP over HTTP answers either as plain JSON or as an SSE stream, depending on the server and the
   call. Both carry the same JSON-RPC payload, so the stream is unwrapped to the last data: line
   rather than being handled as a stream — these are all single-response calls. */
async function rpc(method, params) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const r = await fetch(BASE + "/" + encodeURIComponent(KEY) + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || {} }),
  });

  const sid = r.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  const text = await r.text();
  if (r.status === 401 || r.status === 403) {
    throw new Error("SocialPilot refused the key (HTTP " + r.status + "). Check it is current, and\n" +
                    "that this account's plan includes API access.");
  }
  if (!text.trim()) throw new Error("Empty answer (HTTP " + r.status + ") from " + method);

  let payload = text;
  if (/^\s*(event:|data:)/m.test(text)) {
    const lines = text.split(/\r?\n/).filter(l => l.startsWith("data:"));
    if (!lines.length) throw new Error("SSE with no data line (HTTP " + r.status + ")");
    payload = lines[lines.length - 1].slice(5).trim();
  }

  let j;
  try { j = JSON.parse(payload); }
  catch (e) { throw new Error("Could not parse the answer to " + method + " (HTTP " + r.status + "): " +
                              scrub(payload).slice(0, 300)); }
  if (j.error) throw new Error(method + " → " + scrub(j.error.message || JSON.stringify(j.error)));
  return j.result;
}

/* the spec's opening exchange; some servers will answer tools/list without it, but not all */
async function handshake() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "aiko-daily-check-probe", version: "1.0.0" },
  });
  try {
    await fetch(BASE + "/" + encodeURIComponent(KEY) + "/mcp", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" },
                             sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  } catch (e) { /* a server that does not want the notification is not a problem */ }
}

/* Which tools sound like they return posts that already went out. Only a hint for reading the
   list — the schemas printed underneath are what actually decide it. */
const LOOKS_LIKE_HISTORY = /publish|deliver|sent|history|past|posted|analytic|report/i;

(async () => {
  try { await handshake(); }
  catch (e) { console.error("Handshake failed: " + scrub(e.message)); process.exit(1); }

  const callTool = arg("call", "");

  if (!callTool) {
    let list;
    try { list = await rpc("tools/list"); }
    catch (e) { console.error(scrub(e.message)); process.exit(1); }

    const tools = (list && list.tools) || [];
    console.log(`\nSocialPilot MCP exposes ${tools.length} tool(s):\n`);
    for (const t of tools) {
      const flag = LOOKS_LIKE_HISTORY.test(t.name + " " + (t.description || "")) ? "  ← reads published?" : "";
      console.log("  " + t.name + flag);
      if (t.description) console.log("      " + String(t.description).replace(/\s+/g, " ").slice(0, 160));
      const props = t.inputSchema && t.inputSchema.properties;
      if (props) {
        const req = (t.inputSchema.required || []);
        console.log("      args: " + Object.keys(props)
          .map(k => k + (req.indexOf(k) !== -1 ? "*" : "")).join(", "));
      }
      console.log("");
    }
    console.log("Anything marked ← is worth calling next, e.g.:\n" +
                "  node tools/socialpilot-probe.js --call <name> --args '{\"limit\":5}'\n" +
                "\nWhat we need back per post: the text, an exact publish timestamp, and which\n" +
                "account it went to. If a tool returns those, X is readable for free.\n");
    return;
  }

  let args = {};
  const raw = arg("args", "");
  if (raw) {
    try { args = JSON.parse(raw); }
    catch (e) { console.error("--args must be JSON: " + e.message); process.exit(1); }
  }

  let out;
  try { out = await rpc("tools/call", { name: callTool, arguments: args }); }
  catch (e) { console.error(scrub(e.message)); process.exit(1); }

  /* printed whole and unredacted apart from the key — this is the user's own post data, on their
     own machine, and the shape is exactly what has to be read before mapping it */
  console.log("\n" + scrub(JSON.stringify(out, null, 2)).slice(0, 6000) + "\n");
})();
