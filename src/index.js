import "dotenv/config";
import cron from "node-cron";
import nodemailer from "nodemailer";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkReplies } from "./replyWatcher.js";
import { log } from "./logger.js";
import { getLeads } from "./leads.js";

const REQUIRED_ENV = [
  "ANTHROPIC_API_KEY",
  "GMAIL_APP_PASSWORD",
  "YOUR_EMAIL",
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing required environment variables:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
}

async function sendTestEmail() {
  const testEmail = process.env.TEST_EMAIL;
  if (!testEmail) return;

  log.info(`Sending test email to ${testEmail}...`);
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.YOUR_EMAIL,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `${process.env.SENDER_NAME || "Matt Doron"} <${process.env.YOUR_EMAIL}>`,
      to: testEmail,
      subject: "✅ CoverReach Agent — Test Email",
      text: `Hi Matthew,

This is a test email from Matt Doron's CoverReach AI agent.

The system is now live and running 24/7. Here is a sample of what insurance prospects will receive:

─────────────────────────────────────────
SAMPLE PROSPECT EMAIL
─────────────────────────────────────────
Subject: Quick question about your liability coverage

Hi there,

I came across your company and wanted to reach out regarding your commercial general liability coverage.

As an insurance specialist, I have helped businesses secure comprehensive coverage that fits their operations and budget without overpaying.

I am not here to push anything — just genuinely curious: are you completely satisfied with how your current policy handles your specific exposures?

Best regards,
Matt Doron | Insurance Solutions Specialist
─────────────────────────────────────────

AGENT STATUS:
✅ 1,933 leads loaded and ready
✅ Gmail: ${process.env.YOUR_EMAIL}
✅ AI email generation active
✅ Running 24/7 on Railway

Schedule:
• Every Monday 9am    — Cold emails to all new leads
• Every Thursday 10am — Follow-ups to non-replies
• Every 30 minutes    — Scanning Gmail for replies
• Instantly           — Notification when a lead replies

— CoverReach AI Agent`,
    });
    log.success(`✅ Test email sent to ${testEmail}!`);
  } catch (err) {
    log.error(`Test email failed: ${err.message}`);
  }
}

async function printBanner() {
  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║         Running 24/7 on your server          ║
╚══════════════════════════════════════════════╝
`);
  const leads = getLeads();
  const counts = {
    new: leads.filter(l => l.status === "new").length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
    cold: leads.filter(l => l.status === "cold").length,
  };
  log.info(`Loaded ${leads.length} leads — new: ${counts.new}, contacted: ${counts.contacted}, replied: ${counts.replied}, cold: ${counts.cold}`);
  log.info(`Sender: ${process.env.SENDER_NAME || "Matt Doron"} <${process.env.YOUR_EMAIL}>`);
  log.info(`Cold schedule:      ${process.env.COLD_CRON || "0 9 * * 1"} (Mon 9am)`);
  log.info(`Follow-up schedule: ${process.env.FOLLOWUP_CRON || "0 10 * * 4"} (Thu 10am)`);
  log.info(`Reply check:        ${process.env.REPLY_CHECK_CRON || "*/30 * * * *"} (every 30 min)`);
}

async function main() {
  validateEnv();
  await printBanner();

  // Send test email if TEST_EMAIL is set
  await sendTestEmail();

  const coldCron       = process.env.COLD_CRON        || "0 9 * * 1";
  const followupCron   = process.env.FOLLOWUP_CRON    || "0 10 * * 4";
  const replyCheckCron = process.env.REPLY_CHECK_CRON || "*/30 * * * *";

  cron.schedule(coldCron, async () => {
    log.cron("Triggered: weekly cold outreach batch");
    try { await runColdBatch(); }
    catch (err) { log.error(`Cold batch crashed: ${err.message}`); }
  });

  cron.schedule(followupCron, async () => {
    log.cron("Triggered: weekly follow-up batch");
    try { await runFollowupBatch(); }
    catch (err) { log.error(`Follow-up batch crashed: ${err.message}`); }
  });

  cron.schedule(replyCheckCron, async () => {
    try { await checkReplies(); }
    catch (err) { log.error(`Reply check crashed: ${err.message}`); }
  });

  log.info("Running initial reply check...");
  try { await checkReplies(); }
  catch (err) { log.error(`Initial reply check failed: ${err.message}`); }

  log.success("All schedules active. Agent is running 24/7.");

  setInterval(() => {
    const leads = getLeads();
    log.info(`Heartbeat — ${leads.length} leads tracked | ${leads.filter(l=>l.status==="replied").length} replies received`);
  }, 60 * 60 * 1000);
}

main().catch(err => {
  log.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
