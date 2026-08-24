/**
 * api/viber-webhook.js — the Viber bot webhook. Verifies the handshake, that a posted message is
 * routed to the right community and stored through the shared core (so it de-dupes against the
 * phone path), that a media-only post is still counted, and that the URL secret gates it.
 *
 *   node test/viberwebhook.test.js
 */
process.env.VIBER_WEBHOOK_SECRET = "sekret-123";
process.env.VIBER_COMMUNITIES = "Sportsfc.vn=viber:sportsfc.vn,Sportsfc.fans=viber:sportsfc.fans";

const path = require("path");
const store = require(path.join(__dirname, "..", "ingest-store.js"));
const HANDLER = path.join(__dirname, "..", "api", "viber-webhook.js");
const handler = require(HANDLER);

let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };

function call(query, body) {
  return new Promise(resolve => {
    handler({ method: "POST", query: query || {}, body: body || {}, headers: {} },
      { setHeader() {}, status(c) { this._c = c; return this; }, json(j) { resolve({ code: this._c, j }); }, end() { resolve({ code: this._c }); } });
  });
}
const nowMs = () => Date.now();

(async () => {
  /* start clean */
  for (const id of ["viber:sportsfc.vn", "viber:sportsfc.fans"]) await store.clear(id);

  console.log("── the set-webhook handshake");
  let r = await call({ s: "sekret-123" }, { event: "webhook" });
  ok(r.code === 200 && r.j && r.j.status === 0, "the webhook verification is answered with status 0", JSON.stringify(r.j));

  console.log("\n── a posted message is routed and stored");
  r = await call({ s: "sekret-123", community: "viber:sportsfc.vn" },
    { event: "message", timestamp: nowMs(), sender: { name: "Admin" }, message: { type: "text", text: "Trận cầu tâm điểm tối nay" } });
  ok(r.j.ok === true && r.j.channelId === "viber:sportsfc.vn" && r.j.added === 1,
    "a text post lands in the community named by ?community=", JSON.stringify(r.j));
  ok((await store.getPosts("viber:sportsfc.vn")).length === 1, "and it is readable back");

  console.log("\n── the same post twice is stored once (dedupe across the pipeline)");
  r = await call({ s: "sekret-123", community: "viber:sportsfc.vn" },
    { event: "message", timestamp: nowMs(), sender: { name: "Admin" }, message: { type: "text", text: "Trận cầu tâm điểm tối nay" } });
  ok(r.j.added === 0, "a repeat within the window adds nothing", JSON.stringify(r.j));

  console.log("\n── a media-only post is still counted");
  r = await call({ s: "sekret-123", community: "viber:sportsfc.fans" },
    { event: "message", timestamp: nowMs(), sender: { name: "Admin" }, message: { type: "video" } });
  ok(r.j.ok === true && r.j.channelId === "viber:sportsfc.fans" && r.j.added === 1,
    "a caption-less video post is stored, not dropped", JSON.stringify(r.j));
  ok((await store.getPosts("viber:sportsfc.fans"))[0].text === "[video post]",
    "with a caption derived from its type");

  console.log("\n── routing without ?community= (fall back to the name)");
  await store.clear("viber:sportsfc.fans");
  r = await call({ s: "sekret-123" },
    { event: "message", timestamp: nowMs(), sender: { name: "Sportsfc.fans" }, message: { type: "text", text: "Tonight's big match" } });
  ok(r.j.channelId === "viber:sportsfc.fans" && r.j.added === 1,
    "the community name in the sender routes it", JSON.stringify(r.j));

  console.log("\n── what must be refused / ignored");
  r = await call({ s: "wrong" }, { event: "message", message: { text: "x" } });
  ok(r.j.ok === false, "a wrong secret is refused (as a quiet 200, so Viber keeps the hook)", JSON.stringify(r.j));
  r = await call({ s: "sekret-123" }, { event: "delivered", message_token: 1 });
  ok(r.j.ok === true && /delivered/.test(r.j.ignored || ""), "a non-message event is acknowledged and ignored", JSON.stringify(r.j));

  /* clean up */
  for (const id of ["viber:sportsfc.vn", "viber:sportsfc.fans"]) await store.clear(id);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
