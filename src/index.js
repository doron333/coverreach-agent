import "dotenv/config";
import cron from "node-cron";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkReplies } from "./replyWatcher.js";
import { log } from "./logger.js";
import { getLeads } from "./leads.js";

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "YOUR_EMAIL"];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function resendEmail(to, subject, text) {
  const fromName = process.env.SENDER_NAME || "Matt Doron";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <onboarding@resend.dev>`,
      to: [to],
      subject,
      text,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

async function generateEmail(type, lead) {
  const senderName = process.env.SENDER_NAME || "Matt Doron";
  const prompts = {
    cold: `Write a cold outreach email for insurance prospect: Company: ${lead.company}, Role: ${lead.role || "Insurance Professional"}, Type: ${lead.type || "Commercial General Liability"}. First touch, under 150 words, genuine, no hard sell, end with soft question. Sign off as: ${senderName} | Insurance Solutions Specialist. Return ONLY JSON: {"subject":"...","body":"..."}`,
    followup: `Write a follow-up email (no reply after 7 days) for: Company: ${lead.company}, Type: ${lead.type || "Commercial General Liability"}. Warm, not pushy, under 120 words. Sign off as: ${senderName} | Insurance Solutions Specialist. Return ONLY JSON: {"subject":"...","body":"..."}`,
    qualify: `Write a qualification email asking 1-2 discovery questions for: Company: ${lead.company}, Type: ${lead.type || "Commercial General Liability"}. Under 130 words. Sign off as: ${senderName} | Insurance Solutions Specialist. Return ONLY JSON: {"subject":"...","body":"..."}`,
    breakup: `Write a final break-up email for: Company: ${lead.company}, Type: ${lead.type || "Commercial General Liability"}. Under 100 words, graceful, leave door open. Sign off as: ${senderName} | Insurance Solutions Specialist. Return ONLY JSON: {"subject":"...","body":"..."}`,
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: "Insurance sales email writer. Output ONLY valid JSON {subject, body}. No markdown.",
      messages: [{ role: "user", content: prompts[type] }],
    }),
  });
  const data = await res.json();
  const text = data.content?.map(b => b.text || "").join("") || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function sendDemoEmails() {
  const testEmail = process.env.TEST_EMAIL;
  if (!testEmail) { log.info("No TEST_EMAIL — skipping demos"); return; }

  log.info(`Sending 5 demo emails to ${testEmail}...`);

  const lead = { company: "Kline Insurance Group", role: "Principal Broker", type: "Commercial General Liability" };
  const demos = [
    { type: "cold",     label: "❄️ Cold Outreach",  note: "First email — sent daily at 11:45am to 50 new leads" },
    { type: "followup", label: "🔁 Follow-Up",       note: "Sent if no reply after 7 days" },
    { type: "qualify",  label: "🎯 Qualify Lead",    note: "Discovery questions after 14 days" },
    { type: "breakup",  label: "👋 Break-Up Email",  note: "Final email after 21 days" },
  ];

  for (let i = 0; i < demos.length; i++) {
    const demo = demos[i];
    try {
      log.info(`Generating ${demo.label}...`);
      const email = await generateEmail(demo.type, lead);
      await new Promise(r => setTimeout(r, 1500));
      await resendEmail(
        testEmail,
        `[DEMO ${i+1}/5] ${demo.label} — CoverReach`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${demo.label.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT THIS IS: ${demo.note}
SAMPLE LEAD: Sandra Kline | ${lead.company}

─────────────────────────────────
SUBJECT: ${email.subject}
─────────────────────────────────

${email.body}

─────────────────────────────────
Every lead gets a unique personalized version.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
— CoverReach AI Agent`
      );
      log.success(`Sent demo ${i+1}/5: ${demo.label}`);
    } catch(err) { log.error(`Demo ${i+1} failed: ${err.message}`); }
  }

  try {
    await resendEmail(
      testEmail,
      `[DEMO 5/5] 🔔 Reply Notification — CoverReach`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REPLY NOTIFICATION — LEAD RESPONDED!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You get this the MOMENT a lead replies.

Great news — Sandra Kline just replied!

Name:     Sandra Kline
Company:  Kline Insurance Group
Email:    s.kline@klineins.com

Their reply subject: "Re: Quick question about coverage"
Message: "Hi, I would be open to a quick call..."

Open Gmail to respond: https://mail.google.com

The agent has stopped all automated emails
to this contact automatically.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
— CoverReach AI Agent`
    );
    log.success("Sent demo 5/5: Reply Notification");
  } catch(err) { log.error(`Reply demo failed: ${err.message}`); }

  log.success(`All 5 demo emails sent to ${testEmail}!`);
}

async function main() {
  validateEnv();

  const leads = getLeads();
  const counts = {
    new: leads.filter(l => l.status === "new").length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
  };

  const dailyLimit = parseInt(process.env.DAILY_LIMIT || "50");

  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║         Running 24/7 on your server          ║
╚══════════════════════════════════════════════╝
`);
  log.info(`Loaded ${leads.length} leads — new: ${counts.new}, contacted: ${counts.contacted}, replied: ${counts.replied}`);
  log.info(`Sender:       ${process.env.SENDER_NAME} <${process.env.YOUR_EMAIL}>`);
  log.info(`Daily limit:  ${dailyLimit} emails/day`);
  log.info(`Cold schedule:      ${process.env.COLD_CRON || "45 11 * * *"}`);
  log.info(`Follow-up schedule: ${process.env.FOLLOWUP_CRON || "0 10 * * *"}`);
  log.info(`Reply check:        ${process.env.REPLY_CHECK_CRON || "*/30 * * * *"}`);
  log.info(`At ${dailyLimit}/day — all ${counts.new} new leads contacted in ~${Math.ceil(counts.new/dailyLimit)} days`);

  await sendDemoEmails();

  const coldCron       = process.env.COLD_CRON        || "45 11 * * *";
  const followupCron   = process.env.FOLLOWUP_CRON    || "0 10 * * *";
  const replyCheckCron = process.env.REPLY_CHECK_CRON || "*/30 * * * *";

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

  log.success("All schedules active. Agent is running 24/7.");

  setInterval(() => {
    const leads = getLeads();
    log.info(`Heartbeat — ${leads.length} leads | ${leads.filter(l=>l.status==="new").length} new | ${leads.filter(l=>l.status==="replied").length} replies`);
  }, 60 * 60 * 1000);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
