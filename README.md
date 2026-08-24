# SportsFC — Daily check

**Did today's content reach every channel?** One dashboard, one button. It collects each channel's
recent posts, groups the ones that landed within minutes of each other into a single **drop**, and
shows — drop by drop — which channel got it, which is **missing** it, and which got it **late**.

There is nothing to configure in the browser. The channels it watches are fixed in code (the
SportsFC set: YouTube, Telegram, X, Facebook, Instagram and Viber, in Vietnamese and English), so
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
- **Double fallbacks where a channel is fragile** — X is read server-side, and falls back to the
  browser extension (the user's own IP) when a datacenter IP is refused; Viber is pushed in rather
  than read; anything pushed in to `/api/ingest` wins over reconstructing a feed
- **Light / dark**, respects `prefers-reduced-motion`

## Stack

Static HTML + CSS + vanilla JS, plus a handful of tiny Vercel serverless functions.
**No npm dependencies** — the API talks to Supabase over plain REST, and feeds are parsed directly.

| | |
|---|---|
| `index.html` | the whole dashboard + report UI |
| `api/collect.js` | `POST` read recent posts per channel (YouTube, Telegram, X, Viber) |
| `api/ingest.js` | `POST` accept posts pushed in for any channel; `GET` read them back |
| `api/notif.js` | `POST` a phone forwards one Viber notification, routed to its community |
| `api/report.js` | `GET`/`PUT` the shared daily-check report row |
| `api/data.js` | `GET` storage mode + settings (used to detect cloud vs local) |
| `ingest-store.js` | the pushed-in post store (Supabase row 2, or a local file) |
| `extension/` | Chrome extension for Facebook, Instagram, and X-as-fallback, via your own session |
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
   | `VIBER_WEBHOOK_SECRET` | for the Viber bot webhook | the `?s=` secret on `/api/viber-webhook` (the reliable, phone-free Viber path — a bot pushes posts here). Falls back to `INGEST_KEY` if unset. |
   | `TWITTERAPI_KEY` | recommended for X | the preferred way to read X server-side. A [twitterapi.io](https://twitterapi.io) key — X blocks datacenter IPs outright, so a deployment cannot read the page itself; this dedicated API can. Sent as the `X-API-Key` header. When set it is used first, and its answer is cached ~10 min so repeated checks cost one paid call, not one each. |
   | `X_SCRAPER` | optional fallback | only used when `TWITTERAPI_KEY` is not set — a scraping-proxy URL prefix (residential IP), e.g. `https://api.scraperapi.com/?api_key=KEY&url=`. The X profile URL is appended and fetched through it, used when a direct fetch comes back empty. |
   | `APIFY_TOKEN` | recommended for Facebook + Instagram | an [Apify](https://apify.com) API token. When set, Instagram and Facebook are read server-side via Apify's scrapers (`apify/instagram-post-scraper`, `apify/facebook-posts-scraper`) instead of the fragile public IG endpoint and the browser extension. Answers are cached ~15 min, and runs are bounded to recent posts to stay fast and cheap. Without it, IG uses its public endpoint and FB stays extension-only. |
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

Four tabs: **Summary** (the matrix and the problem list), **What went out** (each drop with its
thumbnail, a caption per language, and the exact minute it reached each channel), **Post log**
(every post with a second-level timestamp, language, type, views, likes, comments, length and a
link) and **Per channel**. Everything each platform will give up is pulled and shown — YouTube
even reveals whether a video is a Short, through the `/shorts/` form of its own link.

The **Sources** panel makes the two collectors explicit: it shows which has reported, and offers
**Merge N waiting** when an extension run is sitting unread. **Delete report** clears everything
so the next run starts clean.

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
| YouTube | the public RSS feed | nothing |
| Telegram | `t.me/s/<channel>`, the public preview | nothing |
| X (Twitter) | the profile page's own schema.org microdata | nothing |
| Instagram | the extension, using your logged-in session | Chrome + you signed in |
| Facebook | the extension, counting posts on the page | Chrome + you signed in |
| Viber | pushed in to `/api/ingest` by whatever publishes to it | a sender — see below |
| TikTok | — | not supported; refuses server requests |

**X needs no token and no login.** `x.com/<handle>` server-renders its recent posts as schema.org
microdata — one `<article itemType="…/SocialMediaPosting">` each, carrying an exact ISO timestamp,
the full text, the media, and the view / like / reply / repost counts. So X is read by the server
like YouTube and Telegram, gets real per-post instants, and is matched drop by drop rather than on
caption text. Two limits worth knowing: the render reaches back only a handful of posts (as few as
3, rarely more than about 10, with no way to page further), and reposts are skipped — a repost is
someone else's post on your page, and counting it would make a day of them read as delivered.

No token, no password, no API key, and no cookie is ever extracted or stored. The extension runs
in your own browser, on your own IP, with the session already there — the same thing that happens
when you click a link.

**X has a fallback for a datacenter IP.** The server reads X from a home IP fine, but X can refuse
the datacenter IP a Vercel deployment runs on. When the server-side read of an X channel fails, the
daily check asks the browser extension for that channel only — the extension fetches the same
logged-out profile microdata from the user's own IP (`credentials:"omit"`, so it gets the render
that carries the posts) and parses it with a copy of the server's parser. `test/x-ext.test.js` runs
the same fixtures through both parsers so the copy cannot drift. A healthy server-side run never
opens X twice.

**Facebook is matched on content, not on time**, and marked **≈** rather than ✓ to keep the two
apart. Its page HTML carries real timestamps but only for the newest post — three `creation_time`
markers in 2.5 MB — so they can prove a post was made and never that one was not, and trusting
them for absence produced false missing-post alarms. Captions are read off the rendered page
instead, and a drop counts as delivered when one of them says the same thing, within the channel's
own language. The match percentage and the post's banner are both shown, so the same artwork can
be checked across channels at a glance.

Two honest limits worth knowing before you trust a number:

- **Facebook is the fragile half.** It is read from a page that changes, so it will need attention.
  When it cannot be read the channel reports *unknown* and its cells stay blank — never a cross,
  because "we could not look" and "nothing was posted" are different facts.
- **Instagram's public endpoint is rate-limited per IP**, so the server-side attempt often fails.
  That is why Instagram goes through the extension, where it is reliable.

Check history is kept in localStorage first, and mirrored to a shared Supabase row (`api/report`)
when cloud storage is configured — so a run on one device is the same "today" every other device
sees. localStorage stays the fallback: nothing is lost offline or on an unconfigured deployment,
the report simply is not shared until the cloud is back. A stale write is refused (HTTP 409) rather
than clobbering a newer one, and the stored blob is shape-checked and size-capped server-side.

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
