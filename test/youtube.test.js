/**
 * api/collect.js — the two YouTube readers, with a stubbed fetch.
 *
 * Written the day the public RSS feed (youtube.com/feeds/videos.xml) started answering 404 for
 * every channel id in existence. The daily check had been reading YouTube through that feed, so
 * both channels went blank on production and stayed blank; the code even had a retry loop built
 * on the belief that a 404 there was a soft rate-limit worth asking past, which by then only
 * turned one dead fetch into six.
 *
 * So the first thing this file guards is the simplest: nothing ever asks for that feed again.
 * The rest pins the behaviour of what replaced it — the official Data API when YOUTUBE_API_KEY is
 * set, the channel page plus InnerTube when it is not — and, above all, that a channel which
 * cannot be read says so rather than coming back empty. An empty channel in this report means
 * "nothing was posted", and that is an accusation the tool must never make on a failed fetch.
 *
 *   node test/youtube.test.js
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "api", "collect.js");
const realFetch = global.fetch;

let pass = 0, fail = 0;
const check = (good, label, extra) => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
};

const CHAN = "UCtesttesttesttesttest";
const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();

/* ── fixtures ───────────────────────────────────────────────────────────── */

/* A channel grid as YouTube ships it: ytInitialData inline, the InnerTube web key alongside, and
   a Short linked as /shorts/<id> — which is the only place either reader can learn that a video
   is a Short before it looks the video up. */
function chanPage(ids, shorts) {
  const items = ids.map(id => ({
    richItemRenderer: {
      content: shorts.indexOf(id) !== -1
        ? { shortsLockupViewModel: { onTap: { innertubeCommand: {
            commandMetadata: { webCommandMetadata: { url: "/shorts/" + id } },
            reelWatchEndpoint: { videoId: id } } } } }
        : { videoRenderer: { videoId: id } },
    },
  }));
  const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [
    { tabRenderer: { content: { richGridRenderer: { contents: items } } } }] } } };
  return '<!doctype html><script>ytcfg.set({"INNERTUBE_API_KEY":"TESTKEY",' +
         '"INNERTUBE_CLIENT_VERSION":"2.20260101.00.00"});</script>' +
         "<script>var ytInitialData = " + JSON.stringify(data) + ";</script>" +
         '<script>var meta = {"externalId":"' + CHAN + '"};</script>';
}

function player(id, ts, secs, owner) {
  return {
    microformat: { playerMicroformatRenderer: { uploadDate: ts } },
    videoDetails: {
      videoId: id, title: "Title " + id, shortDescription: "Desc " + id,
      lengthSeconds: String(secs), viewCount: "42", channelId: owner || CHAN,
      thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/" + id + "/hq.jpg" }] },
    },
  };
}

/* ── the stub ───────────────────────────────────────────────────────────── */

function load() { delete require.cache[require.resolve(MOD)]; return require(MOD); }

/* world = { videos:[id], shorts:[id], players:{id:obj|null}, api:{path:obj}, pageStatus }
   Returns what happened as well as the result, because several of these tests are about which
   requests were made rather than what came back. */
