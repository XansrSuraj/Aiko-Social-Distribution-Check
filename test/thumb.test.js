/**
 * api/thumb.js — the thumbnail pass-through. Pinned: it is not an open proxy (other hosts, http,
 * credentials in the URL, a redirect off the list, and non-image answers are all refused), and a
 * real image from a platform CDN is served from this origin with a day's cache.
 *
 *   node test/thumb.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "thumb.js");
const realFetch = global.fetch;
let pass = 0, fail = 0;
const check = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };

function call(u, answer) {
  const asked = [];
  global.fetch = async (url) => { asked.push(String(url)); return answer(String(url)); };
  const handler = require(MOD);
  return new Promise(resolve => {
    const headers = {};
    const res = { statusCode: 200, setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
                  end: body => resolve({ status: res.statusCode, headers, body, asked }) };
    handler({ method: "GET", query: { u } }, res);
  }).finally(() => { global.fetch = realFetch; });
}
const img = (url, type, bytes) => ({ status: 200, url, headers: { get: k => ({ "content-type": type || "image/jpeg", "content-length": String(bytes || 3) })[k.toLowerCase()] || null },
                                      arrayBuffer: async () => new Uint8Array(bytes || 3).buffer });

(async () => {
  console.log("── only the platforms' own image CDNs");
  const IG = "https://scontent-yyz1-1.cdninstagram.com/v/t51/a.jpg?stp=x&oh=1";
  let r = await call(IG, u => img(u));
  check(r.status === 200 && r.headers["content-type"] === "image/jpeg" && /max-age=86400/.test(r.headers["cache-control"]) &&
        Buffer.isBuffer(r.body) && r.asked[0] === IG, "an Instagram thumbnail is fetched and served from here, cached a day");

  for (const [u, why] of [
    ["https://evil.example.com/a.jpg", "another host"],
    ["https://cdninstagram.com.evil.com/a.jpg", "a look-alike host"],
    ["http://scontent.cdninstagram.com/a.jpg", "plain http"],
    ["https://user:pw@scontent.cdninstagram.com/a.jpg", "credentials in the address"],
    ["https://scontent.cdninstagram.com:8443/a.jpg", "an odd port"],
    ["not a url", "garbage"],
  ]) {
    r = await call(u, u2 => img(u2));
    check(r.status === 400 && r.asked.length === 0, "refused without fetching: " + why, String(r.status));
  }

  console.log("\n── what comes back is checked too");
  r = await call(IG, () => img("https://evil.example.com/x.jpg"));
  check(r.status !== 200, "a redirect off the list is not passed on", String(r.status));
  r = await call(IG, u => img(u, "text/html"));
  check(r.status === 415, "a non-image answer is not passed on", String(r.status));
  r = await call(IG, u => img(u, "image/jpeg", 5 * 1024 * 1024));
  check(r.status === 413, "an oversized image is refused", String(r.status));
  r = await call(IG, () => ({ status: 403, url: IG, headers: { get: () => "text/plain" } }));
  check(r.status === 404, "an expired signed link reads as not available", String(r.status));

  for (const u of ["https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg", "https://i.ytimg.com/vi/x/maxresdefault.jpg",
                   "https://cdn4.telesco.pe/file/abc", "https://p16-common-sign.tiktokcdn.com/tos/a.jpeg",
                   "https://scontent.fosu2-2.fna.fbcdn.net/v/t15/a.jpg"]) {
    r = await call(u, u2 => img(u2));
    check(r.status === 200, "served: " + new URL(u).hostname);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
