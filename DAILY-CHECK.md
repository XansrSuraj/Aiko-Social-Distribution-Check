# Daily Check — how it works, what it costs, and what is still open

The end-to-end record of the daily check: what it answers, how each channel is read, what one check
actually costs (measured, not estimated), how the current design was arrived at, and what is still
broken. For env vars and deploy steps see [README.md](README.md); for a hands-on walkthrough see
[TESTING.md](TESTING.md).

---

## 1. What it answers

SportsFC publishes the same content — match previews, highlight reels, stat graphics — to
**13 channels** in **2 languages** (Vietnamese and English):

| Platform | Vietnamese | English |
|---|---|---|
| YouTube | `@SportsFC-vn` | `@sportsfc_fans` |
| Telegram | `sportsfc_vn` | `sportsfc_fans` |
| Facebook | `sportsfc.vn` | `Sportsfc.fans` |
| Instagram | `sportsfc.vn` | `sportsfc.fans` |
| X | `Sportsfcvn` | — |
| TikTok | `@sportsfc.vn` | — |
| Telegram bot | `@SportsfcBot` | — |
| Viber | Sportsfc.vn | Sportsfc.fans |

Every day the check answers one question:

> **Did today's content actually reach every channel — in the right language?**

The rule everything is built around: **a false "it worked" is worse than a false alarm, and both are
worse than admitting "we don't know."** Each channel, for each drop, lands on delivered (✓), missing
(✗), late, wrong language (⚠), or **unknown** — never a guess presented as a measurement.

## 2. How each channel is read — all server-side, one button

Pressing **Run everything** sends every channel to the server (`POST /api/collect`). Nobody's laptop,
browser or login is involved.

| Channel | Read by | Cost |
|---|---|---|
| YouTube ×2 | the official YouTube Data API | free |
| Telegram ×2 | the public `t.me/s/<channel>` preview | free |
| Facebook ×2 | Apify `apify/facebook-reels-scraper` — the page's Reels tab | paid per reel |
| Instagram ×2 | Apify `apify/instagram-post-scraper` | paid per post |
| TikTok | Apify `clockworks/tiktok-scraper` | paid per video |
| X | Apify `xquik/x-tweet-scraper` | paid per post |
| Telegram bot | a Telegram user session reading the bot's DMs | free — **session currently dead, §6** |
| Viber ×2 | **pushed in** by a phone forwarding its notifications | free — Viber cannot be read at all |

**Why Apify for four platforms.** Facebook, Instagram, TikTok and X all refuse requests from a
server's (datacenter) IP address — Instagram answers in about 25 ms with HTTP 429, X serves an empty
page, TikTok serves a profile with no videos, Facebook puts posts behind a login. Apify runs the
scraper on its own infrastructure and hands back the posts. §5 records the free alternatives that
were tried first and why each failed.

**The browser extension is now only a fallback.** If a server read fails (credit used up, token
missing), the dashboard asks the Chrome extension for just that channel, if it is installed. A
healthy run never needs it.

### Design rules for the Apify reads

- **Newest 6 posts per channel** (`APIFY_MAX_POSTS`, default 6) — about two days at SportsFC's ~3
  posts per channel per day, which covers "today" and "yesterday". This number sets the price of a
  check; cost scales almost linearly with it.
- **No paid add-ons.** No date filters (on Facebook and TikTok they are billed extra, and an empty
  filtered answer cannot tell "posted nothing" from "the scraper saw nothing"), no video/cover
  downloads, no caption transcription, no proxy-country choice.
- **Every run has a spending cap** (`maxTotalChargeUsd`, twice the expected charge — or the actor's
  own minimum, $0.50 for TikTok; still only a ceiling, billing stays per video).
- **Memory is pinned per actor** (TikTok 2 GB, Facebook 1 GB, Instagram 512 MB, X 256 MB). The free
  plan refuses runs past 8 GB in total at once; the actors' defaults add up to more than that, so a
  full check used to have runs refused for no visible reason. Pinned, a full check needs 5.25 GB.
- **15-minute cache.** Pressing the button again within 15 minutes costs nothing.
- **Each slow channel gets its own request**, so one slow scraper can never time out the others.
- **A profile the scraper cannot see reports why** (e.g. "Restricted profile") as *unknown*,
  never as an empty channel.