function run(world, channel, hours) {
  const seen = { rss: 0, players: [], watch: [], pages: [], api: [] };
  global.fetch = async (url, opts) => {
    url = String(url);
    const ok = (obj, status) => ({
      status: status === undefined ? 200 : status,
      text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)),
      json: async () => (typeof obj === "string" ? JSON.parse(obj) : obj),
    });

    if (/feeds\/videos\.xml/.test(url)) { seen.rss++; return ok("<html>404</html>", 404); }

    /* only the Data API lives here — youtubei.googleapis.com is a different thing entirely and
       must fall through to the InnerTube branch below */
    if (/googleapis\.com\/youtube\/v3/.test(url)) {
      const res = /\/channels\?/.test(url) ? "channels"
                : /\/playlistItems\?/.test(url) ? "playlistItems" : "videos";
      seen.api.push(res);
      const hit = world.api && world.api[res];
      if (!hit) return ok({ error: { message: "not stubbed" } }, 500);
      if (hit.status && hit.status !== 200) return ok(hit.body, hit.status);
      return ok(hit);
    }

    if (/youtubei\/v1\/player/.test(url)) {
      const host = /googleapis/.test(url) ? "googleapis" : "www";
      const vid = JSON.parse(opts.body).videoId;
      seen.players.push(host + ":" + vid);
      if ((world.block || []).indexOf(host) !== -1) return ok("", 403);
      const p = world.players[vid];
      return p ? ok(p) : ok("", 404);
    }

    if (/\/watch\?v=/.test(url)) {
      const vid = url.split("v=")[1];
      seen.watch.push(vid);
      if ((world.block || []).indexOf("watch") !== -1) return ok("", 403);
      const p = world.players[vid];
      if (!p) return ok("", 404);
      /* the real page inlines the very object InnerTube would have returned */
      return ok("<script>var ytInitialPlayerResponse = " + JSON.stringify(p) + ";</script>");
    }

    const tab = /\/shorts$/.test(url) ? "shorts" : "videos";
    seen.pages.push(tab);
    if (world.pageStatus && world.pageStatus !== 200) return ok("", world.pageStatus);
    const ids = tab === "shorts" ? world.shortsTab || [] : world.videos || [];
    if (!ids.length && tab === "shorts") return ok("", 404);
    return ok(chanPage(ids, world.shorts || []));
  };

  const handler = load();
  return new Promise(r => {
    handler({ method: "POST", body: { channels: [channel], hours: hours || 24 } }, {
      setHeader() {}, status() { return this; },
      json: p => r({ res: p.results[0], seen }),
    });
  }).finally(() => { global.fetch = realFetch; });
}

const YT = { id: "y", platform: "youtube", url: "https://youtube.com/@somechannel" };
const BY_ID = { id: "y", platform: "youtube", url: "https://youtube.com/channel/" + CHAN };

