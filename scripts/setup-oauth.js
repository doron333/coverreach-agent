/**
 * CoverReach — Gmail OAuth2 Setup Script
 * Run once: node scripts/setup-oauth.js
 * This walks you through getting your Gmail refresh token.
 */

import "dotenv/config";
import { google } from "googleapis";
import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

async function main() {
  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH — Gmail OAuth Setup       ║
╚══════════════════════════════════════════════╝

This will walk you through getting your Gmail refresh token.

Before you start, make sure you have:
  1. A Google Cloud project at https://console.cloud.google.com
  2. Gmail API enabled for that project
  3. OAuth2 credentials created (Desktop app type)

`);

  const clientId     = process.env.GMAIL_CLIENT_ID     || await ask("Paste your Gmail Client ID: ");
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || await ask("Paste your Gmail Client Secret: ");

  const oauth2Client = new google.auth.OAuth2(
    clientId.trim(),
    clientSecret.trim(),
    "urn:ietf:wg:oauth:2.0:oob"
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
  });

  console.log("\n──────────────────────────────────────────────");
  console.log("Step 1: Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\n──────────────────────────────────────────────\n");

  const code = await ask("Step 2: Paste the authorization code here: ");

  try {
    const { tokens } = await oauth2Client.getToken(code.trim());

    if (!tokens.refresh_token) {
      console.error("\n❌ No refresh token returned. Make sure you chose 'Allow' and that the app has offline access.");
      process.exit(1);
    }

    console.log("\n✅ Success! Your refresh token is:\n");
    console.log(tokens.refresh_token);
    console.log("\n──────────────────────────────────────────────");

    // Auto-append to .env if it exists
    const envPath = path.join(__dirname, "../.env");
    if (fs.existsSync(envPath)) {
      let env = fs.readFileSync(envPath, "utf8");
      if (env.includes("GMAIL_REFRESH_TOKEN=")) {
        env = env.replace(/GMAIL_REFRESH_TOKEN=.*/, `GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
      } else {
        env += `\nGMAIL_REFRESH_TOKEN=${tokens.refresh_token}`;
      }
      fs.writeFileSync(envPath, env);
      console.log("✅ Automatically saved to your .env file!\n");
    } else {
      console.log("Add this to your .env file:\n");
      console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    }

    console.log("You can now run: npm start\n");
  } catch (err) {
    console.error(`\n❌ Error getting token: ${err.message}`);
    console.error("Make sure your Client ID and Secret are correct.");
  }

  rl.close();
}

main();