- **Each press's bill is settled before it is believed.** Apify fills a run's bill in some time
  after the run stops, and not in one step; the dashboard re-asks for the press's runs until every
  bill has settled, and only then shows it as the price of a check.

## 3. What one check costs — measured on 2026-10-02

Every figure below is Apify's own settled bill from the run record, measured on production; the
account's usage moved by the same totals.

| Channel | What is billed | Cost |
|---|---|---|
| Facebook `sportsfc.vn` | 6 reels × $0.005 | $0.0300 |
| Facebook `Sportsfc.fans` | 6 reels × $0.005 | $0.0300 |
| TikTok `@sportsfc.vn` | $0.001 start + 6 videos × $0.0037 | $0.0232 |
| Instagram `sportsfc.vn` | 6 posts × $0.0017 | $0.0102 |
| Instagram `sportsfc.fans` | 1 "restricted profile" item × $0.0017 | $0.0017 |
| X `Sportsfcvn` | 6 posts × $0.00015 + a little compute | $0.0010 |
| YouTube, Telegram, Viber, bot | — | $0 |
| **One full daily check** | | **$0.096** |

Once Instagram `sportsfc.fans` becomes readable (§6) it costs the same as `sportsfc.vn`, and a check
becomes **$0.105**. Facebook is about two-thirds of the bill.

**What that means for the free plan ($5 per monthly cycle):**

| | Checks per $5 | At one check a day |
|---|---|---|
| Today ($0.096) | ~52 | ~$2.98 a month — fits |
| Instagram EN fixed ($0.105) | ~47 | ~$3.24 a month — fits |
| Two checks a day | — | ~$6–6.50 a month — does **not** fit |

**Credit right now (2 Oct, evening):** $3.65 used of $5 → **$1.35 left → about 14 more checks**
before the cycle resets on **24 Oct**. At one a day that runs out around 16 Oct; until the reset,
Facebook/Instagram/TikTok/X would then fall back to the extension. Most of this cycle's spend went
before this redesign: the old setup asked for 25 posts per channel with paid date filters (Facebook
alone was $0.176 per run, Instagram $0.0675), roughly five times today's price per check.

**Where to see it.** The report's Sources panel shows the last press's cost, the credit left and how
many checks it still buys. `GET /api/apify-usage` returns the same as JSON — read-only, it never
starts a run.

## 4. What the test run returned

All 10 readable channels answered. The same drops line up across platforms at the same minutes
(times in ICT), with Vietnamese captions on the VN channels and English on the fans channels:

| Drop | X | IG vn | TikTok | FB vn | FB fans |
|---|---|---|---|---|---|
| France vs Italy | 2 Oct 19:53 | 19:53 | 19:53 | 19:52 | 19:50 |
| 3 matches, 3 predictions | — | 18:03 | 18:01 | 18:00 | 18:02 |
| Belgium vs Türkiye | 12:02 | 12:03 | 12:01 | 12:00 | 12:02 |
| Vietnam vs Pakistan | 07:02 | 07:01 | 07:01 | 07:00 | 07:03 |
| Portugal without Ronaldo | 1 Oct 22:02 | 22:03 | 22:03 | 22:01 | 22:00 |

(Facebook's columns are from the Reels-tab reader — see §5 for why the first Facebook reader was
replaced.)

YouTube (36 and 37 posts in the 8-day window) and Telegram (20 each) read in under 4 seconds. The
slowest Apify channel took 49 s; the whole check about 50 s.

## 5. How we got here — the free attempt, and why it was dropped

**Goal (late September):** read Facebook, Instagram and TikTok on the server **for free**, with no
paid scraper and no laptop.

**What was tried, and what happened:**

- **Platforms' own endpoints from the server** — refused outright (above). A probe endpoint,
  `/api/probe-free`, still exists to re-measure this from Vercel.
- **Free mirrors** (tikwm, RSSHub instances, imginn) — all behind Cloudflare challenges from a
  datacenter IP.
- **A real headless browser on Vercel** (Playwright + `@sparticuz/chromium-min`) — it worked from a
  desk, and was built, fixed (Node 22 pin, ESM-only import) and **deployed successfully**. On Vercel
  itself it never produced a read: every attempt fell through to Apify. (An earlier diagnosis that
  "the deploy was not going live" was wrong — checking a static file proved each commit was live; the
  browser tier was simply failing there.) It was removed on 2 Oct along with its two dependencies.

