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
/* Both requires are lazy — deferred until a browser is actually launched, not run when this module
   is first loaded. Two reasons: requiring this file at all (api/collect.js does, unconditionally)
   must never be what breaks YouTube/Telegram/X/Viber if these two packages ever have an install or
   native-binary problem on a given host; and any failure then surfaces as a normal thrown error from
   withPage(), caught by the same try/catch every caller already has around a browser-reader call
   (see collect.js), with a message that actually names what went wrong — instead of a module-load
   crash with no caller to report it. */
function loadPlaywright() {
  return require("playwright-core").chromium;
}

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
      /* @sparticuz/chromium-min publishes itself as "type": "module" — a plain CommonJS require()
         of it either throws ERR_REQUIRE_ESM outright or confuses a build-time bundler trying to
         trace a require graph (this project is CommonJS throughout, no "type": "module" of its
         own). A dynamic import() is the supported way to load an ESM package from CJS; its default
         export is the Chromium class itself (confirmed: Object.keys(await import(...)) is
         ["default","inflate","setupLambdaEnvironment"], with .args / .executablePath() as statics
         on the default export, not on the module namespace). */
      const { default: sparticuz } = await import("@sparticuz/chromium-min");
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
    let playwrightChromium, args, executablePath;
    try {
      playwrightChromium = loadPlaywright();
      ({ args, executablePath } = await launchArgs());
    } catch (setupErr) {
      /* Named explicitly rather than let a bare module-load error bubble up looking like a generic
         crash — this is the one failure mode that could otherwise go completely unreported, since
         everything calling withPage() reports whatever message lands in its catch block verbatim. */
      throw new Error("Browser reader setup failed (" +
        String((setupErr && setupErr.message) || setupErr) + ") — is playwright-core / " +
        "@sparticuz/chromium-min actually installed on this deployment?");
    }
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
