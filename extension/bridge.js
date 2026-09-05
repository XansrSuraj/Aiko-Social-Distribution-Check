/**
 * Bridge — a content script on the dashboard's own page.
 *
 * Without it the two halves have to be driven from two different places: press Collect in the
 * page for YouTube and Telegram, then open the popup and press Collect again for Facebook and
 * Instagram. This lets the page ask the extension to do its half, so one button runs both.
 *
 * The page cannot call chrome.runtime directly (it has no extension id, and an unpacked
 * extension's id depends on where the folder sits), so messages hop through window.postMessage
 * here and on to the service worker.
 *
 * Only same-window messages carrying the __aiko marker are relayed, and the only action accepted
 * is "collect" with a channel list the page already has — the bridge grants the page no reach it
 * did not already have through the popup.
 */

const TAG = "__aiko";

function announce() {
  window.postMessage({ [TAG]: "ready", version: chrome.runtime.getManifest().version }, window.origin);
}

/* the page may load before or after this script, so say hello and answer pings */
announce();

window.addEventListener("message", async ev => {
  if (ev.source !== window) return;
  const m = ev.data;
  if (!m || m[TAG] !== "request") return;

  if (m.action === "ping") return announce();

  if (m.action === "collect") {
    const reply = payload => window.postMessage(
      Object.assign({ [TAG]: "result", id: m.id }, payload), window.origin);
    try {
      const res = await chrome.runtime.sendMessage({
        type: "collect",
        channels: Array.isArray(m.channels) ? m.channels : [],
      });
      if (!res || !res.ok) return reply({ ok: false, error: (res && res.error) || "collection failed" });
      reply({ ok: true, run: { collectedAt: res.collectedAt, results: res.results } });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  }
});

/* relay progress so the page can show what is happening mid-run, and — more importantly — relay
   each channel's result the moment it is ready. The page files a partial straight away, so a run
   that is later cut short by its deadline still leaves behind everything it managed to read. A
   slow or impossible channel can no longer take the working ones down with it. */
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === "progress") {
    window.postMessage({ [TAG]: "progress", text: msg.text }, window.origin);
  }
  if (msg && msg.type === "partial" && msg.result) {
    window.postMessage({ [TAG]: "partial", result: msg.result }, window.origin);
  }
});
