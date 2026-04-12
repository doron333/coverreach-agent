import "dotenv/config";
import cron from "node-cron";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkReplies } from "./replyWatcher.js";
import { log } from "./logger.js";
import { getLeads, deduplicateLeads, prioritizeByRenewal } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { sendSMS } from "./sms.js";

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "BREVO_API_KEY", "YOUR_EMAIL"];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function sendAllDemoTexts() {
  log.info("Sending all demo SMS texts to (609) 757-2221...");

  const demos = [
    {
      label: "1/6 — Agent Startup",
      msg: `✅ CoverReach Started

1,732 new leads loaded
Leads renewing <30 days: 23
Daily limit: 100 emails

Next send: 3pm ET today
SMS alerts: ACTIVE

Richard Doron | (609) 757-2221`
    },
    {
      label: "2/6 — Daily Batch Complete",
      msg: `📤 Daily Batch Done

✅ Sent: 100 emails
❌ Failed: 0
📋 Remaining: 1,632

Top subject today:
"Bilkays Trucking — better
rates before your renewal"

Open rate updating in Brevo...`
    },
    {
      label: "3/6 — HOT LEAD Replied",
      msg: `🔥 HOT LEAD REPLIED!

Robert D Kortenhaus
Bilkays Trucking Inc
bobby@bilkays.com
4 trucks | Howell NJ

"Hi Richard, yes I'd be open
to a quick conversation. We
haven't shopped our NJ
Manufacturers policy in years"

→ Call or reply NOW
mail.google.com`
    },
    {
      label: "4/6 — Follow-Up Batch",
      msg: `🔁 Follow-Up Batch Done

✅ Sent: 23 follow-ups
📋 Leads contacted 7+ days ago
0 unsubscribes today
0 bounces today

Pipeline:
📤 Contacted: 100
💬 Replied: 1
❄️ Cold: 0`
    },
    {
      label: "5/6 — Unsubscribe Alert",
      msg: `🚫 Unsubscribe Request

zingotrucking@gmail.com
Zingo Trucking LLC
Delran, NJ

Replied: "STOP"

✅ Removed from list
No more emails will be sent
to this contact.`
    },
    {
      label: "6/6 — Daily Summary",
      msg: `📊 Daily Summary
Sunday April 12 2026

Sent today: 100
Replies: 1 🔥
Unsubscribed: 1
Bounced: 0

Pipeline:
New: 1,632
Contacted: 100
Replied: 1

Days to finish list: ~17
Next send: tomorrow 3pm ET`
    },
  ];

  for (let i = 0; i < demos.length; i++) {
    const demo = demos[i];
    log.info(`Sending demo text ${demo.label}...`);
    await sendSMS(demo.msg);
    await new Promise(r => setTimeout(r, 3000));
  }

  log.success("All 6 demo SMS texts sent to (609) 757-2221!");
}

async function main() {
  validateEnv();

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
  log.info(`Leads: ${leads.length} total | ${counts.new} new | ${counts.contacted} contacted | ${counts.replied} replied`);
  log.info(`Sender:       Richard Doron <${process.env.YOUR_EMAIL}>`);
  log.info(`Daily limit:  ${dailyLimit} emails/day`);
  log.info(`Cold:         ${process.env.COLD_CRON || "0 19 * * *"} (3pm ET)`);
  log.info(`Follow-up:    ${process.env.FOLLOWUP_CRON || "30 19 * * *"} (3:30pm ET)`);
  log.info(`SMS alerts:   ${process.env.ALERT_PHONE || "not configured"}`);

  // Send all demo texts on startup
  await sendAllDemoTexts();

  // Send startup email
  await sendNotification(
    "✅ CoverReach Agent Started + SMS Demo Sent",
    `Agent restarted. All 6 demo SMS texts fired to (609) 757-2221.

LEAD STATUS:
New:          ${counts.new}
Contacted:    ${counts.contacted}
Replied:      ${counts.replied}
Unsubscribed: ${counts.unsubscribed}
Bounced:      ${counts.bounced}

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
