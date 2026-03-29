import { getLeads, saveLeads, updateLead, addHistoryEntry, daysSince } from "./leads.js";
import { generateEmail } from "./claude.js";
import { sendEmail, sendNotification } from "./gmail.js";
import { log } from "./logger.js";

const SEND_DELAY_MS   = parseInt(process.env.SEND_DELAY_MS   || "5000");
const MAX_FOLLOWUPS   = parseInt(process.env.MAX_FOLLOWUPS    || "3");
const FOLLOWUP_DAYS   = parseInt(process.env.FOLLOWUP_AFTER_DAYS || "7");

// ── Cold outreach batch ─────────────────────────────────────────────────────
export async function runColdBatch() {
  const leads = getLeads();
  const targets = leads.filter(l => l.status === "new");

  if (!targets.length) {
    log.info("Cold batch: no new leads to contact.");
    return;
  }

  log.cron(`Cold batch starting — ${targets.length} new lead(s)`);
  let sent = 0, failed = 0;

  for (const lead of targets) {
    try {
      log.info(`Generating cold email for ${lead.name} @ ${lead.company}...`);
      const email = await generateEmail(lead, "cold");

      await sendEmail(lead.email, email.subject, email.body);

      updateLead(lead.id, {
        status: "contacted",
        lastContacted: new Date().toISOString(),
        followupCount: 0,
      });
      addHistoryEntry(lead.id, { type: "cold", subject: email.subject });

      log.send(`Sent cold email → ${lead.name} <${lead.email}> | Subject: "${email.subject}"`);
      sent++;

    } catch (err) {
      log.error(`Failed to send to ${lead.name} (${lead.email}): ${err.message}`);
      addHistoryEntry(lead.id, { type: "error", error: err.message });
      failed++;
    }

    await delay(SEND_DELAY_MS);
  }

  log.success(`Cold batch complete — ${sent} sent, ${failed} failed`);

  // Summary notification to yourself
  await sendNotification(
    `📤 CoverReach: Weekly cold batch sent (${sent}/${targets.length})`,
    `Your weekly cold outreach batch just ran.\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}\nTotal leads targeted: ${targets.length}\n\nLog in to Gmail to monitor replies.\n\n— CoverReach Agent`
  );
}

// ── Follow-up batch ─────────────────────────────────────────────────────────
export async function runFollowupBatch() {
  const leads = getLeads();

  // Leads who were contacted but haven't replied, and enough time has passed
  const targets = leads.filter(l =>
    l.status === "contacted" &&
    l.followupCount < MAX_FOLLOWUPS &&
    daysSince(l.lastContacted) >= FOLLOWUP_DAYS
  );

  if (!targets.length) {
    log.info("Follow-up batch: no leads ready for follow-up.");
    return;
  }

  log.cron(`Follow-up batch starting — ${targets.length} lead(s)`);
  let sent = 0, failed = 0;

  for (const lead of targets) {
    try {
      const followupCount = lead.followupCount + 1;
      const campaignType  = followupCount >= MAX_FOLLOWUPS ? "breakup" : "followup";

      log.info(`Generating ${campaignType} email (#${followupCount}) for ${lead.name}...`);
      const email = await generateEmail(lead, campaignType);

      await sendEmail(lead.email, email.subject, email.body);

      updateLead(lead.id, {
        lastContacted: new Date().toISOString(),
        followupCount,
        // Mark as cold after max follow-ups with no reply
        status: followupCount >= MAX_FOLLOWUPS ? "cold" : "contacted",
      });
      addHistoryEntry(lead.id, { type: campaignType, subject: email.subject });

      log.send(`Sent ${campaignType} #${followupCount} → ${lead.name} <${lead.email}>`);
      sent++;

    } catch (err) {
      log.error(`Follow-up failed for ${lead.name}: ${err.message}`);
      addHistoryEntry(lead.id, { type: "error", error: err.message });
      failed++;
    }

    await delay(SEND_DELAY_MS);
  }

  log.success(`Follow-up batch complete — ${sent} sent, ${failed} failed`);

  await sendNotification(
    `🔁 CoverReach: Weekly follow-up batch sent (${sent}/${targets.length})`,
    `Your weekly follow-up batch just ran.\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}\nTotal leads followed up: ${targets.length}\n\n— CoverReach Agent`
  );
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
