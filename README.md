# Daily check — SportsFC and MatchPulse

**Did today's content reach every channel?** One dashboard, one button. It collects each channel's
recent posts, groups the ones that landed within minutes of each other into a single **drop**, and
shows — drop by drop — which channel got it, which is **missing** it, and which got it **late**.

There is nothing to configure in the browser. The channels it watches are fixed in code (the
SportsFC set: YouTube, Telegram, X, Facebook, Instagram and TikTok — Vietnamese, English and
Brazilian Portuguese), so the site is exactly this: an overview of the channels it watches, and the
report a run produces.
Adding a channel is a one-line code change, not a UI.

**Two brands, one site.** The switch in the nav moves between them; each has its own channels,
overview, report and saved history, and never mixes with the other:

| Brand | Pages | Channels | Regions (each judged on its own drops) |
|---|---|---|---|
| SportsFC | `#/`, `#/report` | 14 | Vietnam & English · Brazil |
| MatchPulse | `#/matchpulse`, `#/matchpulse/report` | 9 | Hindi · English |

A brand is one entry in `BRANDS` in `src/engine/engine.js` (its channels, regions and default
timezone) plus one line in `BRANDS` in `src/app/core.jsx` (its name and URL). Its report is
saved under its own localStorage key and its own shared row (`api/report?brand=…` — SportsFC row 3,
MatchPulse row 4).

---

## Features

- **One daily check across every channel** — press **Run daily check** and each channel's recent
  posts are pulled, aligned into drops, and reconciled. See [TESTING.md](TESTING.md)
- **Missing vs late vs unknown are kept apart** — a real miss is a cross; a drop that arrived hours
  behind the rest is marked late with the gap named; a channel that could not be read reports
  *unknown*, never a false "nothing was posted"
- **Inferred expected count** — whichever channel got the most sets the target, so nothing has to
  be typed in
- **Language check** — a Vietnamese caption on the English channel is delivered, counted, and looks
  healthy; reading the caption is the only thing that catches it
- **Shared report** — with cloud storage on, a run on one device is the same "today" every other
  device sees (a Supabase row via `api/report`); localStorage is the fallback, so an offline moment
  or an unconfigured deployment loses nothing
- **Everything server-side, cost on screen** — Facebook, Instagram and TikTok are read free from
  each platform's own public page, with Apify as the fallback (X always via Apify); every Apify run
  reports its own billed cost and the report shows the credit left. Anything pushed in to
  `/api/ingest` wins over reconstructing a feed
- **Every region on one screen** — Vietnam & English and Brazil are collected in one press and
  each judged on its own schedule of drops
- **Responsive** from a phone to a wide desk: the matrix scrolls inside its card with the channel
  column pinned, the post log turns into cards, the nav folds into a menu. Respects
  `prefers-reduced-motion`
- **Viber was removed on 2026-10-03** — its only source was a phone forwarding notifications, which
  could not prove whether a post went out, so it is no longer watched or shown

## Stack

