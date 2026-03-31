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
      to,
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
    cold: `Write a cold outreach email for insurance prospect: Company: ${lead.company}, Role: ${lead.role}, Type: ${lead.type}. First touch, under 150 words, genuine, no hard sell, end with soft question. Sign off as: ${senderName} | Insurance Solutions Specialist. Return ONLY JSON: {"subject":"...","body":"..."}`,
    followup: `Write a follow-up email (no reply after 7 days) for: Company: ${lead.company}, Type: ${lead.type}. Warm, not pushy, under 120 words. Reference previous outreach. Sign off as: ${senderName} | Insurance Solutions Specialist. Return ONLY JSON: {"subject":"...","body":"..."}`,
    qualify: `Write a qualification email asking 1-2 discovery questions for: Company: ${lead.company}, Type: ${lead.type}. Under 130 words. Sign off as: ${senderName} | Insurance Solutions Specialist. Return ONLY JSON: {"subject":"...","body":"..."}`,
    breakup: `Write a final break-up email for: Company: ${lead.company}, Type: ${lead.type}. Under 100 words, graceful, leave door open. Sign off as: ${senderName} | Insurance Solutions Specialist. Return ONLY JSON: {"subject":"...","body":"..."}`,
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

  const lead = {
    company: "Kline Insurance Group",
    role: "Principal Broker",
    type: "Commercial General Liability",
  };

  const demos = [
    { type: "cold", label: "❄️ Cold Outreach", note: "First email — sent every Monday 9am to new leads" },
    { type: "followup", label: "🔁 Follow-Up", note: "Sent Thursday if no reply after 7 days" },
    { type: "qualify", label: "🎯 Qualify Lead", note: "Sent after 14 days with no reply" },
    { type: "breakup", label: "👋 Break-Up Email", note: "Final email — after this lead is marked cold" },
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
Every lead gets a unique AI-generated version
personalized to their company and insurance type.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
— CoverReach AI Agent`
      );
      log.success(`Sent demo ${i+1}/5: ${demo.label}`);
    } catch(err) {
      log.error(`Demo ${i+1} failed: ${err.message}`);
    }
  }

  // Reply notification demo
  try {
    await resendEmail(
      testEmail,
      `[DEMO 5/5] 🔔 Reply Notification — CoverReach`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REPLY NOTIFICATION — LEAD RESPONDED!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT THIS IS: You get this email the MOMENT
a lead replies to any of your outreach emails.

Great news — Sandra Kline just replied!

─────────────────────────────────
LEAD DETAILS
─────────────────────────────────
Name:     Sandra Kline
Company:  Kline Insurance Group
Email:    s.kline@klineins.com
Type:     Commercial General Liability

─────────────────────────────────
THEIR REPLY
─────────────────────────────────
Subject:  Re: Quick question about your coverage
Message:  "Hi, yes I'd be open to a quick call 
           to discuss our current coverage..."

Open Gmail to respond:
→ https://mail.google.com

─────────────────────────────────
WHAT TO DO NEXT
─────────────────────────────────
1. Open Gmail and read their full reply
2. Respond personally — this is a warm lead!
3. Agent has stopped all automated emails
   to this contact automatically.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
— CoverReach AI Agent`
    );
    log.success("Sent demo 5/5: Reply Notification");
  } catch(err) {
    log.error(`Reply demo failed: ${err.message}`);
  }

  log.success("All 5 demo emails sent to " + testEmail);
}

async function main() {
  validateEnv();

  const leads = getLeads();
  const counts = {
    new: leads.filter(l => l.status === "new").length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
  };

  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║         Running 24/7 on your server          ║
╚══════════════════════════════════════════════╝
`);
  log.info(`Loaded ${leads.length} leads — new: ${counts.new}, contacted: ${counts.contacted}, replied: ${counts.replied}`);
  log.info(`Sender: ${process.env.SENDER_NAME} <${process.env.YOUR_EMAIL}>`);
  log.info(`Cold schedule:      ${process.env.COLD_CRON || "0 9 * * 1"} (Mon 9am)`);
  log.info(`Follow-up schedule: ${process.env.FOLLOWUP_CRON || "0 10 * * 4"} (Thu 10am)`);
  log.info(`Reply check:        ${process.env.REPLY_CHECK_CRON || "*/30 * * * *"} (every 30 min)`);

  // Send demo emails on startup if TEST_EMAIL is set
  await sendDemoEmails();

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

  log.success("All schedules active. Agent is running 24/7.");

  setInterval(() => {
    const leads = getLeads();
    log.info(`Heartbeat — ${leads.length} leads | ${leads.filter(l=>l.status==="replied").length} replies`);
  }, 60 * 60 * 1000);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
