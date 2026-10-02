/**
 * mergePosts(), read straight out of index.html: a post read again refreshes what is stored about it
 * (newer counters, a thumbnail or hashtags an older reader lacked) without an empty field wiping a
 * filled one, only genuinely new posts count as added, and posts older than POST_KEEP_DAYS are
 * dropped — the whole store travels in one shared report row capped at 2 MB.
 *
 *   node test/mergeposts.test.js
 */
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const A = html.indexOf("const POST_KEEP_DAYS");
const B = html.indexOf("/* ── language ──", A);
if (A < 0 || B < 0) { console.error("could not find mergePosts in index.html"); process.exit(1); }

let pass = 0, fail = 0;
const ok = (good, label, extra) => { good ? pass++ : fail++; console.log(`  ${good ? "pass" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); };
const ago = d => new Date(Date.now() - d * 86400e3).toISOString();

const checks = { posts: {} };
const mergePosts = new Function("checks", html.slice(A, B) + "\n;return mergePosts;")(checks);

console.log("── mergePosts");
checks.posts.ig = [{ externalId: "a", ts: ago(1), text: "hello", views: 10, thumb: "https://x/a.jpg" },
                   { externalId: "old", ts: ago(20), text: "three weeks ago" }];
const added = mergePosts("ig", [
  { externalId: "a", ts: ago(1), text: "hello", views: 250, thumb: "", hashtags: ["football"] },
  { externalId: "b", ts: ago(0.5), text: "new one" },
]);
const a = checks.posts.ig.find(p => p.externalId === "a");
ok(added === 1, "only a post not stored before counts as added", String(added));
ok(a.views === 250 && a.hashtags[0] === "football", "a post read again takes the fresh counters and new fields", JSON.stringify(a));
ok(a.thumb === "https://x/a.jpg", "an empty field in the new read does not wipe a filled one", a.thumb);
ok(!checks.posts.ig.some(p => p.externalId === "old"), "a post older than the keep window is dropped");
ok(checks.posts.ig.map(p => p.externalId).join(",") === "b,a", "newest first", checks.posts.ig.map(p => p.externalId).join(","));
ok(mergePosts("ig", []) === 0 && checks.posts.ig.length === 2, "an empty read changes nothing");

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
