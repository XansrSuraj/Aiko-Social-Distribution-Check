/**
 * api/ingest.js and ingest-store.js — the way in for channels nothing can read.
 *
 * Viber is why this exists: no public post list, no web client for the extension, an encrypted
 * desktop store. So whatever publishes to it pushes here instead. Two properties matter more than
 * anything else and are pinned below:
 *
 *   · pushing the same list twice must not double the count. A cron will re-send today's posts
 *     every hour, and a daily check that grows by four posts an hour is worse than no check.
 *   · an empty store must read as unknown, never as a quiet day — the store knows only what was
 *     pushed, and silence from the pusher is not silence from the channel.
 *
 *   node test/ingest.test.js
 */
const fs = require("fs");
const path = require("path");

/* a throwaway store beside the real one, removed at the end — the file backend writes next to
   ingest-store.js, so the test drives it through a temporary HOME-less copy of the module */
const ROOT = path.join(__dirname, "..");
const STORE_FILE = path.join(ROOT, ".ingest.json");
const BACKUP = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, "utf8") : null;

function fresh() {
  try { fs.unlinkSync(STORE_FILE); } catch (e) {}
  delete require.cache[require.resolve("../ingest-store.js")];
  delete require.cache[require.resolve("../api/ingest.js")];
  return require("../ingest-store.js");
}

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

const ago = h => new Date(Date.now() - h * 3600e3).toISOString();

/* drive the handler the way Vercel would, with a loopback socket so the no-key path applies */
function call(method, body, query) {
  delete require.cache[require.resolve("../api/ingest.js")];
  const handler = require("../api/ingest.js");
  return new Promise(resolve => {
    handler({ method, body, query: query || {}, headers: {},
              socket: { remoteAddress: "127.0.0.1" } },
            { setHeader() {}, status(c) { this._c = c; return this; },
              json(p) { resolve({ status: this._c || 200, body: p }); } });
  });
}

(async () => {
  console.log("── what goes in comes back out");
  const store = fresh();

  let r = await call("POST", { channelId: "vb", posts: [
    { externalId: "a", ts: ago(2), text: "Arsenal vs Man City", permalink: "https://sfc.my/r/x", views: 12 },
    { externalId: "b", ts: ago(26), text: "Nashville vs Messi" },
  ] });
  check(r.body.ok === true && r.body.added === 2, "two posts are accepted", JSON.stringify(r.body));

  const back = await store.getPosts("vb");
  check(back.length === 2, "and are readable again", `${back.length}`);
  check(back[0].externalId === "a", "newest first — the report relies on it",
    back.map(p => p.externalId).join(","));
  check(back[0].views === 12 && back[0].permalink === "https://sfc.my/r/x",
    "the numbers and the link survive the round trip", JSON.stringify(back[0]));
  check(!isNaN(new Date(back[0].ts).getTime()), "and the timestamp is a real instant", back[0].ts);

  console.log("\n── a cron may re-send the same day forever");
  r = await call("POST", { channelId: "vb", posts: [
    { externalId: "a", ts: ago(2), text: "Arsenal vs Man City" },
    { externalId: "b", ts: ago(26), text: "Nashville vs Messi" },
  ] });
  check(r.body.added === 0 && r.body.total === 2,
    "re-sending the same list adds nothing", JSON.stringify(r.body));

  r = await call("POST", { channelId: "vb", posts: [{ externalId: "c", ts: ago(1), text: "new one" }] });
  check(r.body.added === 1 && r.body.total === 3, "but a genuinely new post is taken",
    JSON.stringify(r.body));

  /* no id given: the instant becomes the id, so the same instant still cannot double up */
  await call("POST", { channelId: "vb2", posts: [{ ts: "2026-08-16T07:48:00Z", text: "no id" }] });
  r = await call("POST", { channelId: "vb2", posts: [{ ts: "2026-08-16T07:48:00Z", text: "no id" }] });
  check(r.body.added === 0, "a post with no id is de-duplicated on its timestamp",
    JSON.stringify(r.body));

  console.log("\n── the shapes a phone rule can actually build");
  /* A notification-forwarding rule on a phone can rarely construct a nested array. If the endpoint
     insisted on one, every such setup would fail at the last step — so a single post may be sent
     flat, and a form post is accepted alongside JSON. */
  r = await call("POST", { channelId: "ph", ts: ago(1), text: "Arsenal vs Man City" });
  check(r.body.ok === true && r.body.added === 1, "a single post sent flat is accepted",
    JSON.stringify(r.body));
  r = await call("POST", "channelId=ph&ts=" + encodeURIComponent(ago(3)) + "&text=form+encoded+post");
  check(r.body.ok === true && r.body.added === 1, "and so is a form-encoded body",
    JSON.stringify(r.body));
  r = await call("POST", JSON.stringify({ channelId: "ph", ts: ago(5), message: "under 'message'" }));
  check(r.body.ok === true && r.body.added === 1, "'message' is taken as the text, like 'text'",
    JSON.stringify(r.body));
  {
    const got = await store.getPosts("ph");
    check(got.length === 3 && got.every(p => p.text), "all three round-trip with their words",
      JSON.stringify(got.map(p => p.text)));
  }

  console.log("\n── channels stay apart");
  check((await store.getPosts("vb")).length === 3 && (await store.getPosts("vb2")).length === 1,
    "one channel's posts never land in another's");
  check((await store.getPosts("never-pushed")).length === 0,
    "and a channel nobody pushed for is simply empty");

  console.log("\n── what must be refused");
  r = await call("POST", { channelId: "vb" });
  check(r.status === 400, "a body with no posts array is rejected", String(r.status));
  r = await call("POST", { posts: [] });
  check(r.status === 400, "and so is one with no channel id", String(r.status));
  r = await call("POST", { channelId: "vb", posts: [{ text: "no timestamp at all" }] });
  check(r.body.added === 0, "a post with no usable timestamp is dropped, not stored as now",
    JSON.stringify(r.body));
  r = await call("GET", null, {});
  check(r.status === 400, "GET without a channelId is rejected", String(r.status));

  console.log("\n── DELETE clears one channel (test data / bad push cleanup)");
  check((await store.getPosts("vb")).length > 0, "vb has posts before delete");
  r = await call("DELETE", null, { channelId: "vb" });
  check(r.body.ok === true && r.body.removed > 0, "DELETE reports how many it removed", JSON.stringify(r.body));
  check((await store.getPosts("vb")).length === 0, "vb is empty after delete");
  check((await store.getPosts("vb2")).length === 1, "and another channel is left untouched");
  r = await call("DELETE", null, {});
  check(r.status === 400, "DELETE without a channelId is rejected", String(r.status));

  console.log("\n── a stranger cannot write to a deployment");
  delete require.cache[require.resolve("../api/ingest.js")];
  const handler = require("../api/ingest.js");
  const remote = await new Promise(res => handler(
    { method: "POST", body: { channelId: "vb", posts: [] }, headers: {},
      socket: { remoteAddress: "203.0.113.9" } },
    { setHeader() {}, status(c) { this._c = c; return this; },
      json(p) { res({ status: this._c, body: p }); } }));
  check(remote.status === 401,
    "with no INGEST_KEY set, a non-loopback caller is turned away", String(remote.status));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  /* put the real store back exactly as it was */
  try { BACKUP === null ? fs.unlinkSync(STORE_FILE) : fs.writeFileSync(STORE_FILE, BACKUP, "utf8"); }
  catch (e) {}
  process.exit(fail ? 1 : 0);
})();
