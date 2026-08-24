/**
 * ONE-TIME Telegram login — makes the session string the dashboard uses to read a bot's DMs.
 *
 * You run this on your OWN computer, once. It asks for your api_id / api_hash (from
 * https://my.telegram.org → "API development tools"), your phone number, and the code Telegram
 * texts you (and your 2FA password if you have one). It prints a SESSION STRING.
 *
 *   npm install telegram          # one time, just to run this
 *   node tg-login.js
 *
 * Then put three values into Vercel → Settings → Environment Variables (All environments):
 *   TG_API_ID      = <the api_id>
 *   TG_API_HASH    = <the api_hash>
 *   TG_SESSION     = <the long session string this prints>
 *
 * The session string is like a password for your Telegram account — keep it secret, never paste it
 * into chat or commit it. You only run this again if Telegram ever logs the session out.
 */
const readline = require("readline");
let TelegramClient, StringSession;
try {
  ({ TelegramClient } = require("telegram"));
  ({ StringSession } = require("telegram/sessions"));
} catch (e) {
  console.error("\nThe 'telegram' package isn't installed. Run:  npm install telegram\n");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, a => r(String(a).trim())));

(async () => {
  console.log("\n── Telegram login (one time) ──");
  console.log("Get api_id and api_hash from https://my.telegram.org → API development tools.\n");
  const apiId = Number(await ask("api_id: "));
  const apiHash = await ask("api_hash: ");
  if (!apiId || !apiHash) { console.error("api_id and api_hash are required."); process.exit(1); }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
  await client.start({
    phoneNumber: async () => await ask("phone (with country code, e.g. +9198…): "),
    password:    async () => await ask("2FA password (press Enter if you don't have one): "),
    phoneCode:   async () => await ask("the code Telegram just sent you: "),
    onError:     e => console.log("  …", (e && e.message) || e),
  });

  const session = client.session.save();
  console.log("\n✅ Logged in. Copy these into Vercel Environment Variables:\n");
  console.log("TG_API_ID   =", apiId);
  console.log("TG_API_HASH =", apiHash);
  console.log("TG_SESSION  =", session);
  console.log("\n(Keep TG_SESSION secret — it is like your account password.)\n");
  await client.disconnect().catch(() => {});
  rl.close();
  process.exit(0);
})().catch(e => { console.error("Login failed:", (e && e.message) || e); process.exit(1); });
