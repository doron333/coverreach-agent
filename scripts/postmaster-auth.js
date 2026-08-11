/**
 * ONE-TIME POSTMASTER AUTH
 * ========================
 * Gets the refresh token the agent needs to read Google Postmaster Tools.
 * Run this once on your own machine, not on the server.
 *
 * BEFORE RUNNING
 *   1. console.cloud.google.com → create a project (any name)
 *   2. APIs & Services → Library → search "Gmail Postmaster Tools API" → Enable
 *   3. APIs & Services → Credentials → Create Credentials → OAuth client ID
 *        Application type: Desktop app
 *      (If it asks you to configure a consent screen first: External,
 *       fill in the required fields, and add yourself as a test user.)
 *   4. Copy the Client ID and Client Secret
 *
 * RUN
 *   node scripts/postmaster-auth.js <CLIENT_ID> <CLIENT_SECRET>
 *
 * It prints a URL. Open it, sign in with the SAME Google account that
 * verified the domain in Postmaster Tools, approve, then paste the code
 * back here. It will print the three values to put into Railway.
 */

import readline from "readline";

const [, , clientId, clientSecret] = process.argv;

if (!clientId || !clientSecret) {
  console.error("\nUsage: node scripts/postmaster-auth.js <CLIENT_ID> <CLIENT_SECRET>\n");
  process.exit(1);
}

const REDIRECT = "urn:ietf:wg:oauth:2.0:oob";
const SCOPE = "https://www.googleapis.com/auth/postmaster.readonly";

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

console.log("\n1. Open this URL and approve access:\n");
console.log(authUrl);
console.log("\n2. Sign in with the account that verified the domain in Postmaster Tools.");
console.log("3. Copy the code Google gives you and paste it below.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Code: ", async (code) => {
  rl.close();
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code.trim(),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    });

    const json = await res.json();
    if (!res.ok || !json.refresh_token) {
      console.error("\nFailed:", JSON.stringify(json, null, 2));
      console.error("\nIf refresh_token is missing, revoke access at");
      console.error("myaccount.google.com/permissions and run this again.\n");
      process.exit(1);
    }

    console.log("\n\nAdd these three to Railway → Variables:\n");
    console.log(`PM_CLIENT_ID=${clientId}`);
    console.log(`PM_CLIENT_SECRET=${clientSecret}`);
    console.log(`PM_REFRESH_TOKEN=${json.refresh_token}`);
    console.log("\nThen open /reputation in the dashboard.\n");
  } catch (err) {
    console.error("\nError:", err.message, "\n");
    process.exit(1);
  }
});
