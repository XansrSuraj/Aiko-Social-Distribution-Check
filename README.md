# SportsFC — Daily check

**Did today's content reach every channel?** One dashboard, one button. It collects each channel's
recent posts, groups the ones that landed within minutes of each other into a single **drop**, and
shows — drop by drop — which channel got it, which is **missing** it, and which got it **late**.

There is nothing to configure in the browser. The channels it watches are fixed in code (the
SportsFC set: YouTube, Telegram, X, Facebook, Instagram, TikTok and Viber, in Vietnamese and English), so
the dashboard is exactly this: a hero, the channels it watches, and the report a run produces.
Adding a channel is a one-line code change, not a UI.

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
- **Everything server-side, cost on screen** — Facebook, Instagram, TikTok and X are read through
  Apify; every run reports its own billed cost and the report shows the credit left. The browser
  extension is only a fallback for a channel the server could not read; Viber is pushed in rather
  than read; anything pushed in to `/api/ingest` wins over reconstructing a feed
- **Light / dark**, respects `prefers-reduced-motion`

## Stack

Static HTML + CSS + vanilla JS, plus a handful of tiny Vercel serverless functions.
**One npm dependency** (`telegram`, lazy-loaded for the bot reader only) — the API talks to Supabase
and Apify over plain REST, and feeds are parsed directly.

| | |
|---|---|
| `index.html` | the whole dashboard + report UI |
| `api/collect.js` | `POST` read recent posts per channel — every platform, all server-side, with each Apify run's cost |
| `api/apify-usage.js` | `GET` Apify credit used / left this month and recent run costs (read-only) |
| `api/thumb.js` | `GET` a post's thumbnail passed through this site — Instagram's CDN forbids other sites from drawing its images; only the platforms' own CDNs are served |
| `api/ingest.js` | `POST` accept posts pushed in for any channel; `GET` read them back |
| `api/notif.js` | `POST` a phone forwards one Viber notification, routed to its community |
| `api/report.js` | `GET`/`PUT` the shared daily-check report row |
| `api/data.js` | `GET` storage mode + settings (used to detect cloud vs local) |
| `ingest-store.js` | the pushed-in post store (Supabase row 2, or a local file) |
| `extension/` | Chrome extension fallback for FB/IG/TikTok/X, only used when the server read of a channel fails |
| `test/` | `npm test` — stubbed handlers plus a live parser check |

Front-end libraries load from a CDN and are all **optional** — if they're blocked the app still
works with text fallbacks: [Lucide](https://lucide.dev) (icons),
[Simple Icons](https://simpleicons.org) (brand logos), [GSAP](https://gsap.com) (animation).
`prefers-reduced-motion` is respected.

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
   | `INGEST_KEY` | if Viber / any push is used | a long random string; sent as `x-ingest-key` |
   | `VIBER_COMMUNITIES` | optional | `Name=viber:handle` pairs, comma-separated (defaults to the two SportsFC communities) |
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
| Facebook | Apify `apify/facebook-reels-scraper` — the page's Reels tab | `APIFY_TOKEN` |
| Instagram | Apify `apify/instagram-post-scraper` | `APIFY_TOKEN` |
| TikTok | Apify `clockworks/tiktok-scraper` | `APIFY_TOKEN` |
| X (Twitter) | Apify `xquik/x-tweet-scraper`, then twitterapi.io, then the free profile page | `APIFY_TOKEN` |
| Telegram bot | a Telegram user session reading the bot's DMs | `TG_API_ID` / `TG_API_HASH` / `TG_SESSION` |
| Viber | pushed in to `/api/ingest` by whatever publishes to it | a sender — see below |

### Facebook, Instagram, TikTok and X are read through Apify

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

## Viber — pushed in, not read out

Viber is the one channel nothing can read. Its invite page names the community but carries none of
its posts; it ships no web client, so there is nothing for the extension to drive; and the desktop
app's message store is encrypted. Every way *in* is shut.

So the direction is reversed. Whatever already publishes to Viber pushes its posts here:

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"channelId":"<the channel id from the directory>","posts":[
        {"externalId":"2026-08-16-arsenal",
         "ts":"2026-08-16T07:48:00Z",
         "text":"Arsenal đối đầu Manchester City — ai sẽ giành chiến thắng?",
         "permalink":"https://sfc.my/r/d8wUU87R"}]}'
```

`ts` is the only required field. Give an `externalId` too and **re-sending the same list is
harmless** — a cron can push today's posts every hour and the count will not move. `views`,
`likes`, `comments`, `reposts`, `duration`, `kind` and `thumb` are all optional and flow straight
through to the report. Posts are kept for 14 days.

Read back what a channel holds with `GET /api/ingest?channelId=…`.

This is not a downgrade. It is the *more* dependable half of the report, because nothing Viber
changes can break it — Viber is not involved.

**Where to push from.** Anything that knows what went out:

- **The system that publishes.** Every post already carries a per-channel tracked link —
  `sfc.my/r/<token>` → `?utm_source=viber&…`. Whatever mints those tokens knows every Viber post
  and exactly when. That is the best source there is.
- **The phone.** A notification rule (MacroDroid, Tasker) that forwards the community's
  notifications to this endpoint. No credentials, no scraping.
- **By hand**, with the curl above.

**Security.** Set `INGEST_KEY` and send it as `x-ingest-key`. Without one set the endpoint answers
only to localhost — checked on the socket, not on a header, so it cannot be spoofed. Anything
deployed must set the key.

**What it will not do** is invent history: it knows only what was pushed. A channel nobody has
pushed for reports *unknown*, never a quiet day.

### Anything pushed in wins

The endpoint is not Viber-only. Push posts for *any* channel and they are used in place of reading
the platform, which is always a reconstruction — a feed, a rendered page, captions matched by
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

Ayrshare does **not** support Viber — its history covers bluesky, facebook, gmb, instagram,
linkedin, pinterest, reddit, snapchat, telegram, threads, tiktok, twitter and youtube — so whatever
posts to Viber still has to push here itself.

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
- `/api/ingest` and `/api/notif` require `INGEST_KEY` (header `x-ingest-key`, `?key=`, or a body
  field). Without a key set they answer only to localhost — checked on the socket, not a header, so
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
node dev-server.js          # http://localhost:3000 — no install, no login
npm test                    # stubbed checker branches + a live parser check
```

`dev-server.js` serves the page and routes `/api/*` to the handlers, which is all this app needs;
`npx vercel dev` also works but wants a CLI download, a login and a linked project first. Drop a
`.env` beside it with `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to load the real directory
read-only, or run without and the app keeps everything in the browser.

Opening `index.html` straight off disk still works too — it falls back to browser storage, and the
features that need a server (link check, daily check, cloud sync) say so.
