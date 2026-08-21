/**
 * api/check.js — every branch, with a stubbed fetch.
 *
 * Checking this against the live platforms does not work: Instagram rate-limits after a few
 * runs, and a rate-limited reply (429) has to be reported completely differently from a dead
 * profile (404) — so a test that depends on which one you happen to get proves nothing. The
 * stub pins each platform's answer and asserts the mapping.
 *
 *   node test/check.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "check.js");
const realFetch = global.fetch;

function load() { delete require.cache[require.resolve(MOD)]; return require(MOD); }

function callWith(fetchStub, url) {
  global.fetch = fetchStub;
  const handler = load();
  return new Promise(resolve => {
    handler({ method: "POST", body: { urls: [url] } }, {
      setHeader() {}, status() { return this; }, json(p) { resolve(p.results[0]); },
    });
  }).finally(() => { global.fetch = realFetch; });
}

const answer = (status, body) => async () => ({ status, text: async () => body });

const IG_LIVE = '{"data":{"user":{"username":"someone","edge_owner_to_timeline_media":{"count":1,"edges":[]}}}}';
const IG_SHELL = "<!DOCTYPE html><html>…610 KB of JavaScript…</html>";
const TG_LIVE = '<div data-post="chan/12"><time datetime="2026-07-31T13:01:07+00:00"></time></div>';
const YT_LIVE = 'var x = {"externalId":"UCOn89EhBv7qavXWvXFKw1FA","other":1};';

/* [ name, url, stub, predicate ] */
const CASES = [
  ["instagram · dead profile", "https://instagram.com/whoever", answer(404, "not found"),
    r => r.ok === false && r.verified === true],
  ["instagram · live profile", "https://instagram.com/whoever", answer(200, IG_LIVE),
    r => r.ok === true && r.verified === true],
  ["instagram · rate limited", "https://instagram.com/whoever", answer(429, "{}"),
    r => r.ok === true && r.verified === false],
  /* the shell is the whole reason `verified` exists: 200, looks fine, proves nothing */
  ["instagram · 200 but shell", "https://instagram.com/whoever", answer(200, IG_SHELL),
    r => r.ok === true && r.verified === false],
  ["instagram · /p/ is not a profile", "https://instagram.com/p/Cabc123/", answer(200, IG_LIVE),
    r => r.verified === true],

  ["telegram · public channel", "https://t.me/chan", answer(200, TG_LIVE),
    r => r.ok === true && r.verified === true],
  ["telegram · no preview", "https://t.me/chan", answer(200, "<html>nothing here</html>"),
    r => r.ok === true && r.verified === false],
  ["telegram · gone", "https://t.me/chan", answer(404, ""),
    r => r.ok === false && r.verified === true],

  ["youtube · real channel", "https://youtube.com/@chan", answer(200, YT_LIVE),
    r => r.ok === true && r.verified === true],
  ["youtube · missing channel", "https://youtube.com/@chan", answer(404, ""),
    r => r.ok === false && r.verified === true],
  ["youtube · watch url falls through", "https://youtube.com/watch?v=abc", answer(200, ""),
    r => r.ok === true],

  /* Viber is the one "chat app" link that answers honestly: the invite page carries the real
     community name, and a broken invite code falls back to a generic landing page — which is a
     404 wearing a 200. */
  ["viber · live community", "https://invite.viber.com/?g2=abc",
    answer(200, '<meta property="og:title" content="Sportsfc.vn on Viber">'),
    r => r.ok === true && r.verified === true],
  ["viber · dead invite", "https://invite.viber.com/?g2=bad",
    answer(200, '<meta property="og:title" content="Community Landing Page on Viber">'),
    r => r.ok === false && r.verified === true],
  ["viber · no details", "https://invite.viber.com/?g2=x", answer(200, "<html></html>"),
    r => r.ok === true && r.verified === false],

  ["plain site · 200", "https://example.com/", answer(200, "hi"),
    r => r.ok === true && r.verified === true],
  ["plain site · 500", "https://example.com/", answer(500, ""),
    r => r.ok === false && r.verified === false],
];

(async () => {
  let pass = 0, fail = 0;

  for (const [name, url, stub, ok] of CASES) {
    const r = await callWith(stub, url);
    const good = ok(r);
    good ? pass++ : fail++;
    console.log(`  ${good ? "pass" : "FAIL"}  ${name.padEnd(34)} ok=${String(r.ok).padEnd(5)} ` +
                `verified=${String(r.verified).padEnd(5)} ${r.note ? '"' + r.note + '"' : ""}`);
  }

  /* Facebook, TikTok and X must not be probed at all — whatever they answer says nothing about
     the link (a dead X handle serves the same 200 shell as a live one), and the skipped requests
     are seconds off a full check. */
  global.fetch = async () => { throw new Error("must not be called"); };
  const handler = load();
  for (const url of ["https://facebook.com/somepage", "https://tiktok.com/@someone", "https://x.com/someone"]) {
    const r = await new Promise(res => handler({ method: "POST", body: { urls: [url] } },
      { setHeader() {}, status() { return this; }, json(p) { res(p.results[0]); } }));
    const good = r.ok === true && r.verified === false && r.ms === 0;
    good ? pass++ : fail++;
    console.log(`  ${good ? "pass" : "FAIL"}  ${("no probe · " + new URL(url).hostname).padEnd(34)} ` +
                `ok=${String(r.ok).padEnd(5)} verified=${String(r.verified).padEnd(5)} ms=${r.ms}`);
  }
  global.fetch = realFetch;

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