(async () => {
  delete process.env.YOUTUBE_API_KEY;

  /* ── the regression this file exists for ── */
  {
    const { res, seen } = await run({
      videos: ["vid00000001"], shorts: [],
      players: { vid00000001: player("vid00000001", hoursAgo(2), 600) },
    }, YT);
    check(seen.rss === 0, "the retired RSS feed is never requested", "rss fetches=" + seen.rss);
    check(res.ok === true && res.posts.length === 1,
      "a channel with one recent video reads back one post", "ok=" + res.ok + " posts=" + res.posts.length);
    check(res.source === "youtube-web", "source names the page reader", res.source);
  }

  /* ── shape of what comes back ── */
  {
    const ts = hoursAgo(3);
    const { res } = await run({
      videos: ["vid00000001", "vid00000002"], shorts: ["vid00000002"],
      players: {
        vid00000001: player("vid00000001", ts, 600),
        vid00000002: player("vid00000002", hoursAgo(4), 42),
      },
    }, YT);
    const long = res.posts.find(p => p.externalId === "vid00000001");
    const shrt = res.posts.find(p => p.externalId === "vid00000002");
    check(long && long.ts === new Date(ts).toISOString(),
      "the timestamp is the exact upload instant, not a relative guess", long && long.ts);
    check(long && long.kind === "video" && shrt && shrt.kind === "short",
      "Shorts are told apart from long-form, which the old RSS feed could not do",
      long && shrt ? long.kind + " / " + shrt.kind : "missing");
    check(shrt && shrt.permalink === "https://www.youtube.com/shorts/vid00000002",
      "a Short links to its /shorts/ url", shrt && shrt.permalink);
    check(long && long.views === 42 && long.title === "Title vid00000001" &&
          /Desc vid00000001/.test(long.text),
      "title, description and view count all come through");
    check(res.resolved && res.resolved.ytChannelId === CHAN,
      "the channel id is resolved off the page and handed back for caching",
      res.resolved && res.resolved.ytChannelId);
  }

  /* ── a duration alone must not turn a short video into a Short ── */
  {
    const { res } = await run({
      videos: ["vid00000001"], shorts: [],
      players: { vid00000001: player("vid00000001", hoursAgo(1), 100) },
    }, YT);
    check(res.posts[0] && res.posts[0].kind === "short",
      "a sub-3-minute video the grid said nothing about is treated as a Short",
      res.posts[0] && res.posts[0].kind);
  }

  /* ── never a false empty ── */
  {
    const { res } = await run({ videos: ["vid00000001"], players: {}, }, YT);
    check(res.ok === false && /unknown, not empty/.test(res.note),
      "a channel whose videos will not describe themselves says unknown, not empty", res.note);
  }
  {
    const { res } = await run({ videos: [], players: {}, pageStatus: 503 }, YT);
    check(res.ok === false && /unknown, not empty/.test(res.note),
      "a channel page that will not load says unknown, not empty", res.note);
  }
  {
    const { res } = await run({ videos: ["vid00000001"], players: {
      vid00000001: { videoDetails: { videoId: "vid00000001", channelId: CHAN } },   // no date
    } }, YT);
    check(res.ok === false && /unknown, not empty/.test(res.note),
      "a video with no date counts as unread, not as undated", res.note);
  }

  /* ── the read is bounded, but not so eagerly that a pin can truncate it ── */
  {
    const ids = [], players = {};
    for (let i = 1; i <= 24; i++) {
      const id = "vid" + String(i).padStart(8, "0");
      ids.push(id);
      players[id] = player(id, hoursAgo(i <= 3 ? 2 : 500), 600);
    }
    const { res, seen } = await run({ videos: ids, shorts: [], players }, YT);
    check(res.posts.length === 3, "only the videos inside the window are reported",
      "posts=" + res.posts.length);
    check(seen.players.length <= 12,
      "the walk stops once a whole round lands outside the window",
      "lookups=" + seen.players.length + " of " + ids.length);
  }
  {
    /* a pinned video sits first and is old by design; stopping at the first old video would hide
       everything posted since it was pinned */
    const players = {
      vid00000001: player("vid00000001", hoursAgo(900), 600),   // the pin
      vid00000002: player("vid00000002", hoursAgo(2), 600),
    };
    const { res } = await run({ videos: ["vid00000001", "vid00000002"], shorts: [], players }, YT);
    check(res.posts.length === 1 && res.posts[0].externalId === "vid00000002",
      "a pinned older video at the top does not hide the real post behind it",
      "posts=" + res.posts.map(p => p.externalId).join(","));
  }

  /* ── both tabs, because Videos and Shorts are separate grids ── */
  {
    const { res, seen } = await run({
      videos: ["vid00000001"], shortsTab: ["vid00000002"], shorts: ["vid00000002"],
      players: {
        vid00000001: player("vid00000001", hoursAgo(2), 600),
        vid00000002: player("vid00000002", hoursAgo(3), 30),
      },
    }, YT);
    check(seen.pages.indexOf("videos") !== -1 && seen.pages.indexOf("shorts") !== -1,
      "both the Videos and the Shorts tab are read", seen.pages.join("+"));
    check(res.posts.length === 2,
      "a day of Shorts and a long-form video are both counted", "posts=" + res.posts.length);
  }

  /* ── a video the channel did not post must not be credited to it ── */
  {
    const { res } = await run({
      videos: ["vid00000001", "vid00000002"], shorts: [],
      players: {
        vid00000001: player("vid00000001", hoursAgo(2), 600),
        vid00000002: player("vid00000002", hoursAgo(2), 600, "UCsomebodyelseentirely"),
      },
    }, BY_ID);
    check(res.posts.length === 1 && res.posts[0].externalId === "vid00000001",
      "a recommended video from another channel is not counted as this channel's post",
      "posts=" + res.posts.map(p => p.externalId).join(","));
  }

  /* ── the routes to one video's metadata, in the order they are tried ──
     Production found this the hard way: InnerTube on www.youtube.com answers from a home
     connection and refuses from Vercel, which left the first version of this reader loading the
     channel page fine and then failing on every video. So the route matters, and each step down
     the chain is pinned here. */
  {
    const world = () => ({
      videos: ["vid00000001"], shorts: [],
      players: { vid00000001: player("vid00000001", hoursAgo(2), 600) },
    });

    const plain = await run(world(), YT);
    check(plain.res.ok === true && plain.seen.players[0] === "www:vid00000001" &&
          plain.seen.watch.length === 0,
      "InnerTube on www is tried first and nothing else is asked when it answers",
      plain.seen.players.join(","));

    const noWww = await run(Object.assign(world(), { block: ["www"] }), YT);
    check(noWww.res.ok === true && noWww.res.posts.length === 1 &&
          noWww.seen.players.indexOf("googleapis:vid00000001") !== -1,
      "when www refuses — which is what Vercel sees — the API host is tried next",
      "ok=" + noWww.res.ok + " routes=" + noWww.seen.players.join(","));
    check(/googleapis/.test(noWww.res.note),
      "and the note names the route that answered, so this is diagnosable from the report",
      noWww.res.note);

    const pageOnly = await run(Object.assign(world(), { block: ["www", "googleapis"] }), YT);
    check(pageOnly.res.ok === true && pageOnly.res.posts.length === 1 &&
          pageOnly.seen.watch.length === 1,
      "with both InnerTube hosts refusing, the watch page still carries the video",
      "ok=" + pageOnly.res.ok + " watch=" + pageOnly.seen.watch.length);
    check(pageOnly.res.posts[0] && pageOnly.res.posts[0].ts &&
          pageOnly.res.posts[0].kind === "video",
      "and the watch page yields the same shape as InnerTube would have",
      pageOnly.res.posts[0] && pageOnly.res.posts[0].kind + " " + pageOnly.res.posts[0].ts);

    const none = await run(Object.assign(world(), { block: ["www", "googleapis", "watch"] }), YT);
    check(none.res.ok === false && /unknown, not empty/.test(none.res.note),
      "every route refusing is still unknown, never an empty channel", none.res.note);
    check(/googleapis/.test(none.res.note) && /watch page/.test(none.res.note),
      "and the note lists what was tried and how each refused", none.res.note);
  }

  /* ── the official API, when a key is set ── */
  const API_WORLD = {
    videos: ["vid00000001"], shorts: [],
    players: { vid00000001: player("vid00000001", hoursAgo(2), 600) },
    api: {
      channels: { items: [{ id: CHAN }] },
      playlistItems: { items: [{
        contentDetails: { videoId: "apivid00001", videoPublishedAt: hoursAgo(5) },
        snippet: { title: "From the API", description: "A description",
                   thumbnails: { high: { url: "https://i.ytimg.com/x.jpg" } } },
      }] },
      videos: { items: [{ id: "apivid00001",
        contentDetails: { duration: "PT45S" },
        statistics: { viewCount: "500", likeCount: "9" } }] },
    },
  };
  {
    process.env.YOUTUBE_API_KEY = "test-key";
    const { res, seen } = await run(API_WORLD, YT);
    check(res.ok === true && res.source === "youtube-api" && res.posts.length === 1,
      "with a key set, the official API is the reader", res.source + " posts=" + res.posts.length);
    check(res.posts[0] && res.posts[0].kind === "short" && res.posts[0].views === 500 &&
          res.posts[0].likes === 9,
      "the API path fills in duration-derived kind and both counters",
      res.posts[0] && res.posts[0].kind + " views=" + res.posts[0].views + " likes=" + res.posts[0].likes);
    check(seen.players.length === 0,
      "the page reader is not run when the API answered", "player calls=" + seen.players.length);
    check(seen.api.length === 3, "one channel costs three quota units", seen.api.join("+"));
  }
  {
    /* the whole reason reader 2 is kept: a key that stops working is a note, not an outage */
    process.env.YOUTUBE_API_KEY = "test-key";
    const dead = Object.assign({}, API_WORLD, { api: { channels: { status: 403, body: {
      error: { message: "quotaExceeded", errors: [{ reason: "quotaExceeded" }] } } } } });
    const { res } = await run(dead, YT);
    check(res.ok === true && res.source === "youtube-web" && res.posts.length === 1,
      "an over-quota key falls back to the page reader instead of failing the channel",
      res.source + " ok=" + res.ok);
    check(/quota is used up/.test(res.note),
      "and the report says why the API was not used", res.note);
    delete process.env.YOUTUBE_API_KEY;
  }
  {
    /* both readers down is the one case that must fail, and it must still not read as empty */
    process.env.YOUTUBE_API_KEY = "test-key";
    const { res } = await run({ videos: [], players: {}, pageStatus: 503,
      api: { channels: { status: 403, body: { error: { message: "bad key", errors: [{ reason: "keyInvalid" }] } } } },
    }, YT);
    check(res.ok === false && /unknown, not empty/.test(res.note) && /refused the key/.test(res.note),
      "with both readers down the note names both failures and still says unknown", res.note);
    delete process.env.YOUTUBE_API_KEY;
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
