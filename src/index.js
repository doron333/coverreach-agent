import "dotenv/config";
import cron from "node-cron";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkGmailReplies } from "./imapWatcher.js";
import { startReplyServer } from "./replyServer.js";
import { log } from "./logger.js";
import { getLeads, deduplicateLeads, prioritizeByRenewal } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { auditLeads } from "./leadAudit.js";

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "BREVO_API_KEY", "YOUR_EMAIL"];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// Keep the process alive even if something goes wrong
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  log.error(`Uncaught Exception: ${err.message}`);
});

async function main() {
  validateEnv();

  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Removed ${dupes} duplicate leads`);
  prioritizeByRenewal();

  const leads = getLeads();
  const inWindow = (l) => {
    if (!l.renewalDate) return false;
    const [m, d, y] = l.renewalDate.split("/").map(Number);
    const days = Math.floor((new Date(y, m - 1, d) - Date.now()) / 86400000);
    if (l.cancellation) return days >= 0 && days <= 75;
    return days >= parseInt(process.env.MIN_RUNWAY_DAYS || "21") && days <= 60;
  };

  const counts = {
    new: leads.filter(l => l.status === "new" && l.email && inWindow(l)).length,
    pipeline: leads.filter(l => l.status === "new" && l.email).length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
    noEmail: leads.filter(l => !l.email || l.email === "null" || l.status === "no_email").length,
    dual: 0,
    cancellations: leads.filter(l => l.status === "new" && l.cancellation && inWindow(l)).length,
  };

  const dailyLimit = parseInt(process.env.DAILY_LIMIT || "200");
  const coldCron = process.env.COLD_CRON || "0 19 * * *";
  const followupCron = process.env.FOLLOWUP_CRON || "30 19 * * *";
  const replyCheckCron = process.env.REPLY_CHECK_CRON || "*/30 * * * *";

  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║     All Commercial Insurance — NJ Market     ║
╚══════════════════════════════════════════════╝
`);

  log.info(`ROLLING RENEWALS — In window now: ${counts.new} | Total pipeline: ${counts.pipeline} | Contacted: ${counts.contacted} | Replied: ${counts.replied}`);
  log.info(`🔴 Cancellations (priority): ${counts.cancellations}`);
  log.info(`Sender: Richard Doron <${process.env.YOUR_EMAIL}>`);
  log.info(`Daily limit: ${dailyLimit} | Cold: ${coldCron} | Follow-up: ${followupCron}`);
  log.info(`At ${dailyLimit}/day — ${counts.new} July leads = ~${Math.ceil(counts.new/dailyLimit)} days`);

  sendNotification(
    "✅ CoverReach Agent Started — Rolling Renewal Mode",
    `ROLLING RENEWAL OUTREACH (NJ · PA · MD · DE)
${"=".repeat(40)}
In send window now (30-60 days to renewal): ${counts.new}
🔴 Cancellations (sent first): ${counts.cancellations}
Total future pipeline: ${counts.pipeline}
Contacted so far: ${counts.contacted}
Replied: ${counts.replied}

Daily limit: ${dailyLimit}
Each lead is contacted 30-60 days before THEIR renewal —
enough time to quote and close before rates lock.

Richard Doron | (609) 757-2221`
  ).catch(() => {});

  cron.schedule(coldCron, async () => {
    log.cron("Triggered: daily cold outreach batch");
    try {
      await runColdBatch();
    } catch (err) {
      log.error(`Cold batch crashed: ${err.message}`);
    }
  });

  cron.schedule(followupCron, async () => {
    log.cron("Triggered: daily follow-up batch");
    try {
      await runFollowupBatch();
    } catch (err) {
      log.error(`Follow-up batch crashed: ${err.message}`);
    }
  });

  cron.schedule(replyCheckCron, async () => {
    log.cron("Triggered: Gmail reply check");
    try {
      await checkGmailReplies();
    } catch (err) {
      log.error(`Reply check crashed: ${err.message}`);
    }
  });

  // Weekly lead hygiene sweep — Sundays 6:00 AM ET (10:00 UTC).
  // Repairs broken addresses and suppresses confirmed-undeliverable ones so
  // list quality never silently degrades as new data is added.
  cron.schedule(process.env.AUDIT_CRON || "0 10 * * 0", async () => {
    log.cron("Triggered: weekly lead hygiene audit");
    try {
      const r = await auditLeads({ apply: true });
      if (r.repaired.length || r.suppressed.length) {
        await sendNotification(
          `\uD83E\uDDF9 Weekly lead audit — ${r.repaired.length} repaired, ${r.suppressed.length} suppressed`,
          `${r.summary}\n\n` +
          `Repaired addresses:\n` +
          r.repaired.slice(0, 20).map(x => `  ${x.from} -> ${x.to}`).join("\n") +
          `\n\nSuppressed (undeliverable):\n` +
          r.suppressed.slice(0, 20).map(x => `  ${x.email} (${x.reason})`).join("\n")
        ).catch(() => {});
      }
    } catch (err) { log.error(`Audit cron failed: ${err.message}`); }
  });

  log.success("All schedules active. Agent running 24/7.");

  startReplyServer();

  setInterval(() => {
    try {
      const currentLeads = getLeads();
      log.info(`Heartbeat — ${currentLeads.filter(l => l.status === "new" && l.email && l.email !== "null").length} ready | ${currentLeads.filter(l => l.status === "contacted").length} contacted | ${currentLeads.filter(l => l.status === "replied").length} replies`);
    } catch (e) {
      log.error(`Heartbeat error: ${e.message}`);
    }
  }, 60 * 60 * 1000);

  setInterval(() => {}, 1000 * 60 * 60 * 24);
}

main().catch(err => {
  log.error(`Fatal error in main: ${err.message}`);
});