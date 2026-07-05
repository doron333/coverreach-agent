import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GITHUB_REPO = process.env.GITHUB_REPO || "doron333/coverreach-agent";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

/**
 * PERSISTENCE
 * ============
 * Railway's filesystem is EPHEMERAL — every restart wipes local changes
 * back to whatever is in the GitHub repo.
 *
 * Fix: after each batch, commit state files back to GitHub:
 *   - data/leads.json    (lead statuses, contact history)
 *   - data/touchlog.json (permanent record of every email ever sent)
 *
 * Requires env var: GITHUB_TOKEN (a PAT with repo write access)
 */

const STATE_FILES = [
  { local: path.join(__dirname, "../data/leads.json"), repo: "data/leads.json" },
  { local: path.join(__dirname, "../data/touchlog.json"), repo: "data/touchlog.json" },
];

async function pushFile(localPath, repoPath, commitMessage) {
  if (!fs.existsSync(localPath)) return false;

  const content = fs.readFileSync(localPath, "utf8");
  const encoded = Buffer.from(content).toString("base64");

  // Get current SHA (may not exist yet for new files)
  let sha = null;
  const getRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${repoPath}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (getRes.ok) {
    const info = await getRes.json();
    sha = info.sha;
  }

  const body = { message: commitMessage, content: encoded };
  if (sha) body.sha = sha;

  const putRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${repoPath}`,
    {
      method: "PUT",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub PUT ${repoPath} ${putRes.status}: ${err.slice(0, 100)}`);
  }
  return true;
}

export async function persistLeadsToGitHub(commitMessage) {
  if (!GITHUB_TOKEN) {
    log.warn("GITHUB_TOKEN not set — lead state will NOT survive restarts!");
    return false;
  }

  let allOk = true;
  for (const file of STATE_FILES) {
    try {
      const ok = await pushFile(file.local, file.repo, commitMessage || `Agent state — ${new Date().toISOString()}`);
      if (ok) log.info(`Persisted ${file.repo}`);
    } catch (err) {
      log.error(`Failed to persist ${file.repo}: ${err.message}`);
      allOk = false;
    }
  }

  if (allOk) log.success("All state persisted to GitHub ✅");
  return allOk;
}
