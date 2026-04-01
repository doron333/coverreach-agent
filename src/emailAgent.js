import { getLeads, saveLeads, updateLead, addHistoryEntry, daysSince } from "./leads.js";
import { generateEmail } from "./claude.js";
import { sendEmail, sendNotification } from "./gmail.js";
import { log } from "./logger.js";

const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || "5000");
const MAX_FOLLOWUPS  = parseInt(process.env.MAX_FOLLOWUPS || "3");
const FOLLOWUP_DAYS  = parseInt(process.env.FOLLOWUP_AFTER_DAYS || "7");
const DAILY_LIMIT    = parseInt(process.env.DAILY_LIMIT || "50");

export async function runColdBatch() {
  const leads = getLeads();
  const targets = leads.filter(l => l.status === "new").slice(0, DAILY_LIMIT);

  if (!targets.length) {
    log.info("Cold batch: no new leads to contact.");
    return;
  }

  log.cron(`Cold batch starting — ${targets.length} leads (daily limit: ${DAILY_LIMIT})`);
  let sent = 0, failed = 0;

  for (const lead of targets) {
    try {
      log.info(`Generating cold email for ${lead.name || lead.email} @ ${lead.company}...`);
      const email = await generateEmail(lead, "cold");
      await sendEmail(lead.email, email.subject, email.body);

      updateLead(lead.id, {
        status: "contacted",
        lastContacted: new Date().toISOString(),
        followupCount: 0,
      });
      addHistoryEntry(lead.id, { type: "cold", subject: email.subject });
      log.send(`Sent cold email → ${lead.email} | "${email.subject}"`);
      sent++;
    } catch (err) {
      log.error(`Failed for ${lead.email}: ${err.message}`);
      addHistoryEntry(lead.id, { type: "error", error: err.message });
      failed++;
    }
    await delay(SEND_DELAY_MS);
  }

  const remaining = leads.filter(l => l.status === "new").length - sent;
  log.success(`Cold batch complete — ${sent} sent, ${failed} failed, ${remaining} leads remaining`);

  await sendNotification(
    `📤 CoverReach: Daily batch sent (${sent}/${targets.length})`,
    `Daily cold outreach batch complete.\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n📋 Remaining leads: ${remaining}\n\nAt this rate, all leads will be contacted in ${Math.ceil(remaining/DAILY_LIMIT)} more days.\n\n— CoverReach Agent`
  );
}

export async function runFollowupBatch() {
  const leads = getLeads();
  const targets = leads.filter(l =>
    l.status === "contacted" &&
    l.followupCount < MAX_FOLLOWUPS &&
    daysSince(l.lastContacted) >= FOLLOWUP_DAYS
  ).slice(0, DAILY_LIMIT);

  if (!targets.length) {
    log.info("Follow-up batch: no leads ready.");
    return;
  }

  log.cron(`Follow-up batch — ${targets.length} leads`);
  let sent = 0, failed = 0;

  for (const lead of targets) {
    try {
      const followupCount = lead.followupCount + 1;
      const campaignType  = followupCount >= MAX_FOLLOWUPS ? "breakup" : "followup";
      const email = await generateEmail(lead, campaignType);
      await sendEmail(lead.email, email.subject, email.body);

      updateLead(lead.id, {
        lastContacted: new Date().toISOString(),
        followupCount,
        status: followupCount >= MAX_FOLLOWUPS ? "cold" : "contacted",
      });
      addHistoryEntry(lead.id, { type: campaignType, subject: email.subject });
      log.send(`Sent ${campaignType} → ${lead.email}`);
      sent++;
    } catch (err) {
      log.error(`Follow-up failed for ${lead.email}: ${err.message}`);
      failed++;
    }
    await delay(SEND_DELAY_MS);
  }

  log.success(`Follow-up batch complete — ${sent} sent, ${failed} failed`);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
