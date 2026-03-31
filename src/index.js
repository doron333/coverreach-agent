import "dotenv/config";
import cron from "node-cron";
import nodemailer from "nodemailer";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkReplies } from "./replyWatcher.js";
import { log } from "./logger.js";
import { getLeads } from "./leads.js";

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "GMAIL_APP_PASSWORD", "YOUR_EMAIL"];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing required environment variables:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
}

function getTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.YOUR_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

async function generateEmail(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: "You are an expert insurance sales email copywriter. Output ONLY valid JSON with keys subject and body. No markdown.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const text = data.content?.map(b => b.text || "").join("") || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function sendDemoEmails() {
  const testEmail = process.env.TEST_EMAIL;
  if (!testEmail) return;

  const transporter = getTransporter();
  const sender = process.env.YOUR_EMAIL;
  const senderName = process.env.SENDER_NAME || "Matt Doron";

  const sampleLead = {
    name: "Sandra Kline",
    company: "Kline Insurance Group",
    role: "Principal Broker",
    type: "Commercial General Liability",
    email: "s.kline@klineins.com",
    notes: "20-person independent brokerage in Cherry Hill NJ"
  };

  const basePrompt = (type, extra) => `Write a ${type} email for this insurance prospect:
Name: ${sampleLead.name}, Company: ${sampleLead.company}, Role: ${sampleLead.role}, Type: ${sampleLead.type}, Notes: ${sampleLead.notes}
${extra}
Sign off as: ${senderName} | Insurance Solutions Specialist
Return ONLY JSON: {"subject":"...","body":"..."}`;

  log.info("Generating demo emails — this takes about 30 seconds...");

  const demos = [
    {
      label: "EMAIL 1 — COLD OUTREACH",
      color: "❄️",
      prompt: basePrompt("cold outreach", "First touch. Under 150 words. Genuine, no hard sell. End with a soft question."),
      note: "This is the FIRST email your lead receives on Monday morning."
    },
    {
      label: "EMAIL 2 — FOLLOW-UP (Day 7)",
      color: "🔁",
      prompt: basePrompt("follow-up", "They haven't replied to the first email. Warm, not pushy. Reference previous outreach. Under 120 words."),
      note: "Sent automatically if no reply after 7 days."
    },
    {
      label: "EMAIL 3 — QUALIFY LEAD (Day 14)",
      color: "🎯",
      prompt: basePrompt("qualification", "Ask 1-2 discovery questions about their current insurance setup. Under 130 words."),
      note: "Sent if still no reply — tries to start a conversation."
    },
    {
      label: "EMAIL 4 — BREAK-UP (Day 21)",
      color: "👋",
      prompt: basePrompt("break-up", "Final attempt. Under 100 words. Graceful, leave door open, no pressure."),
      note: "Last email — after this the lead is marked cold."
    },
    {
      label: "REPLY NOTIFICATION — When a lead responds",
      color: "🔔",
      prompt: null, // special case
      note: "This is what YOU receive the moment a lead replies to any email."
    },
  ];

  for (let i = 0; i < demos.length; i++) {
    const demo = demos[i];
    await new Promise(r => setTimeout(r, 2000));

    let subject, body;

    if (demo.prompt) {
      try {
        const email = await generateEmail(demo.prompt);
        subject = `[DEMO ${i+1}/5] ${demo.color} ${demo.label}`;
        body = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${demo.label}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📌 WHAT THIS IS: ${demo.note}

📧 LEAD: ${sampleLead.name} | ${sampleLead.company} | ${sampleLead.email}

─────────────────────────────────────────
SUBJECT: ${email.subject}
─────────────────────────────────────────

${email.body}

─────────────────────────────────────────
✅ This email is AI-generated in real time using the lead's
   name, company, and insurance type. Every lead gets a 
   unique personalized version.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
— CoverReach AI Agent`;
      } catch(e) {
        log.error(`Failed to generate demo ${i+1}: ${e.message}`);
        continue;
      }
    } else {
      // Reply notification demo
      subject = `[DEMO 5/5] 🔔 ${demo.label}`;
      body = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REPLY NOTIFICATION — LEAD RESPONDED!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📌 WHAT THIS IS: ${demo.note}

Great news — Sandra Kline just replied to your outreach!

─────────────────────────────────────────
LEAD DETAILS
─────────────────────────────────────────
Name:     Sandra Kline
Title:    Principal Broker
Company:  Kline Insurance Group
Email:    s.kline@klineins.com
Type:     Commercial General Liability
Notes:    20-person independent brokerage in Cherry Hill NJ

─────────────────────────────────────────
THEIR REPLY
─────────────────────────────────────────
Subject:  Re: Quick question about your liability coverage
Date:     Monday, March 30, 2026

(Open Gmail to read and respond)
→ https://mail.google.com

─────────────────────────────────────────
OUTREACH HISTORY
─────────────────────────────────────────
  • Mar 30 — cold: "Quick question about your liability coverage"
  • Apr 6  — followup: "Following up — Kline Insurance Group"

─────────────────────────────────────────
WHAT TO DO NEXT
─────────────────────────────────────────
1. Open Gmail and read their reply
2. Respond personally — this is now a warm lead!
3. The agent has marked them as "replied" and stopped 
   sending automated emails to this contact.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
— CoverReach AI Agent`;
    }

    try {
      await transporter.sendMail({
        from: `CoverReach Agent <${sender}>`,
        to: testEmail,
        subject,
        text: body,
      });
      log.success(`Sent demo ${i+1}/5: ${demo.label}`);
    } catch(e) {
      log.error(`Failed to send demo ${i+1}: ${e.message}`);
    }
  }

  log.success("All 5 demo emails sent! Check your inbox.");
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
