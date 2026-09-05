/**
 * Which free, keyless route can read Instagram, X and TikTok — FROM WHEREVER THIS IS RUN?
 *
 * The answer depends entirely on the IP it runs from, which is the whole reason this is a script
 * and not a conclusion. Instagram and X both refuse Vercel's datacenter range outright (429 in
 * ~25 ms), TikTok is blocked by some consumer ISPs before the connection is even made, and a
 * GitHub Actions runner is a third network again. So the same probe is run from each place and the
 * results compared:
 *
 *     node tools/probe-sources.js            # from here
 *     .github/workflows/probe-sources.yml    # from a GitHub Actions runner, results committed back
 *
 * Everything probed is keyless and free — no token is read, none is needed, and nothing is spent.
 * Read-only: it fetches public pages and parses them, and writes nothing anywhere.
 */

const HANDLES = {
  instagram: process.env.PROBE_IG || "sportsfc.vn",
  x: process.env.PROBE_X || "Sportsfcvn",
  tiktok: process.env.PROBE_TT || "sportsfc.fans",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT = 12000;

async function get(url, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      redirect: "follow", signal: ctl.signal,
      headers: Object.assign({ "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, headers || {}),
    });
    const body = await r.text();
    return { status: r.status, body, ms: Date.now() - t0 };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e)));
    return { status: 0, body: "", ms: Date.now() - t0,
             error: aborted ? `timed out after ${TIMEOUT}ms` : String((e && e.message) || e) };
  } finally { clearTimeout(timer); }
}

/* ── parsers: each returns the posts it could actually extract ─────────────── */

function igPosts(body) {
  const out = [];
  /* the JSON profile shape */
  try {
    const user = JSON.parse(body).data.user;
    for (const e of ((user.edge_owner_to_timeline_media || {}).edges) || []) {
      const n = e.node || {};
      if (n.shortcode && n.taken_at_timestamp)
        out.push({ id: n.shortcode, ts: new Date(n.taken_at_timestamp * 1000).toISOString() });
    }
    if (out.length) return out;
  } catch (e) { /* not JSON — try the page */ }
  /* posts embedded in the logged-out page, in either of the two key spellings */
  const rx = /"(?:shortcode|code)"\s*:\s*"([\w-]{5,30})"[\s\S]{0,3000}?"taken_at(?:_timestamp)?"\s*:\s*(\d{9,11})/g;
  let m, guard = 0;
  while ((m = rx.exec(body)) !== null && guard++ < 80)
    out.push({ id: m[1], ts: new Date(Number(m[2]) * 1000).toISOString() });
  return out;
}

function xPosts(body, handle) {
  const out = [];
  /* The embed backend (cdn.syndication) answers with a Next.js page whose __NEXT_DATA__ carries
     the tweets in full. This is the shape that matters most: it is public by design, needs no key
     and no login, and it is what every "embed this timeline" widget on the web runs on. */
  const nd = body.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) {
    try {
      const seen = new Set();
      const walk = (v, d) => {
        if (!v || typeof v !== "object" || d > 14) return;
        if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
        if (v.id_str && v.created_at && !isNaN(new Date(v.created_at).getTime())) {
          const who = ((v.user && v.user.screen_name) || "").toLowerCase();
          if ((!handle || !who || who === String(handle).toLowerCase()) && !seen.has(v.id_str)) {
            seen.add(v.id_str);
            out.push({ id: v.id_str, ts: new Date(v.created_at).toISOString() });
          }
        }
        for (const k in v) walk(v[k], d + 1);
      };
      walk(JSON.parse(nd[1]), 0);
      if (out.length) return out;
    } catch (e) { /* fall through */ }
  }
  /* schema.org microdata, the shape api/collect.js reads */
  for (const part of body.split("<article ").slice(1)) {
    const id = (part.match(/data-tweet-id="(\d+)"/) || [])[1];
    const ts = (part.match(/content="([^"]+)"\s+itemProp="datePublished"/) || [])[1];
    if (id && ts && !isNaN(new Date(ts).getTime())) out.push({ id, ts: new Date(ts).toISOString() });
  }
  if (out.length) return out;
  /* a Nitter instance renders timeline-item blocks with a plain date attribute */
  const nit = /<span class="tweet-date"><a[^>]+title="([^"]+)"/g;
  let m, guard = 0;
  while ((m = nit.exec(body)) !== null && guard++ < 60) {
    const t = new Date(m[1].replace(/·/, "").replace(/\s+/g, " ").trim());
    if (!isNaN(t.getTime())) out.push({ id: "nitter-" + out.length, ts: t.toISOString() });
  }
  if (out.length) return out;
  /* an RSS feed (Nitter's /rss, and anything else RSS-shaped) */
  for (const chunk of body.split(/<item[\s>]/).slice(1)) {
    const d = (chunk.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1];
    const link = (chunk.match(/<link>([^<]+)<\/link>/) || [])[1] || "";
    const t = d ? new Date(d) : null;
    if (t && !isNaN(t.getTime())) out.push({ id: link || "rss-" + out.length, ts: t.toISOString() });
  }
  return out;
}