**Conclusion:** there is no free server-side route for Facebook, Instagram, TikTok or X today. The
choice is a small, predictable Apify bill (§3) or someone's browser running the extension every day —
and the second defeats the point of an automatic check.

**Bugs found on the way to the current design:**

- The TikTok channel pointed at `@sportsfc.fans`, which **no longer exists on TikTok** (TikTok answers
  status 10221 — the same as for a made-up handle). Every TikTok read since was Apify billing one
  "profile does not exist" item. The live account is **`@sportsfc.vn`** — confirmed by its captions
  and `sfc.my` links matching the other VN channels drop for drop — and the channel now points there.
- The TikTok scraper refuses any run capped below $0.50; the cap now meets each actor's minimum.
- **The first Facebook reader skipped a whole day.** `apify/facebook-posts-scraper`, asked twice 27
  minutes apart for a page's newest 6 posts, returned the newest 6 the first time and the *next* 6
  the second — every post from today missing, so the report showed no Facebook data. It had also
  made Facebook `sportsfc.vn` look as if it had stopped posting (it had not: the Reels tab shows its
  four reels that day). Facebook is now read from the page's **Reels tab**
  (`apify/facebook-reels-scraper`, same $0.005 per item, no start fee), which lists reels newest
  first. That reader returns exact times but **no captions**, so Facebook — matched on caption text
  until now — is matched on time when read this way, like every other channel.
- **The cost on screen read low.** Apify fills a run's bill in some time after the run stops, and
  not in one step: a press that cost $0.098 was shown as $0.045 (Facebook read as $0.001, X as
  $0.00007), and "≈ 31 more checks" was computed from it. A run's figure is now believed only when
  it covers every charged event at that event's known price; until then the dashboard shows it as
  still settling and asks Apify again (20 s, 40 s, … up to ~5 minutes) for the exact sum.

## 6. Still open

| Issue | Effect | Fix |
|---|---|---|
| **Instagram `sportsfc.fans` is age-restricted** | Instagram shows it only to logged-in adults, so no logged-out reader (Apify included) can see it. Reads *unknown*; costs $0.0017 per check. | In that account's Instagram settings, remove the minimum-age restriction. Nothing to change here — it starts working on the next check. |
| **Facebook has no captions** | The Reels tab gives times but not text, so Facebook gets no language check, and a Facebook post that is not a reel (a photo) would read as missing. | None needed while SportsFC posts reels; the extension still reads captions if ever needed. |
| **Telegram bot session is dead** | `401 AUTH_KEY_UNREGISTERED` | Re-run `tg-login.js` and update `TG_SESSION` on Vercel. |
| **Viber** | Depends on the phone forwarder being on. | Out of scope for this change. |
| **twitterapi.io balance is empty** (HTTP 402) | None now — it is only X's second route if Apify fails. | Top up or remove `TWITTERAPI_KEY`. |
| **No English X or TikTok channel** | Only the VN accounts are in the directory. | If they exist, add them to `SPORTSFC` in `index.html`: about +$0.001 (X) or +$0.023 (TikTok) per check. |
| **Credit runs out ~17 Oct** at one check a day | Apify channels fall back to the extension until 24 Oct. | Add Apify credit, or check less often until the reset. |

## 7. The reconciliation engine, briefly (unchanged by all of this)

The part that judges the collected posts was already mature and was not touched:

- **Drop** — one piece of content, as it should appear on every channel at about the same time.
- **Coverage window** — the stretch of time a channel's read actually reached; a ✗ is only ever given
  inside it, never for a drop the read could not have seen.
- **Content match** — Facebook read by the extension (captions, unreliable times) is matched on what
  a post says rather than when, marked ≈. Read from its Reels tab (exact times, no captions) it is
  matched on time like every other channel.
- **Timefold** — Viber's notifications are folded into drops by time, since there is no caption.
- **Expected count** — inferred from the channel that received the most; nobody types it in.
- **Language** — the caption's language is checked against the channel's; a Vietnamese reel on an
  English channel counts as delivered but is flagged.

The full logic is `reconcile()` in `index.html`, commented with the real incidents that shaped each
rule.
