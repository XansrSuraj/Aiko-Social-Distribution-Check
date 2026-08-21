# Testing the daily check — locally, end to end

Everything here runs on `feature/daily-check`. Nothing in this branch writes to the shared
database, and nothing is deployed until you merge it yourself.

```bash
git checkout feature/daily-check
```

---

## What this feature does

Answers one question: **did the last 24 hours of content reach every channel, in the right
language?**

It collects the recent post list per channel, groups posts that landed within a few minutes of
each other into one *drop* (the same reel arriving everywhere), and lays the result out as a
matrix — a row per channel, a column per drop:

| | |
|---|---|
| ✓ | posted |
| ✗ | nothing in this drop — a real miss |
| ⚠ | posted, but the caption is in the wrong language |
| · | no data for this channel |

Two collectors, because no single one can reach everything:

| Source | Channels | Needs |
|---|---|---|
| `api/collect` | YouTube, Telegram | nothing |
| `extension/` | Facebook, Instagram | you signed into them in Chrome, as normal |

The **Sources** panel at the top shows which of the two has reported and how many channels each
covers, and offers **Merge N waiting** when an extension run is sitting unread. So the flow is
explicit: Collect → run the extension → Merge → read the report.

Four tabs:

| Tab | What it shows |
|---|---|
| **Summary** | the matrix, the problem list, and hand-entered counts |
| **What went out** | each drop, its thumbnail, a caption per language, and the exact minute it reached each channel |
| **Post log** | every post with a second-level timestamp, language, type, views, likes, comments, length and a link |
| **Per channel** | one card per channel with its own posts and totals |

The window, timezone, drop width and per-period maximum are all selectable in the toolbar.
24 hours is the default; the collector always fetches wider than the window on screen, so
widening to 7 days needs no re-collect.

**Delete report** clears everything collected so the next run starts clean.

---

## Part 1 · The server collector (no extension needed)

```bash
node dev-server.js
```

Nothing to install — it serves `index.html` and routes `/api/*` to the handlers in `api/`.
`npx vercel dev` works too, but wants a CLI download, a login and a linked project first.

Open <http://localhost:3000>, pick an organization, press **Daily check** → **Collect**.

**Expected:** YouTube and Telegram channels fill in with real post counts. Facebook and TikTok
rows say they need the extension. Instagram usually says the same — its public endpoint is
rate-limited per IP and is deliberately treated as a bonus, not a dependency.

Things worth poking at:

- **Timezone selector** — decides which day a post belongs to. Default UTC+7 (Vietnam/Thailand).
  Switching it re-buckets everything; a post near midnight should move between days.
- **Slot window** — how far apart two posts can be and still count as the same drop. At ±5 min a
  drop that took 6 minutes to fan out splits into two slots; at ±15 it holds together.
- **Collect twice** — the second run must add 0 new posts. Runs accumulate rather than replace,
  so history grows past the ~15–20 posts each source returns.
- **Copy report** — plain-text version of what is on screen.

### Getting your channels into the local copy

Two ways, both safe:

**A · Local mode (nothing touches the database).** Started with no env vars, the app keeps the
directory in the browser and starts empty. On the live site: **Settings → Export JSON**. Then in
the local one: **Settings → Import** that file. Read-only as far as production is concerned.

**B · Point at the real row (read-only).** Put a `.env` next to `dev-server.js`:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
```

The server reads it on start and the app loads the real directory. This is a `GET` — the daily
check never writes, and the app only saves when you add, edit or delete something. Leave
`ADMIN_PASSWORD` out and editing cannot reach the database at all, which makes B hard to get wrong.

`.env` is already covered by `.gitignore`.

---

## Part 2 · The extension (Facebook + Instagram)

Load it once:

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Pin it to the toolbar

Then:

1. Make sure you are signed into Facebook and Instagram in that Chrome profile — the same as
   when you click a link. No password goes anywhere, no cookie is read; the browser attaches
   your session itself.
2. Keep the dashboard tab open.
3. Click the extension → set **Dashboard URL** to `http://localhost:3000` → **Load channels**
4. Check the **Organization** picker. It defaults to whichever org the dashboard tab has open,
   and only that org's channels are collected — an earlier version swept the whole directory and
   opened tabs for unrelated orgs, mixing their posts into the report.
