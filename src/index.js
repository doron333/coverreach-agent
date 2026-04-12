import "dotenv/config";
import cron from "node-cron";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkReplies } from "./replyWatcher.js";
import { log } from "./logger.js";
import { getLeads, deduplicateLeads, prioritizeByRenewal } from "./leads.js";
import { sendNotification } from "./gmail.js";

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "BREVO_API_KEY", "YOUR_EMAIL"];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function main() {
  validateEnv();

  // Startup deduplication and prioritization
  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Startup: removed ${dupes} duplicate leads`);
  prioritizeByRenewal();

  const leads = getLeads();
  const counts = {
    new: leads.filter(l => l.status === "new").length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
    unsubscribed: leads.filter(l => l.status === "unsubscribed").length,
    bounced: leads.filter(l => l.status === "bounced").length,
  };

  const dailyLimit = parseInt(process.env.DAILY_LIMIT || "100");

  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║         Running 24/7 on your server          ║
╚══════════════════════════════════════════════╝
`);
  log.info(`Leads: ${leads.length} total | ${counts.new} new | ${counts.contacted} contacted | ${counts.replied} replied | ${counts.unsubscribed} unsubscribed | ${counts.bounced} bounced`);
  log.info(`Sender:       Richard Doron <${process.env.YOUR_EMAIL}>`);
  log.info(`Daily limit:  ${dailyLimit} emails/day`);
  log.info(`Cold schedule:      ${process.env.COLD_CRON || "0 19 * * *"} (3pm ET)`);
  log.info(`Follow-up schedule: ${process.env.FOLLOWUP_CRON || "30 19 * * *"} (3:30pm ET)`);
  log.info(`Reply check:        ${process.env.REPLY_CHECK_CRON || "*/30 * * * *"} (every 30 min)`);
  log.info(`At ${dailyLimit}/day — all ${counts.new} new leads contacted in ~${Math.ceil(counts.new/dailyLimit)} days`);
  log.info(`AI model: Claude Haiku (cost-optimized)`);

  // Send startup notification
  await sendNotification(
    "✅ CoverReach Agent Started",
    `Agent restarted successfully.

LEAD STATUS:
New:           ${counts.new}
Contacted:     ${counts.contacted}
Replied:       ${counts.replied}
Unsubscribed:  ${counts.unsubscribed}
Bounced:       ${counts.bounced}

Next cold batch: 3pm Eastern today
Daily limit: ${dailyLimit} emails

Richard Doron | (609) 757-2221`
  );

  cron.schedule(process.env.COLD_CRON || "0 19 * * *", async () => {
    log.cron("⏰ Triggered: daily cold outreach batch");
    try { await runColdBatch(); }
    catch (err) { log.error(`Cold batch crashed: ${err.message}`); }
  });

  cron.schedule(process.env.FOLLOWUP_CRON || "30 19 * * *", async () => {
    log.cron("⏰ Triggered: daily follow-up batch");
    try { await runFollowupBatch(); }
    catch (err) { log.error(`Follow-up batch crashed: ${err.message}`); }
  });

  cron.schedule(process.env.REPLY_CHECK_CRON || "*/30 * * * *", async () => {
    try { await checkReplies(); }
    catch (err) { log.error(`Reply check crashed: ${err.message}`); }
  });

  log.success("✅ All schedules active. Agent is running 24/7.");

  setInterval(() => {
    const leads = getLeads();
    log.info(`💓 Heartbeat — ${leads.filter(l=>l.status==="new").length} new | ${leads.filter(l=>l.status==="contacted").length} contacted | ${leads.filter(l=>l.status==="replied").length} replies`);
  }, 60 * 60 * 1000);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
