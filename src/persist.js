import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEADS_PATH = path.join(__dirname, "../data/leads.json");

const GITHUB_REPO = process.env.GITHUB_REPO || "doron333/coverreach-agent";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const FILE_PATH = "data/leads.json";

/**
 * PERSISTENCE FIX
 * ================
 * Railway's filesystem is EPHEMERAL — every restart wipes local changes
 * to leads.json back to whatever is in the GitHub repo.
 *
 * Fix: after each batch, commit the updated leads.json back to GitHub.
 * On restart, the container pulls the repo fresh — which now includes
 * all contact history. State survives forever.
 *
 * Requires env var: GITHUB_TOKEN (a PAT with repo write access)
 */

export async function persistLeadsToGitHub(commitMessage) {
  if (!GITHUB_TOKEN) {
    log.warn("GITHUB_TOKEN not set — lead state will NOT survive restarts!");
    return false;
  }

  try {
    const content = fs.readFileSync(LEADS_PATH, "utf8");
    const encoded = Buffer.from(content).toString("base64");

    // Get current file SHA
    const getRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${FILE_PATH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
    );
    if (!getRes.ok) throw new Error(`GitHub GET ${getRes.status}`);
    const fileInfo = await getRes.json();

    // Commit updated file
    const putRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${FILE_PATH}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github.v3+json",
        },
        body: JSON.stringify({
          message: commitMessage || `Agent state update — ${new Date().toISOString()}`,
          content: encoded,
          sha: fileInfo.sha,
        }),
      }
    );
    if (!putRes.ok) {
      const err = await putRes.text();
      throw new Error(`GitHub PUT ${putRes.status}: ${err.slice(0, 100)}`);
    }

    log.success("Lead state persisted to GitHub ✅");
    return true;
  } catch (err) {
    log.error(`Failed to persist state: ${err.message}`);
    return false;
  }
}
