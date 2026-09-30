/**
 * Shared headless-Chromium launcher for the browser-based collectors (Instagram, Facebook, TikTok
 * in api/collect.js).
 *
 * Why this exists: Facebook and TikTok have no public API a server can read at all, and Instagram's
 * public JSON endpoint is refused from a datacenter IP (measured: 429 in ~25ms). But a FULL browser
 * navigation to the same profile page is not — the block sits on that one background XHR, not on the
 * page load itself. Verified directly (2026-10-01): a plain headless Chromium load of an ordinary
 * Instagram/Facebook profile, from this project's own execution environment, renders the real feed
 * with no login wall — the grid's post links and a permalink page's own <time> element and
 * og:description are sitting right there in the DOM. No Apify, no extension, no login required.
 *
 * On Vercel there is no local Chromium install, so @sparticuz/chromium-min fetches a serverless-sized
 * build from a public GitHub release on cold start and points Playwright at it. Anywhere else (local
 * dev via `node dev-server.js`) the ordinary Playwright-managed Chromium already on disk is used
 * instead — nothing extra to configure beyond `npx playwright install chromium` once.
 */
const { chromium: playwrightChromium } = require("playwright-core");

/* Pinned to the playwright-core version in package.json — @sparticuz/chromium follows Chromium's own
   release cycle, not semver, so an upgrade of one needs a matching upgrade of the other (see its
   README). Hosted by the Sparticuz/chromium project itself on GitHub Releases; no self-hosting
   needed, and it costs nothing to fetch. */
const CHROMIUM_PACK_URL = "https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let launchArgsPromise = null;
function launchArgs() {
  if (launchArgsPromise) return launchArgsPromise;
  launchArgsPromise = (async () => {
    if (process.env.VERCEL) {
      const sparticuz = require("@sparticuz/chromium-min");
      return { args: sparticuz.args, executablePath: await sparticuz.executablePath(CHROMIUM_PACK_URL) };
    }
    /* local dev: playwright-core finds the browser Playwright's own installer already put in the
       shared ms-playwright cache — nothing to point it at explicitly */
    return { args: [], executablePath: undefined };
  })();
  return launchArgsPromise;
}

/* Serverless memory is the real ceiling here, not CPU — two or three headless Chromium instances
   launched at once in the same function invocation is how a run gets OOM-killed instead of just
   slow. Browser-based reads queue through this instead of running fully parallel like the plain HTTP
   ones above. Raising it costs memory; lowering it costs wall-clock time — 2 was chosen so a typical
   run (2 Instagram + 2 Facebook + 1 TikTok channel) finishes in two or three waves, not five at once. */
const MAX_CONCURRENT_BROWSERS = 2;
let running = 0;
const queue = [];
function acquire() {
  if (running < MAX_CONCURRENT_BROWSERS) { running++; return Promise.resolve(); }
  return new Promise(resolve => queue.push(resolve));
}
function release() {
  running--;
  const next = queue.shift();
  if (next) { running++; next(); }
}

/* Runs fn(page) inside a fresh, single-use browser + context, and guarantees the browser is closed
   afterwards even if fn throws — a reader crashing must never leak a Chromium process behind it. */
async function withPage(fn, opt) {
  await acquire();
  let browser;
  try {
    const { args, executablePath } = await launchArgs();
    browser = await playwrightChromium.launch({ args, executablePath, headless: true });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 1400 }, locale: "en-US" });
    /* Content verification, not rendering — a reel's video file or a page's web fonts tell this
       nothing a caption and a timestamp don't already, and downloading them is most of what a real
       page load costs in time and bandwidth. Images are left alone: several extraction paths below
       read a post's thumbnail URL straight off the DOM. */
    const page = await ctx.newPage();
    await page.route("**/*", route => {
      const type = route.request().resourceType();
      return (type === "media" || type === "font") ? route.abort() : route.continue();
    });
    const timeoutMs = (opt && opt.timeoutMs) || 25000;
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    return await fn(page);
  } finally {
    if (browser) await browser.close().catch(() => {});
    release();
  }
}

module.exports = { withPage };
