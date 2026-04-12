import "dotenv/config";
import cron from "node-cron";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkReplies } from "./replyWatcher.js";
import { log } from "./logger.js";
import { getLeads, deduplicateLeads, prioritizeByRenewal } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { sendSMS } from "./sms.js";

// build: 1776033725

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "BREVO_API_KEY", "YOUR_EMAIL"];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function sendAllDemoTexts() {
  const alertPhone = process.env.ALERT_PHONE;
  log.info(`SMS demo firing to ${alertPhone}...`);

  const msgs = [
    `CoverReach TEST 1/6\nAgent is LIVE!\n1,721 leads loaded\nNext send: 3pm ET\nRichard Doron (609) 757-2221`,
    `CoverReach TEST 2/6\nBatch Done\nSent: 100 emails\nFailed: 0\nRemaining: 1,621`,
    `CoverReach TEST 3/6\nHOT LEAD!\nRobert Kortenhaus\nBilkays Trucking\n"Yes I'd like a quote"\nCALL NOW!`,
    `CoverReach TEST 4/6\nFollow-Ups Sent\n23 follow-ups\n0 unsubscribes\n0 bounces`,
    `CoverReach TEST 5/6\nUnsubscribe Alert\nZingo Trucking\nDelran NJ\nRemoved from list`,
    `CoverReach TEST 6/6\nDaily Summary\nSent: 100\nReplies: 1\nRemaining: 1,621\nNext: tomorrow 3pm`,
  ];

  for (let i = 0; i < msgs.length; i++) {
    log.info(`Sending text ${i+1}/6...`);
    await sendSMS(msgs[i]);
    await new Promise(r => setTimeout(r, 5000));
  }

  log.success(`All 6 SMS sent to ${alertPhone}!`);
}

async function main() {
  validateEnv();

  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Removed ${dupes} duplicate leads`);
  prioritizeByRenewal();

  const leads = getLeads();
  const counts = {
    new: leads.filter(l => l.status === "new").length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
  };

  const dailyLimit = parseInt(process.env.DAILY_LIMIT || "100");

  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║         Running 24/7 on your server          ║
╚══════════════════════════════════════════════╝
`);
  log.info(`Leads: ${leads.length} total | ${counts.new} new | ${counts.contacted} contacted | ${counts.replied} replied`);
  log.info(`Sender: Richard Doron <${process.env.YOUR_EMAIL}>`);
  log.info(`Daily limit: ${dailyLimit} emails/day`);
  log.info(`SMS alerts: ${process.env.ALERT_PHONE || "not configured"}`);
  log.info(`Build timestamp: 1776033725`);

  await sendAllDemoTexts();

  cron.schedule(process.env.COLD_CRON || "0 19 * * *", async () => {
    log.cron("Triggered: daily cold outreach batch");
    try { await runColdBatch(); }
    catch (err) { log.error(`Cold batch crashed: ${err.message}`); }
  });

  cron.schedule(process.env.FOLLOWUP_CRON || "30 19 * * *", async () => {
    log.cron("Triggered: daily follow-up batch");
    try { await runFollowupBatch(); }
    catch (err) { log.error(`Follow-up batch crashed: ${err.message}`); }
  });

  cron.schedule(process.env.REPLY_CHECK_CRON || "*/30 * * * *", async () => {
    try { await checkReplies(); }
    catch (err) { log.error(`Reply check crashed: ${err.message}`); }
  });

  log.success("All schedules active. Agent running 24/7.");

  setInterval(() => {
    const leads = getLeads();
    log.info(`Heartbeat — ${leads.filter(l=>l.status==="new").length} new | ${leads.filter(l=>l.status==="replied").length} replies`);
  }, 60 * 60 * 1000);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