A **React 18** single-page app built with **Vite**, plus a handful of small Vercel serverless
functions. The API has one npm dependency (`telegram`, lazy-loaded for the bot reader only) — it
talks to Supabase and Apify over plain REST and parses feeds directly. The front end adds React,
[Lucide](https://lucide.dev) icons and [Simple Icons](https://simpleicons.org) brand marks, all
bundled — nothing loads from a CDN except the fonts.

The look follows [aiko.inc](https://aiko.inc): white paper, near-black ink and one signature red
(`#a6171b` / `#e31f24`); Inter Tight for display type, Inter for reading, IBM Plex for labels and
numbers; motion on aiko's curve `cubic-bezier(.22,1,.36,1)` — staggered fade-up reveals, a dark
hero with a pulsing core and data chips that draw in on connector lines, a scrolling channel marquee.
The tokens are at the top of `src/styles.css`.

| | |
|---|---|
| `index.html`, `src/main.jsx` | the app's entry; a two-route hash router (`#/` overview, `#/report`) |
| `src/engine/engine.js` | everything that is not markup — collecting, `reconcile()`, the report store — as `createEngine()`; the tests load it straight from this file |
| `src/app/` | the React glue: the engine provider, nav/footer, the report view-model, copy-as-text |
| `src/pages/` | `Home.jsx` (the overview) and `Report.jsx`, with one file per tab under `report/` |
| `src/styles.css`, `src/report.css` | the design system and the report's styles |
| `public/fm-deliveries.html` | the FM Deliveries dashboard, served as-is |
| `legacy-index.html` | the pre-React page, kept for reference only — not served |
| `api/collect.js` | `POST` read recent posts per channel — every platform, all server-side, with each Apify run's cost |
| `api/apify-usage.js` | `GET` Apify credit used / left this month and recent run costs (read-only) |
| `api/thumb.js` | `GET` a post's thumbnail passed through this site — Instagram's CDN forbids other sites from drawing its images; only the platforms' own CDNs are served |
| `api/ingest.js` | `POST` accept posts pushed in for any channel; `GET` read them back |
| `api/report.js` | `GET`/`PUT` the shared daily-check report row |
| `api/health.js` | `GET` which readers have their credentials (presence only); also hosts the free-route probe |
| `api/data.js` | `GET` storage mode + settings (used to detect cloud vs local) |
| `ingest-store.js` | the pushed-in post store (Supabase row 2, or a local file) |
| `extension/` | Chrome extension fallback for FB/IG/TikTok/X, only used when the server read of a channel fails |
| `test/` | `npm test` — stubbed handlers plus a live parser check |

---

## Deploy

### 1 · Push to GitHub

```bash
git remote add origin https://github.com/<USERNAME>/org-hub.git
git push -u origin main
```

### 2 · Import into Vercel

[vercel.com](https://vercel.com) → **Add New → Project** → import the repo →
Framework preset **Other**, build command and output directory **empty** → **Deploy**.

It is live at this point and already usable — but data is still per-browser until step 3.

### 3 · Turn on shared storage (Supabase, free)

1. [supabase.com](https://supabase.com) → **New project**
2. **SQL Editor** → run:

   ```sql
   create table if not exists orghub_state (
     id int primary key,
     data jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );

   -- lock the table down: no policies means no public/anon access at all.
   -- only the server-side service_role key (which bypasses RLS) can read or write.
   alter table orghub_state enable row level security;
   ```

   The rows the app uses (1 = settings, 2 = pushed-in posts, 3 = the shared report) are all created
   on first write via upsert, so no seed row is needed.

3. **Project Settings → API** → copy the **Project URL** and the **`service_role`** key
4. Vercel → **Project → Settings → Environment Variables** → add:

   | Name | Required? | Value |
   |---|---|---|
   | `SUPABASE_URL` | for a shared report | `https://xxxx.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | for a shared report | the `service_role` key |
   | `INGEST_KEY` | if posts are pushed in | a long random string; sent as `x-ingest-key` |
   | `APIFY_TOKEN` | for Facebook, Instagram, TikTok, X | an [Apify](https://apify.com) API token. These four platforms refuse a server's own requests, so they are read through Apify scrapers (`apify/facebook-reels-scraper`, `apify/instagram-post-scraper`, `clockworks/tiktok-scraper`, `xquik/x-tweet-scraper`). Billed per post returned — about **$0.10 per full daily check** (see [DAILY-CHECK.md](DAILY-CHECK.md) §3). Without it, Facebook and TikTok go to the extension, Instagram tries its public endpoint and X its free page read. |
   | `APIFY_MAX_POSTS` | optional | newest posts each Apify run asks for, per channel (default `6`, about two days). The one knob that sets the price of a check. |
   | `TWITTERAPI_KEY` | optional | a [twitterapi.io](https://twitterapi.io) key — X's second route, tried only if the Apify read fails. |
   | `X_SCRAPER` | optional | a scraping-proxy URL prefix (residential IP) for X's last, free route, e.g. `https://api.scraperapi.com/?api_key=KEY&url=`. |
   | `ADMIN_PASSWORD` | optional | only if you want app-level gating on the report write on top of platform protection |

5. **Deployments → ⋯ → Redeploy**

The header badge flips from **Local only** to **Cloud**. Without the Supabase vars the dashboard
still runs — the report just stays in whichever browser ran it.

> **Keep the deployment private.** There is no login in this tool by design. Put
> [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection) (password or SSO)
> on the project — it protects the dashboard *and* every `/api` route at the platform layer, which
> is the right place to keep an internal tool private.

### Custom domain

Vercel → Settings → Domains → add your domain → copy the two DNS records into your registrar.
HTTPS is automatic.

## Daily check

Press **Run daily check** on the dashboard to see whether the **last 24 hours** of content reached
every channel. Full walkthrough in [TESTING.md](TESTING.md).

The report is a matrix: a row per channel, a column per drop, and one glyph per cell.

| | |
|---|---|
| ✓ | posted |
| ✓ (dashed) | posted, but hours behind the rest of that drop |
| ✗ | nothing in this drop — a real miss |
| ⚠ | posted, but the caption is in the wrong language |
| · | no data for this channel |

Posts within a few minutes of each other are treated as one **drop** — the same reel arriving on
each channel — so the report says *which* content is missing *where*, not just that a count is off.
A total alone would flag "YouTube 2, Telegram 1" without telling you which of the two.

**A drop that runs late is folded back into the one it belongs to.** Grouping on time assumes the
same content reaches every channel within minutes, which is usually true; when it is not — one clip
went out on eight channels at 12:42 and on X at 14:43 — the day would otherwise report five drops
where four things were published, cross out X on the first, cross out eight channels on the second,
and push a Facebook page to 5/4 as its captions answered both halves. So two slots are merged when
their channel sets are disjoint (a channel cannot be late to a drop it already made) *and* the posts
agree on both wording and the tokens that identify them. That second test needs more than the
caption score: these captions are templated, so two entirely different fixtures score 0.79 against
each other, above the 0.6 a caption match needs — while the hashtags, percentages and proper nouns
that name the fixture score 1.00 for the same content and at most 0.67 for different content. The
delay is then reported as **late**, with how far behind, rather than silently disappearing.

**Expected count is inferred.** Whichever channel got the most sets the target, so nothing has to
be entered. It is a floor: if every channel missed the same drop, no one saw it. Only measured
evidence counts — a number read off a Facebook page is a suggestion until you confirm it, because
one misread page must not be able to decide every other channel's verdict.

Five tabs: **Summary** (the matrix and the problem list), **What went out** (each drop with its
thumbnail, a caption per language, and the exact minute it reached each channel), **Content**
(a card for every post every reader brought back — picture, whole caption, hashtags, views,
likes, comments, shares, saves, the `sfc.my` content link and the drop it belongs to, filterable
by platform and language), **Post log**
(every post with a second-level timestamp, language, type, views, likes, comments, length and a
link) and **Per channel**. Everything each platform will give up is pulled and shown — YouTube
even reveals whether a video is a Short, through the `/shorts/` form of its own link.

The **Sources** panel splits the channels into the free ones and the Apify ones, shows which have
reported, and — for Apify — what the last press cost, the credit left this month and how many more
checks that buys. It offers **Merge N waiting** when an extension run is sitting unread. **Delete
report** clears everything so the next run starts clean.

Four things get flagged:

- **missing** — a channel came up short, with the drop it missed named
- **late** — the drop did reach this channel, hours after everyone else, with the gap named
- **over** — more posts than the per-period maximum (default 4), for the day something fires twice
- **language** — the caption's language does not match the channel's. This is the failure a count
  can never catch: a Vietnamese reel on the English channel is delivered, counted, and looks
  perfectly healthy. Detection reads the caption — `đ ă ơ ư` appear in no other Latin-script
  language, so one of them settles it, while tone marks alone are not enough (an English caption
  saying "Andrés Iniesta" would otherwise be flagged). Checked against 40 real captions from both
  channels: 40 right, 0 wrong.

**Which channels can be read, and what each one needs:**

| Platform | How | Needs |
|---|---|---|
| YouTube | the official Data API, or the channel page if no key is set | a free `YOUTUBE_API_KEY` (the page read is refused from Vercel) |
| Telegram | `t.me/s/<channel>`, the public preview | nothing |
| Facebook | **free**: the page's own Reels tab (`/reels/`) — Apify Reels scraper as fallback | nothing (`APIFY_TOKEN` for the fallback) |
| Instagram | **free**: the profile's embed widget (`/embed/`) — Apify as fallback | nothing (`APIFY_TOKEN` for the fallback) |
| TikTok | **free**: TikTok's creator embed widget (`/embed/@user`) — Apify as fallback | nothing (`APIFY_TOKEN` for the fallback) |
| X (Twitter) | Apify `xquik/x-tweet-scraper`, then twitterapi.io, then the free profile page | `APIFY_TOKEN` |
| Telegram bot | a Telegram user session reading the bot's DMs | `TG_API_ID` / `TG_API_HASH` / `TG_SESSION` |

### Free first (since 2026-10-03), Apify as the fallback

Facebook, Instagram and TikTok each serve one page that is public by design — a page's Reels tab,
and the feed widgets other websites embed — with the recent posts embedded as JSON: exact time,
caption, id, cover image. `api/collect.js` reads those first, with a plain `fetch()` (no browser,
no login, no Apify). Tested from a datacenter and a home connection: 5 of 5 rounds matched Apify's
posts to the minute. A free read is only believed when it looks right (posts found, real times,
newest within 4 days); otherwise that channel falls through to Apify, so a platform changing its page
costs a few cents for that channel, never a blank report. `FREE_READERS=off` switches them off.
X has no such page and stays on Apify (~$0.001 a check); Instagram `sportsfc.fans` (18+ restricted)
falls back to Apify and the extension. The full experiment is in the `free-scraper-lab` branch of
the backup repo.

### Apify (fallback, and X)

All four refuse requests from a server's IP (Instagram answers a datacenter IP with HTTP 429 in about
25 ms, X serves an empty page, TikTok a profile with no videos, Facebook a login wall). Free routes —
mirrors, the platforms' embeds, and a real headless browser running on Vercel — were each built or
measured and none produced a read from the server; [DAILY-CHECK.md](DAILY-CHECK.md) §5 has the
record. So these four are read by [Apify](https://apify.com) scrapers, which bill per post returned:

- **Newest `APIFY_MAX_POSTS` posts per channel** (default 6 — about two days). No date filters,
  downloads, transcription or proxy add-ons: each is billed extra, and an empty date-filtered answer
  cannot tell "posted nothing" from "the scraper saw nothing".
- **Exact cost on every result.** Runs start asynchronously so the run id is known; each result
  carries Apify's own billed figure for its run (`cost.usd`), and the response totals them
  (`apifyCostUsd`). Apify fills a bill in some time after the run stops, so a figure that has not
  settled yet says so (`cost.settled: false`) and the dashboard asks again for the exact sum
  (`GET /api/apify-usage?runs=…`). `GET /api/apify-usage` alone shows the month's credit.
- **Bounded spend.** Every run has a `maxTotalChargeUsd` cap (twice the expected charge, or the
  actor's own minimum — $0.50 for TikTok) and a time budget; a run past it is aborted and whatever it
  already returned is used.
- **Fits the free plan.** Memory is pinned per actor (TikTok 2 GB, Facebook 1 GB, Instagram 512 MB, X 256 MB)
  so a full check stays under the free plan's 8 GB concurrent limit; a start refused for memory is
  retried while the other runs finish.
- **Cached 15 minutes** — a second press inside that window costs nothing.
- **A profile the scraper cannot see says why** — Instagram's "Restricted profile" for an
  age-restricted account comes back as the channel's note, and the channel reads *unknown*.

Measured on 2026-10-02, one full check of the SportsFC set costs **$0.096** (Facebook $0.030 per page,
TikTok $0.023, Instagram $0.010 per readable account, X $0.001) — about 52 checks per $5 of free
monthly credit. [DAILY-CHECK.md](DAILY-CHECK.md) §3 has the breakdown.

**Facebook is read from the page's Reels tab**, not its post timeline: the post-timeline scraper,
asked for a page's newest posts, once skipped a whole day of them. The Reels tab lists reels newest
first with exact times but no captions — so this assumes SportsFC publishes to Facebook as reels.

**The extension is a fallback, not a requirement.** When the server read of a Facebook, Instagram,
TikTok or X channel fails (credit used up, no token), **Run everything** asks the Chrome extension
for that channel only, if it is installed. It reads from the user's own browser and IP. No token,
password or cookie is ever extracted or stored — the same thing that happens when you click a link.

**How Facebook is matched depends on who read it.** Read from the Reels tab (the server), it has
exact times and a complete newest-first list, and is matched on time like every other channel.
Read by the extension, it has captions but no dependable times — those can prove a post was made
and never that one was not — so it is matched on content and marked **≈** rather than ✓: a drop
counts as delivered when one of the page's captions says the same thing, within the channel's own
language. The same reel read both ways is counted once (paired by the reel id in its link). When a
channel cannot be read it reports *unknown* and its cells stay blank, never a cross, because "we
could not look" and "nothing was posted" are different facts.

Check history is kept in localStorage first, and mirrored to a shared Supabase row (`api/report`)
when cloud storage is configured — so a run on one device is the same "today" every other device
sees. localStorage stays the fallback: nothing is lost offline or on an unconfigured deployment,
the report simply is not shared until the cloud is back. A stale write is refused (HTTP 409) rather
than clobbering a newer one, and the stored blob is shape-checked and size-capped server-side.

## FM Deliveries dashboard

`fm-deliveries.html` (linked from the header — **FM Deliveries**) is a separate, read-only viewer
over the FM Deliveries feed: a different CMS's record of every card the content team published to
the Football Module, including the ones that never went out. It shares this site's visual style but
none of its code or data — it does not touch the daily check, its state, or `orghub_state` at all.

It talks to the feed through two proxy routes (`api/fm-deliveries.js`, `api/fm-deliveries-meta.js`,
sharing `fm-deliveries-client.js`) so the feed's `x-api-key` stays server-side per environment,
never shipped to the browser:

| Name | Required for | Value |
|---|---|---|
| `FM_DELIVERIES_API_HOST_DEV` / `_TEST` / `_PROD` | that environment's tab | the feed's base host, e.g. `https://cms-dev.example.com` |
| `FM_DELIVERIES_API_KEY_DEV` / `_TEST` / `_PROD` | that environment's tab | the `x-api-key` the CMS team gives you for that environment |

An environment with either value unset just shows "not configured" on that tab — the other
environments, and the rest of the site, are unaffected. The dashboard only ever issues `GET`
requests; there is no write path to the CMS anywhere in this feature.

Dashboard features: an env switcher (dev/test/prod, each visually distinct so prod is never
mistaken for a test), live auto-refresh (polling — the feed itself has no push/websocket channel),
today/yesterday/tomorrow/7d/30d window presets on top of the feed's own `since`/`until`/`timeField`,
every filter the feed supports (channel, language, state, outcome, cardId/setId/matchId), KPI tiles
for delivered/failed+skipped/pending/unconfirmed, and a per-card raw-JSON view so a field the UI
doesn't specially render is still visible — the feed's own stability promise is that fields are only
ever added, never removed, so the dashboard should never need to hide new data. Filters are reflected
in the URL so a specific filtered view is shareable.

## Pushing posts in

Any channel can be pushed in instead of read: whatever published the post sends it here, and it is
used in place of reading the platform.

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" -H "x-ingest-key: $INGEST_KEY" \
  -d '{"channelId":"<the channel id>","posts":[
        {"externalId":"2026-08-16-arsenal","ts":"2026-08-16T07:48:00Z",
         "text":"Arsenal đối đầu Manchester City — ai sẽ giành chiến thắng?"}]}'
```

`ts` is the only required field. Give an `externalId` too and **re-sending the same list is
harmless**. Posts are kept for 14 days; read back with `GET /api/ingest?channelId=…`. A channel
nobody has pushed for is simply read the normal way.

**Security.** Set `INGEST_KEY` and send it as `x-ingest-key`. Without one set the endpoint answers
only to localhost — checked on the socket, not on a header, so it cannot be spoofed.

### Anything pushed in wins

Push posts for a channel and they are used in place of reading the platform, which is always a reconstruction — a feed, a rendered page, captions matched by
similarity. Whatever published the post does not reconstruct anything; it knows.

So a channel that pushes gets: Facebook off caption-matching (`≈`) and onto real instants, so a
drop it received can no longer read as missing because its page would not render. Instagram
without Chrome open. TikTok, which nothing can read, readable. A channel that pushes nothing is
untouched and still read the old way.

### From Ayrshare

If posts go out through [Ayrshare](https://www.ayrshare.com), `tools/ayrshare-sync.js` reads what
it actually published and pushes it here:

```bash
export AYRSHARE_API_KEY=…          # and AYRSHARE_PROFILE_KEY if the account has profiles
node tools/ayrshare-sync.js --days 2 --dry     # show what it would push
node tools/ayrshare-sync.js --days 2           # push it
```

It matches each published post back to a channel by the `postUrl` Ayrshare reports, so two Pages on
the same network are told apart, and it names anything published to an account that is not in the
directory rather than dropping it silently. Run it on a schedule and Facebook, Instagram and TikTok
stop depending on the extension.


## Security notes

- The Supabase `service_role` key, `INGEST_KEY` and `ADMIN_PASSWORD` are **server-side only** —
  never sent to the browser, never committed. Keep them in Vercel env vars.
- Same for the three `FM_DELIVERIES_API_KEY_*` values — the browser only ever calls this site's own
  `/api/fm-deliveries*` proxy, which attaches the real key server-side. The feed's own guide notes
  captions, asset URLs and the publishing user's email are in its responses, so treat the dashboard
  like the rest of this internal tool: fine behind Deployment Protection, not for public exposure.
- There is no login in the dashboard by design. Keep the deployment private with **Vercel
  Deployment Protection** (Settings → Deployment Protection) — it covers the dashboard and every
  `/api` route at the platform layer, which is where an internal tool should be gated.
- `/api/ingest` requires `INGEST_KEY` (header `x-ingest-key`, `?key=`, or a body
  field). Without a key set it answers only to localhost — checked on the socket, not a header, so
  it cannot be spoofed. Anything deployed must set the key.
- The shared report (`/api/report`) is non-sensitive operational data; its write is shape-checked
  and size-capped, refuses a stale write with HTTP 409, and can additionally be gated by
  `ADMIN_PASSWORD` if you set one.
- `noindex, nofollow` is set, so search engines skip it.
- No credential, cookie or token is ever extracted or stored — every read the extension makes uses
  the session already in the browser, on the user's own IP.

## Free-tier caveat

Supabase pauses a free project after ~7 days with no activity; open the Supabase dashboard to
resume it. A directory in daily use never hits this. If it becomes annoying,
[Upstash Redis](https://upstash.com) has no pause and the same REST-only integration style.

Apify's free plan gives $5 of credit per monthly cycle. At about $0.10 per full check that is one
check a day with room to spare, but not two. When the credit runs out, the Apify channels report
*unknown* (and fall back to the extension, if installed) until the cycle resets — never a false
"nothing posted". The report's Sources panel shows the credit left.

## Local development

```bash
npm install
npm run dev                 # the React app with hot reload — http://localhost:5173
npm run api                 # in a second terminal: the /api handlers on :3000 (Vite proxies /api to it)
npm run build               # the production build, into dist/
npm test                    # every suite, plus a live parser check
```

`npm run build` then `node dev-server.js` serves the built app from `dist/` and routes `/api/*` to
the handlers on one port — the closest thing to production without a Vercel login. Drop a `.env`
beside it with `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to read the real shared report, or run
without and the app keeps everything in the browser.

Vercel builds the same way: `vercel.json` sets `npm run build` and `dist/`, and the functions in
`api/` deploy beside it unchanged.