function ttPosts(body, handle) {
  let items = null;
  const re = body.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (re) {
    try {
      const d = JSON.parse(re[1]);
      const det = (d.__DEFAULT_SCOPE__ || {})["webapp.user-detail"] || {};
      items = det.itemList || (det.userInfo && det.userInfo.itemList) || null;
    } catch (e) {}
  }
  if (!items) {
    const sg = body.match(/<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (sg) { try { items = Object.values(JSON.parse(sg[1]).ItemModule || {}); } catch (e) {} }
  }
  if (!items) {
    /* a JSON api answer (item_list, or a mirror) */
    try { const j = JSON.parse(body); items = j.itemList || (j.data && (j.data.videos || j.data.list)) || null; }
    catch (e) {}
  }
  if (!items) {
    /* RSS, for the bridge-style routes */
    const out = [];
    for (const chunk of body.split(/<item[\s>]/).slice(1)) {
      const d = (chunk.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1];
      const t = d ? new Date(d) : null;
      if (t && !isNaN(t.getTime())) out.push({ id: "rss-" + out.length, ts: t.toISOString() });
    }
    return out;
  }
  return items.map(it => {
    const t = Number(it.createTime || it.create_time);
    const id = it.id || it.video_id || it.aweme_id;
    if (!id || !isFinite(t) || !t) return null;
    return { id: String(id), ts: new Date(t * 1000).toISOString() };
  }).filter(Boolean);
}

/* ── the candidate routes ──────────────────────────────────────────────────── */

/* Nitter is the one that could genuinely settle X: a self-hostable front end whose public
   instances serve a plain RSS feed of a profile, with no key and no login. They come and go, so
   several are tried and the report says which (if any) answered. */
const NITTER_HOSTS = [
  "nitter.net", "nitter.poast.org", "nitter.privacydev.net",
  "nitter.woodland.cafe", "xcancel.com", "nitter.tiekoetter.com",
];

function routes() {
  const ig = encodeURIComponent(HANDLES.instagram);
  const x = encodeURIComponent(HANDLES.x);
  const tt = encodeURIComponent(HANDLES.tiktok);
  const list = [];

  list.push(
    { platform: "instagram", name: "web_profile_info",
      url: `https://www.instagram.com/api/v1/users/web_profile_info/?username=${ig}`,
      headers: { "X-IG-App-ID": "936619743392459", Accept: "application/json" }, parse: igPosts },
    { platform: "instagram", name: "profile page (logged out)",
      url: `https://www.instagram.com/${ig}/`, parse: igPosts },
  );

  list.push(
    { platform: "x", name: "x.com profile (microdata)", url: `https://x.com/${x}`, parse: xPosts },
    { platform: "x", name: "cdn.syndication timeline",
      url: `https://cdn.syndication.twimg.com/srv/timeline-profile/screen-name/${x}`, parse: xPosts },
  );
  for (const h of NITTER_HOSTS)
    list.push({ platform: "x", name: `nitter ${h} (rss)`, url: `https://${h}/${x}/rss`, parse: xPosts });

  list.push(
    { platform: "tiktok", name: "profile page (embedded JSON)", url: `https://www.tiktok.com/@${tt}`, parse: ttPosts },
    { platform: "tiktok", name: "tikwm mirror",
      url: `https://www.tikwm.com/api/user/posts?unique_id=%40${tt}&count=20`, parse: ttPosts },
    { platform: "tiktok", name: "rsshub public", url: `https://rsshub.app/tiktok/user/@${tt}`, parse: ttPosts },
  );
  return list;
}

(async () => {
  const where = process.env.PROBE_WHERE || (process.env.GITHUB_ACTIONS ? "github-actions" : "local");
  const started = new Date().toISOString();
  const results = [];

  for (const r of routes()) {
    const res = await get(r.url, r.headers);
    let posts = [];
    try { posts = res.body ? r.parse(res.body, HANDLES[r.platform]) : []; }
    catch (e) { /* a parser throwing is a "no" like any other */ }
    posts.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const rec = {
      platform: r.platform, route: r.name, url: r.url,
      status: res.status, ms: res.ms, bytes: (res.body || "").length,
      posts: posts.length, newest: posts.length ? posts[0].ts : null,
    };
    if (res.error) rec.error = res.error;
    if (!posts.length && res.body) rec.head = res.body.slice(0, 160).replace(/\s+/g, " ");
    results.push(rec);
    console.log(`${posts.length ? "WORKS" : "  no "}  ${r.platform.padEnd(9)} ${r.name.padEnd(34)} ` +
                `status=${String(rec.status).padEnd(4)} posts=${String(rec.posts).padEnd(3)} ` +
                `${rec.newest ? "newest=" + rec.newest : (rec.error || "")}`);
  }

  const winners = results.filter(r => r.posts > 0);
  const byPlatform = {};
  for (const p of ["instagram", "x", "tiktok"])
    byPlatform[p] = winners.filter(w => w.platform === p).map(w => w.route);

  const out = { ranFrom: where, startedAt: started, handles: HANDLES, byPlatform, results };
  console.log("\n── verdict from " + where + " ──");
  for (const p of ["instagram", "x", "tiktok"])
    console.log(`  ${p.padEnd(10)} ${byPlatform[p].length ? "READABLE via " + byPlatform[p].join(", ") : "no free route worked"}`);

  const fs = require("fs");
  const path = process.env.PROBE_OUT || "";
  if (path) { fs.writeFileSync(path, JSON.stringify(out, null, 2)); console.log("\nwrote " + path); }
})();
