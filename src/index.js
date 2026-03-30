import "dotenv/config";
import cron from "node-cron";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkReplies } from "./replyWatcher.js";
import { log } from "./logger.js";
import { getLeads } from "./leads.js";

// ── Validate env on startup ──────────────────────────────────────────────────
const REQUIRED_ENV = [
  "ANTHROPIC_API_KEY",
  "YOUR_EMAIL",
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing required environment variables:\n  ${missing.join("\n  ")}`);
    log.error("Copy .env.example → .env and fill in your credentials.");
    process.exit(1);
  }
}

// ── Startup banner ───────────────────────────────────────────────────────────
function printBanner() {
  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║         Running 24/7 on your server          ║
╚══════════════════════════════════════════════╝
`);

  const leads = getLeads();
  const counts = {
    new:       leads.filter(l => l.status === "new").length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied:   leads.filter(l => l.status === "replied").length,
    cold:      leads.filter(l => l.status === "cold").length,
  };

  log.info(`Loaded ${leads.length} leads — new: ${counts.new}, contacted: ${counts.contacted}, replied: ${counts.replied}, cold: ${counts.cold}`);
  log.info(`Sender: ${process.env.SENDER_NAME || "Alex Rivera"} <${process.env.YOUR_EMAIL}>`);
  log.info(`Cold schedule:     ${process.env.COLD_CRON     || "0 9 * * 1"} (Mon 9am)`);
  log.info(`Follow-up schedule: ${process.env.FOLLOWUP_CRON || "0 10 * * 4"} (Thu 10am)`);
  log.info(`Reply check:       ${process.env.REPLY_CHECK_CRON || "*/30 * * * *"} (every 30 min)`);
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  validateEnv();
  printBanner();

  const coldCron       = process.env.COLD_CRON        || "0 9 * * 1";
  const followupCron   = process.env.FOLLOWUP_CRON    || "0 10 * * 4";
  const replyCheckCron = process.env.REPLY_CHECK_CRON || "*/30 * * * *";

  // ── Weekly cold outreach (Monday 9am by default)
  cron.schedule(coldCron, async () => {
    log.cron("Triggered: weekly cold outreach batch");
    try { await runColdBatch(); }
    catch (err) { log.error(`Cold batch crashed: ${err.message}`); }
  });

  // ── Weekly follow-ups (Thursday 10am by default)
  cron.schedule(followupCron, async () => {
    log.cron("Triggered: weekly follow-up batch");
    try { await runFollowupBatch(); }
    catch (err) { log.error(`Follow-up batch crashed: ${err.message}`); }
  });

  // ── Reply watcher (every 30 min by default)
  cron.schedule(replyCheckCron, async () => {
    try { await checkReplies(); }
    catch (err) { log.error(`Reply check crashed: ${err.message}`); }
  });

  // Run reply check immediately on startup
  log.info("Running initial reply check...");
  try { await checkReplies(); }
  catch (err) { log.error(`Initial reply check failed: ${err.message}`); }

  log.success("All schedules active. Agent is running 24/7.");

  // Keep process alive and log a heartbeat every hour
  setInterval(() => {
    const leads = getLeads();
    log.info(`Heartbeat — ${leads.length} leads tracked | ${leads.filter(l=>l.status==="replied").length} replies received`);
  }, 60 * 60 * 1000);
}

main().catch(err => {
  log.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
