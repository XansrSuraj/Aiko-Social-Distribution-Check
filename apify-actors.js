/**
 * The Apify actors api/collect.js runs, their run settings, and their FREE-tier event prices (read
 * from each actor's own pricing on 2026-10-02). Shared with api/apify-usage.js so that both judge
 * "has this run's bill settled yet?" the same way.
 *
 * Why that question exists at all: Apify fills in a run's bill some time AFTER the run stops, and
 * not in one step. Measured on production: a run that returned six posts first showed { post: 0 }
 * and $0; another showed its events counted beside a dollar figure holding only the $0.001 start
 * fee; X showed only its few cents of compute. So a figure is believed only once it covers every
 * charged event at that event's known price — until then it is reported as still settling.
 *
 *   memory    — pinned so a full check stays under the free plan's 8 GB of concurrent runs
 *   minCap    — the lowest maxTotalChargeUsd the actor accepts (TikTok refuses anything under $0.50)
 *   itemEvent — the event billed once per dataset item
 *   prices    — USD per event; an event missing here is one this project never triggers
 */
const APIFY_ACTORS = {
  instagram: { id: "apify~instagram-post-scraper", memory: 512,  minCap: 0.005, itemEvent: "post",
               prices: { post: 0.0017, "post-details": 0.001 } },
  /* The page's Reels tab, not its post timeline. apify~facebook-posts-scraper was used first and,
     asked for a page's newest 6 posts twice 27 minutes apart, returned the newest 6 once and the 6
     after them the second time — today's posts simply absent. Every SportsFC Facebook post is a
     reel, and the Reels tab lists them newest first. */
  facebook:  { id: "apify~facebook-reels-scraper", memory: 1024, minCap: 0,     itemEvent: "apify-default-dataset-item",
               prices: { "apify-default-dataset-item": 0.005 } },
  tiktok:    { id: "clockworks~tiktok-scraper",    memory: 2048, minCap: 0.5,   itemEvent: "result",
               prices: { result: 0.0037, "actor-start": 0.001 } },
  x:         { id: "xquik~x-tweet-scraper",         memory: 256,  minCap: 0,     itemEvent: "apify-default-dataset-item",
               prices: { "apify-default-dataset-item": 0.00015 } },
};

/* what a run asking for n items should cost — only used to set its spending cap */
function expectedUsd(actor, n) {
  return (actor.prices["actor-start"] || 0) + (actor.prices[actor.itemEvent] || 0) * n;
}

/* what the run's charged events add up to at the known prices */
function billedFor(actor, events) {
  let usd = 0;
  for (const [k, n] of Object.entries(events || {})) usd += (Number(n) || 0) * (actor.prices[k] || 0);
  return usd;
}

/* Settled: the run has stopped, every item it returned has been charged (when that count is known),
   and the dollar figure covers those charges. */
function isSettled(actor, run, itemCount) {
  if (!run || !/^(SUCCEEDED|FAILED|ABORTED|TIMED-OUT)$/.test(run.status || "")) return false;
  const ev = run.chargedEventCounts || {};
  if (itemCount != null && (Number(ev[actor.itemEvent]) || 0) < itemCount) return false;
  return (Number(run.usageTotalUsd) || 0) + 1e-7 >= billedFor(actor, ev);
}

const actorById = id => Object.values(APIFY_ACTORS).find(a => a.id === id) || null;

module.exports = { APIFY_ACTORS, expectedUsd, billedFor, isSettled, actorById };
