/**
 * api/notif.js — the door a phone forwards a raw Viber notification through.
 *
 * Unlike /api/ingest, the caller here knows nothing about the directory — a notification-forwarding
 * app on a phone reports only the app, the title and the words. So this endpoint does the routing:
 * it matches the community from the title and files the post under the right channel. The cases
 * below pin the judgement calls that make it safe to leave running unattended:
 *
 *   · a bundle ("3 new messages") is not a post and must not be filed as one
 *   · a non-Viber notification is declined, not stored
 *   · the same notification arriving twice must not double the count
 *   · a title for a community we do not watch is ignored, not guessed at
 *
 *   node test/notif.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STORE_FILE = path.join(ROOT, ".ingest.json");
const BACKUP = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, "utf8") : null;

function fresh() {
  try { fs.unlinkSync(STORE_FILE); } catch (e) {}
  delete require.cache[require.resolve("../ingest-store.js")];
  delete require.cache[require.resolve("../api/notif.js")];
  return require("../ingest-store.js");
}

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

/* drive the handler like Vercel would, from a loopback socket (no key set → localhost allowed) */
function call(body) {
  delete require.cache[require.resolve("../api/notif.js")];
  const handler = require("../api/notif.js");
  return new Promise(resolve => {
    handler({ method: "POST", body, headers: {}, socket: { remoteAddress: "127.0.0.1" } },
            { setHeader() {}, status(c) { this._c = c; return this; },
              json(p) { resolve({ status: this._c || 200, body: p }); } });
  });
}

(async () => {
  const store = fresh();
  const now = Date.now();

  console.log("── a community post is routed by its title");
  let r = await call({ app: "Viber", title: "Sportsfc.vn",
    text: "Arsenal đối đầu Manchester City", postedAt: String(now) });
  check(r.body.ok && r.body.channelId === "viber:sportsfc.vn" && r.body.added === 1,
    "a vn post lands under viber:sportsfc.vn", JSON.stringify(r.body));
  r = await call({ app: "Viber", title: "Sportsfc.fans",
    text: "Arsenal vs Man City", postedAt: String(now) });
  check(r.body.channelId === "viber:sportsfc.fans" && r.body.added === 1,
    "and a fans post under viber:sportsfc.fans", JSON.stringify(r.body));

  const vn = await store.getPosts("viber:sportsfc.vn");
  check(vn.length === 1 && /Arsenal đối đầu/.test(vn[0].text),
    "the words round-trip so the language check can read them", JSON.stringify(vn[0]));
  check(!isNaN(new Date(vn[0].ts).getTime()), "and the timestamp is real", vn[0].ts);

  console.log("\n── the same notification twice does not double-count");
  r = await call({ app: "Viber", title: "Sportsfc.vn",
    text: "Arsenal đối đầu Manchester City", postedAt: String(now) });
  check(r.body.added === 0 && r.body.total === 1, "a re-notify collapses", JSON.stringify(r.body));

  console.log("\n── what must never be filed as a post");
  r = await call({ app: "Viber", title: "Sportsfc.vn", text: "3 new messages" });
  check(r.body.ignored && /bundle/.test(r.body.ignored),
    "a bundle notification is skipped", JSON.stringify(r.body));
  r = await call({ app: "Viber", title: "Sportsfc.vn", text: "" });
  check(r.body.ignored, "an empty notification is skipped", JSON.stringify(r.body));
  r = await call({ app: "WhatsApp", title: "Mom", text: "call me" });
  check(r.body.ignored && /not a Viber/.test(r.body.ignored),
    "a non-Viber notification is declined", JSON.stringify(r.body));
  r = await call({ app: "Viber", title: "Some Other Group", text: "hello everyone" });
  check(r.body.ignored && /no watched community/.test(r.body.ignored),
    "a community we do not watch is ignored, not guessed", JSON.stringify(r.body));

  console.log("\n── titles Viber varies still match");
  r = await call({ app: "Rakuten Viber", title: "Sportsfc.vn: Admin",
    text: "Sevilla vs Vallecano", postedAt: String(now - 3600e3) });
  check(r.body.channelId === "viber:sportsfc.vn" && r.body.added === 1,
    "a 'name: sender' title still routes to the right community", JSON.stringify(r.body));

  console.log("\n── nothing watched leaks between communities");
  check((await store.getPosts("viber:sportsfc.vn")).length === 2 &&
        (await store.getPosts("viber:sportsfc.fans")).length === 1,
    "each community holds only its own posts");

  /* Different forwarder apps name their fields differently. Message Mirror sends message_from /
     message_body / message_date; the endpoint must route those exactly like title / text /
     postedAt so the phone app is never the thing that has to change. */
  console.log("\n── a forwarder's own field names (message_from/body/date) still route");
  r = await call({ app: "com.viber.voip", message_from: "Sportsfc.fans: Admin",
    message_body: "Nashville vs Messi", message_date: String(now) });
  check(r.body.channelId === "viber:sportsfc.fans" && r.body.added === 1,
    "message_from/message_body land under the right community", JSON.stringify(r.body));

  /* A forwarder that cannot set headers embeds the key in the payload body — that must authorise
     just like the header does, and a wrong body key must still be refused. */
  console.log("\n── the key may ride in the body when headers are not an option");
  const KEY = "k-secret-123";
  process.env.INGEST_KEY = KEY;
  function callKeyed(body, headers) {
    delete require.cache[require.resolve("../api/notif.js")];
    const handler = require("../api/notif.js");
    return new Promise(resolve => {
      handler({ method: "POST", body, headers: headers || {}, socket: { remoteAddress: "203.0.113.7" } },
              { setHeader() {}, status(c) { this._c = c; return this; },
                json(p) { resolve({ status: this._c || 200, body: p }); } });
    });
  }
  r = await callKeyed({ app: "com.viber.voip", title: "Sportsfc.vn: Admin", text: "keyed via body",
    key: KEY, postedAt: String(now) });
  check(r.status === 200 && r.body.added === 1, "a correct key in the body authorises", JSON.stringify(r.body));
  r = await callKeyed({ app: "com.viber.voip", title: "Sportsfc.vn: Admin", text: "x", key: "wrong" });
  check(r.status === 401, "a wrong body key is refused", String(r.status));
  r = await callKeyed({ app: "com.viber.voip", title: "Sportsfc.vn: Admin", text: "y" }, { "x-ingest-key": KEY });
  check(r.status === 200, "and the header path still works when a key is set", String(r.status));
  delete process.env.INGEST_KEY;
  delete require.cache[require.resolve("../api/notif.js")];

  console.log(`\n  ${pass} passed, ${fail} failed`);
  try { BACKUP === null ? fs.unlinkSync(STORE_FILE) : fs.writeFileSync(STORE_FILE, BACKUP, "utf8"); }
  catch (e) {}
  process.exit(fail ? 1 : 0);
})();
