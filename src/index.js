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

  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Removed ${dupes} duplicate leads`);
  prioritizeByRenewal();

  const leads = getLeads();
  const counts = {
    new: leads.filter(l => l.status === "new" && l.campaignEligible === true && l.email && l.email !== "null").length,
    contacted: leads.filter(l => l.campaignEligible === true && l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
    noEmail: leads.filter(l => !l.email || l.email === "null" || l.status === "no_email").length,
    dual: leads.filter(l => l.source === "njcrib_dot" && l.campaignEligible === true).length,
    cancellations: leads.filter(l => l.campaignEligible === true && l.status === "new" && l.cancellation).length,
  };

  const dailyLimit = parseInt(process.env.DAILY_LIMIT || "100");
  const coldCron = process.env.COLD_CRON || "0 19 * * *";
  const followupCron = process.env.FOLLOWUP_CRON || "30 19 * * *";
  const replyCheckCron = process.env.REPLY_CHECK_CRON || "*/30 * * * *";

  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║     All Commercial Insurance — NJ Market     ║
╚══════════════════════════════════════════════╝
`);
  log.info(`JULY 2026 CAMPAIGN — Ready: ${counts.new} | Contacted: ${counts.contacted} | Replied: ${counts.replied}`);
  log.info(`🔴 Cancellations (priority): ${counts.cancellations} | Dual-pitch: ${counts.dual}`);
  log.info(`Sender: Richard Doron <${process.env.YOUR_EMAIL}>`);
  log.info(`Daily limit: ${dailyLimit} | Cold: ${coldCron} | Follow-up: ${followupCron}`);
  log.info(`At ${dailyLimit}/day — ${counts.new} July leads = ~${Math.ceil(counts.new/dailyLimit)} days`);

  sendNotification(
    "✅ CoverReach Agent Started — July 2026 Campaign",
    `JULY RENEWAL CAMPAIGN
${"=".repeat(40)}
Ready to email: ${counts.new} (July renewals ONLY)
🔴 Cancellations (sent first): ${counts.cancellations}
🔥 Dual-pitch: ${counts.dual}
Contacted so far: ${counts.contacted}
Replied: ${counts.replied}

Daily limit: ${dailyLimit}
At ${dailyLimit}/day — done in ~${Math.ceil(counts.new/dailyLimit)} days
Next send: ${coldCron} (UTC)

Only leads renewing in July 2026 will be contacted.

Richard Doron | (609) 757-2221`
  ).catch(() => {});

  cron.schedule(coldCron, async () => {
    log.cron("Triggered: daily cold outreach batch");
    try { await runColdBatch(); }
    catch (err) { log.error(`Cold batch crashed: ${err.message}`); }
  });

  cron.schedule(followupCron, async () => {
    log.cron("Triggered: daily follow-up batch");
    try { await runFollowupBatch(); }
    catch (err) { log.error(`Follow-up batch crashed: ${err.message}`); }
  });

  cron.schedule(replyCheckCron, async () => {
    try { await checkReplies(); }
    catch (err) { log.error(`Reply check crashed: ${err.message}`); }
  });

  log.success("All schedules active. Agent running 24/7.");

  setInterval(() => {
    const leads = getLeads();
    log.info(`Heartbeat — ${leads.filter(l=>l.status==="new"&&l.email&&l.email!=="null").length} ready | ${leads.filter(l=>l.status==="contacted").length} contacted | ${leads.filter(l=>l.status==="replied").length} replies`);
  }, 60 * 60 * 1000);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
