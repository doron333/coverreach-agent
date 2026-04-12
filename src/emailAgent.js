import { getLeads, saveLeads, updateLead, addHistoryEntry, daysSince, deduplicateLeads, prioritizeByRenewal } from "./leads.js";
import { generateEmail } from "./claude.js";
import { sendEmail, sendNotification } from "./gmail.js";
import { log } from "./logger.js";

const SEND_DELAY = parseInt(process.env.SEND_DELAY_MS || "5000");
const MAX_FOLLOWUPS = parseInt(process.env.MAX_FOLLOWUPS || "3");
const FOLLOWUP_DAYS = parseInt(process.env.FOLLOWUP_AFTER_DAYS || "7");
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "100");

const SKIP_STATUSES = ["unsubscribed", "bounced", "replied", "cold"];

export async function runColdBatch() {
  // Deduplicate first
  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Removed ${dupes} duplicate leads`);

  // Prioritize by renewal date
  prioritizeByRenewal();

  const leads = getLeads();
  const targets = leads
    .filter(l => l.status === "new" && !SKIP_STATUSES.includes(l.status))
    .slice(0, DAILY_LIMIT);

  if (!targets.length) {
    log.info("Cold batch: no new leads to contact.");
    await sendDailySummary(leads, 0, 0);
    return;
  }

  log.cron(`Cold batch starting — ${targets.length} leads (limit: ${DAILY_LIMIT})`);
  let sent = 0, failed = 0, skipped = 0;

  for (const lead of targets) {
    // Check for unsubscribe keywords in notes
    if (lead.notes && /unsubscribe|stop|remove|opt.?out/i.test(lead.notes)) {
      updateLead(lead.id, { status: "unsubscribed" });
      skipped++;
      continue;
    }

    try {
      log.info(`Generating email for ${lead.name || lead.email} @ ${lead.company}...`);
      const email = await generateEmail(lead, "cold");
      await sendEmail(lead.email, email.subject, email.body);

      updateLead(lead.id, {
        status: "contacted",
        lastContacted: new Date().toISOString(),
        followupCount: 0,
        lastSubject: email.subject,
      });
      addHistoryEntry(lead.id, { type: "cold", subject: email.subject });
      sent++;
    } catch (err) {
      log.error(`Failed for ${lead.email}: ${err.message}`);
      addHistoryEntry(lead.id, { type: "error", error: err.message });
      failed++;
    }
    await delay(SEND_DELAY);
  }

  const remaining = getLeads().filter(l => l.status === "new").length;
  log.success(`Cold batch done — ✅ ${sent} sent | ❌ ${failed} failed | ⏭ ${skipped} skipped | 📋 ${remaining} remaining`);

  await sendDailySummary(getLeads(), sent, failed);
}

export async function runFollowupBatch() {
  const leads = getLeads();
  const targets = leads.filter(l =>
    l.status === "contacted" &&
    !SKIP_STATUSES.includes(l.status) &&
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
      const type = followupCount >= MAX_FOLLOWUPS ? "breakup" : followupCount === 2 ? "qualify" : "followup";
      const email = await generateEmail(lead, type);
      await sendEmail(lead.email, email.subject, email.body);

      updateLead(lead.id, {
        lastContacted: new Date().toISOString(),
        followupCount,
        status: followupCount >= MAX_FOLLOWUPS ? "cold" : "contacted",
        lastSubject: email.subject,
      });
      addHistoryEntry(lead.id, { type, subject: email.subject });
      sent++;
    } catch (err) {
      log.error(`Follow-up failed for ${lead.email}: ${err.message}`);
      failed++;
    }
    await delay(SEND_DELAY);
  }

  log.success(`Follow-up batch done — ✅ ${sent} sent | ❌ ${failed} failed`);
}

async function sendDailySummary(leads, sentToday, failedToday) {
  const counts = {
    new: leads.filter(l => l.status === "new").length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
    cold: leads.filter(l => l.status === "cold").length,
    unsubscribed: leads.filter(l => l.status === "unsubscribed").length,
    bounced: leads.filter(l => l.status === "bounced").length,
  };

  const daysRemaining = counts.new > 0 ? Math.ceil(counts.new / DAILY_LIMIT) : 0;

  const body = `COVERREACH DAILY SUMMARY
${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
${"=".repeat(50)}

TODAY'S SEND
✅ Sent:    ${sentToday}
❌ Failed:  ${failedToday}

PIPELINE STATUS
📋 New leads remaining:  ${counts.new}
📤 Contacted:            ${counts.contacted}
💬 Replied:              ${counts.replied}
❄️  Cold (no reply):     ${counts.cold}
🚫 Unsubscribed:         ${counts.unsubscribed}
⚠️  Bounced:             ${counts.bounced}

FORECAST
At ${DAILY_LIMIT} emails/day — ${counts.new} leads remaining = ~${daysRemaining} more days

${"=".repeat(50)}
Richard Doron | Commercial Trucking Insurance Specialist
📞 (609) 757-2221`;

  await sendNotification(`📊 CoverReach Daily Report — ${sentToday} sent today`, body);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