5. **Collect** → **Send to dashboard**
6. Back in the dashboard, reopen **Daily check** and press **Merge N waiting**

**Expected:**

- **Instagram** — real post counts with timestamps, so it joins the slot matching. This is the
  path that works where the server-side attempt is rate-limited: same-origin request, your
  session, your IP.
- **Facebook** — **≈** cells rather than ✓, because it is matched on what its posts said rather
  than when they appeared. Hover a cell for the match percentage. **Per channel** lists the
  caption that matched each drop with the post's banner beside it, which is the quickest way to
  confirm the same artwork went everywhere.
- Not signed into Facebook, or captions unreadable → the row reports *unknown* and its cells stay
  blank. Never a cross: "we could not look" and "nothing was posted" are different facts, and
  conflating them is the one failure this tool must not produce.

### Handing over

The extension writes its run into the dashboard origin's `localStorage`, and the page picks it up
on load or on focus. No admin key, no write endpoint, nothing stored server-side.

---

## Part 3 · The link checker fix

Press **Check links** on an organization with social channels.

The bug: Instagram answers `HTTP 200` with the same ~610 KB JavaScript shell whether a profile is
live, dead, or never existed — so a status-only check painted dead channels green. Facebook does
the same behind its login wall.

Now a green dot means the target was actually confirmed:

| Dot | Meaning | Which channels |
|---|---|---|
| green | confirmed to exist | YouTube, Telegram, Instagram (when not rate-limited) |
| amber | reachable, but the platform will not confirm it | Facebook, TikTok, rate-limited Instagram |
| red | genuinely broken | 404 from a verifier |

Facebook and TikTok are no longer probed at all — whatever they return says nothing about the
link, and skipping the request takes about 11 seconds off a full check.

> **Check `instagram.com/funsports.thai`.** Its API answer is a 404, the same as a username
> invented at random, while a live handle returns 200 with JSON. Open it in your browser to
> confirm — if it is wrong, fix it in the directory. The old checker showed it green.

---

## Automated tests

Verifying the link checker against the live platforms is unreliable — Instagram will rate-limit
you after a handful of runs, and a rate-limited answer looks nothing like a dead profile. So the
branch checks the mapping with a stubbed `fetch` instead, covering all twelve outcomes:

```bash
npm test                      # all three, 81 assertions
npm run test:unit             # the two stubbed suites — no network
npm run test:live             # api/collect against the real channels
```

| | |
|---|---|
| `test/check.test.js` | every link-checker branch: dead / live / rate-limited / no-probe |
| `test/reconcile.test.js` | language detection, drop clustering, targets, alerts, window bounds |
| `test/collect.test.js` | drives `api/collect` against the live platforms |

`collect.test.js` hits the network on purpose — it is the one that fails when YouTube or Telegram
change what they serve. The other two are stubbed, because a test that depends on whether
Instagram feels like rate-limiting you today proves nothing.

`reconcile.test.js` reads the logic out of `index.html` rather than keeping a copy, so the tests
cannot pass against code that is no longer what ships.

---

## What to look for before merging

- [ ] Collect twice — second run adds 0 posts
- [ ] A window where every channel got everything shows **All clear** at the top
- [ ] A channel with no data reads **·** and **no data**, never **✗** — an uncollected channel is
      not a failed post, and confusing the two buries the real gaps
- [ ] A channel that missed one drop shows **✗** in that column only, and names the time
- [ ] Window / timezone / drop-width / max-per-period selectors all re-draw the report
- [ ] **What went out** lists one caption per language for each drop, so both variants are visible
- [ ] Hand-entered counts stick across a reload, and switch the row off *suggested*
- [ ] **Clear history** empties the check store and leaves the directory alone
- [ ] Existing features still fine: QR, Embed, Copy all, add/edit/delete, admin lock

### The language check

Worth testing deliberately, since it is the one thing a count can never catch. Set a channel's
language tag to the wrong value in the directory — mark the English Telegram channel `vietnamese`
— then re-open the report. Every post on it should turn **⚠** with a *language* alert naming what
the caption actually looks like. Set it back afterwards.

Detection is English-UI and Latin/Thai/CJK script aware; anything it cannot place is left blank
rather than guessed, so a missing verdict means "unclear", not "fine".
