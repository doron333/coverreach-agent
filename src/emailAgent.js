import { getLeads, saveLeads, updateLead, addHistoryEntry, daysSince, deduplicateLeads, prioritizeByRenewal } from "./leads.js";
import { generateEmail } from "./claude.js";
import { sendEmail, sendNotification } from "./gmail.js";
import { log } from "./logger.js";

const SEND_DELAY = parseInt(process.env.SEND_DELAY_MS || "5000");
const MAX_FOLLOWUPS = parseInt(process.env.MAX_FOLLOWUPS || "3");
const FOLLOWUP_DAYS = parseInt(process.env.FOLLOWUP_AFTER_DAYS || "7");
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "100");

const SKIP_STATUSES = ["unsubscribed", "bounced", "replied", "cold", "no_email"];

export async function runColdBatch() {
  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Removed ${dupes} duplicates`);
  prioritizeByRenewal();

  const leads = getLeads();

  // Prioritize: dual-pitch first, then trucking, skip no_email
  const eligible = leads.filter(l =>
    l.status === "new" &&
    !SKIP_STATUSES.includes(l.status) &&
    l.email &&
    l.email !== "null"
  );

  // Sort: dual-pitch first, then by renewal urgency
  const sorted = eligible.sort((a, b) => {
    const aScore = a.source === "njcrib_dot" ? 100 : a.source === "njcrib" ? 50 : 0;
    const bScore = b.source === "njcrib_dot" ? 100 : b.source === "njcrib" ? 50 : 0;
    return bScore - aScore;
  });

  const targets = sorted.slice(0, DAILY_LIMIT);

  if (!targets.length) {
    log.info("Cold batch: no leads ready.");
    const counts = {
      new: leads.filter(l => l.status === "new" && l.email).length,
      noEmail: leads.filter(l => l.status === "no_email" || !l.email).length,
    };
    log.info(`Pipeline: ${counts.new} ready | ${counts.noEmail} need email enrichment`);
    await sendDailySummary(leads, 0, 0);
    return;
  }

  const dual = targets.filter(l => l.source === "njcrib_dot").length;
  const wc = targets.filter(l => l.source === "njcrib").length;
  const truck = targets.filter(l => !l.source || l.source === "dot").length;
  log.cron(`Cold batch: ${targets.length} leads (🔥 ${dual} dual-pitch | 🏗️ ${wc} WC | 🚛 ${truck} trucking)`);

  let sent = 0, failed = 0;

  for (const lead of targets) {
    try {
      log.info(`Generating email for ${lead.name || lead.company}...`);
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
      failed++;
    }
    await delay(SEND_DELAY);
  }

  const remaining = getLeads().filter(l => l.status === "new" && l.email).length;
  const noEmail = getLeads().filter(l => l.status === "no_email" || !l.email).length;
  log.success(`Batch done — ✅ ${sent} sent | ❌ ${failed} failed | 📋 ${remaining} ready | ⚠️ ${noEmail} need email`);

  await sendDailySummary(getLeads(), sent, failed);
}

export async function runFollowupBatch() {
  const leads = getLeads();
  const targets = leads.filter(l =>
    l.status === "contacted" &&
    !SKIP_STATUSES.includes(l.status) &&
    l.email &&
    l.followupCount < MAX_FOLLOWUPS &&
    daysSince(l.lastContacted) >= FOLLOWUP_DAYS
  ).slice(0, DAILY_LIMIT);

  if (!targets.length) { log.info("Follow-up batch: no leads ready."); return; }

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
      });
      addHistoryEntry(lead.id, { type, subject: email.subject });
      sent++;
    } catch (err) {
      log.error(`Follow-up failed for ${lead.email}: ${err.message}`);
      failed++;
    }
    await delay(SEND_DELAY);
  }

  log.success(`Follow-up done — ✅ ${sent} sent | ❌ ${failed} failed`);
}

async function sendDailySummary(leads, sentToday, failedToday) {
  const counts = {
    new: leads.filter(l => l.status === "new" && l.email).length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
    cold: leads.filter(l => l.status === "cold").length,
    noEmail: leads.filter(l => l.status === "no_email" || !l.email).length,
    dual: leads.filter(l => l.source === "njcrib_dot").length,
  };

  await sendNotification(
    `📊 CoverReach Daily — ${sentToday} sent`,
    `DAILY SUMMARY
${"=".repeat(45)}
✅ Sent today:    ${sentToday}
❌ Failed:        ${failedToday}

PIPELINE:
📋 Ready to email:     ${counts.new}
🔥 Dual-pitch leads:   ${counts.dual}
📤 Contacted:          ${counts.contacted}
💬 Replied:            ${counts.replied}
⚠️  Need email (NJCRIB): ${counts.noEmail}

At ${DAILY_LIMIT}/day — ${counts.new} leads left = ~${Math.ceil(counts.new/DAILY_LIMIT)} days
${"=".repeat(45)}
Richard Doron | (609) 757-2221`
  );
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
