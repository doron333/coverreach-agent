import { getLeads, saveLeads, updateLead, addHistoryEntry, daysSince, deduplicateLeads, prioritizeByRenewal, getHotWindowLeads } from "./leads.js";
import { generateEmail } from "./claude.js";
import { sendEmail, sendNotification } from "./gmail.js";
import { persistLeadsToGitHub } from "./persist.js";
import { logTouch } from "./touchlog.js";
import { validateEmail } from "./validate.js";
import { log } from "./logger.js";

const SEND_DELAY = parseInt(process.env.SEND_DELAY_MS || "5000");
const MAX_FOLLOWUPS = parseInt(process.env.MAX_FOLLOWUPS || "3");
const FOLLOWUP_DAYS = parseInt(process.env.FOLLOWUP_AFTER_DAYS || "7");
// ⚠️ THROTTLED 7/22 — REPUTATION & PIPELINE PROTECTION
// Brevo logs show 162 rejections reading "554 5.7.9 failed authentication".
// Cause: we send as @gmail.com through Brevo with NO authenticated domain,
// so SPF/DKIM/DMARC alignment fails and receivers reject or spam-folder us.
//
// Sending at full volume while this is broken does two kinds of damage:
//   1. Teaches mailbox providers this sender is untrustworthy
//   2. BURNS LEADS — each send marks the lead "contacted", so a prospect whose
//      email landed in spam is spent for this cycle and never re-approached.
//
// TO RESTORE FULL VOLUME once a sending domain is authenticated in Brevo
// (Senders → Domains → add domain → publish DKIM/SPF DNS records, then send
// from e.g. rdoron@<yourdomain>), change SAFE_LIMIT back to 250.
const SAFE_LIMIT = 40;
const DAILY_LIMIT = Math.min(
  Math.max(parseInt(process.env.DAILY_LIMIT || "250"), 1),
  SAFE_LIMIT
);

const SKIP_STATUSES = ["unsubscribed", "bounced", "replied", "cold", "no_email"];

/**
 * IMPROVED HYBRID BATCH STRATEGY
 */

/**
 * Filter a candidate list down to addresses that will actually deliver.
 * Invalid addresses are permanently marked "bounced" so they are never retried,
 * and never counted against the daily send budget.
 *
 * Over-fetches candidates so a full batch still goes out after culling.
 */
async function takeSendable(candidates, limit) {
  const out = [];
  let culled = 0;
  for (const lead of candidates) {
    if (out.length >= limit) break;
    const v = await validateEmail(lead.email);
    if (!v.ok) {
      updateLead(lead.id, {
        status: "bounced",
        campaignEligible: false,
        bounceReason: `prevalidate:${v.reason}`,
      });
      culled++;
      continue;
    }
    if (v.email !== lead.email) {
      updateLead(lead.id, { email: v.email });
      lead.email = v.email;
    }
    out.push(lead);
  }
  if (culled) log.warn(`Pre-send validation culled ${culled} undeliverable addresses (protects sender reputation)`);
  return out;
}

export async function runColdBatch() {
  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Removed ${dupes} duplicates`);

  prioritizeByRenewal();
  const allLeads = getLeads();

  const hotLeads = getHotWindowLeads(allLeads);
  const sortedHot = hotLeads.sort((a, b) => {
    if (a.cancellation && !b.cancellation) return -1;
    if (!a.cancellation && b.cancellation) return 1;
    const aDays = a._daysToRenewal ?? 999;
    const bDays = b._daysToRenewal ?? 999;
    return aDays - bDays;
  });

  const hotTargets = await takeSendable(sortedHot, DAILY_LIMIT);

  let sent = 0;
  let failed = 0;

  if (hotTargets.length > 0) {
    const dual = hotTargets.filter(l => l.source === "njcrib_dot").length;
    const wc = hotTargets.filter(l => l.source === "njcrib").length;
    const truck = hotTargets.filter(l => !l.source || l.source === "dot").length;

    log.cron(`HOT WINDOW batch: ${hotTargets.length} leads (🔥 ${dual} dual | 🏗️ ${wc} WC | 🚛 ${truck} trucking)`);

    for (const lead of hotTargets) {
      try {
        log.info(`Generating HOT email for ${lead.name || lead.company}...`);
        const email = await generateEmail(lead, "cold");

        await sendEmail(lead.email, email.subject, email.body);

        updateLead(lead.id, {
          status: "contacted",
          lastContacted: new Date().toISOString(),
          followupCount: 0,
          lastSubject: email.subject,
        });
        addHistoryEntry(lead.id, { type: "cold", subject: email.subject });
        logTouch(lead, "cold", email.subject);
        sent++;

        if (sent % 25 === 0) {
          await persistLeadsToGitHub(`Hot batch checkpoint: ${sent} sent`).catch(() => {});
        }
      } catch (err) {
        log.error(`Hot batch failed for ${lead.email}: ${err.message}`);
        failed++;
      }
      await delay(SEND_DELAY);
    }
  } else {
    log.info("No leads currently in the hot renewal window.");
  }

  const remainingBudget = DAILY_LIMIT - sent;
  if (remainingBudget > 0) {
    const nurtureCandidates = allLeads.filter(l => {
      if (!l.email || l.email === "null") return false;
      if (SKIP_STATUSES.includes(l.status)) return false;
      if (hotLeads.some(h => h.id === l.id)) return false;

      const daysSinceContact = daysSince(l.lastContacted);
      // Guard: only nurture leads we've ACTUALLY contacted before.
      // daysSince(null) returns 999, which made every never-contacted lead
      // (including Sept/Oct renewals) eligible — premature outreach bug.
      if (!l.lastContacted) return false;
      return daysSinceContact > 75;
    });

    const sortedNurture = nurtureCandidates.sort((a, b) => {
      return daysSince(b.lastContacted) - daysSince(a.lastContacted);
    });

    const nurtureTargets = await takeSendable(sortedNurture, remainingBudget);

    if (nurtureTargets.length > 0) {
      log.cron(`NURTURE batch: ${nurtureTargets.length} long-neglected leads (using remaining daily capacity)`);

      for (const lead of nurtureTargets) {
        try {
          log.info(`Generating NURTURE email for ${lead.name || lead.company}...`);
          const email = await generateEmail(lead, "cold");

          await sendEmail(lead.email, email.subject, email.body);

          updateLead(lead.id, {
            status: "contacted",
            lastContacted: new Date().toISOString(),
            followupCount: 0,
            lastSubject: email.subject,
          });
          addHistoryEntry(lead.id, { type: "nurture", subject: email.subject });
          logTouch(lead, "nurture", email.subject);
          sent++;

          if (sent % 25 === 0) {
            await persistLeadsToGitHub(`Nurture checkpoint: ${sent} sent`).catch(() => {});
          }
        } catch (err) {
          log.error(`Nurture failed for ${lead.email}: ${err.message}`);
          failed++;
        }
        await delay(SEND_DELAY);
      }
    }
  }

  const remainingHot = getHotWindowLeads(getLeads()).length;
  log.success(`Cold batch complete — ✅ ${sent} sent | ❌ ${failed} failed | 📋 ${remainingHot} hot leads still in window`);

  await persistLeadsToGitHub(`Cold batch: ${sent} sent today`);
  await sendDailySummary(getLeads(), sent, failed);
}

export async function runFollowupBatch() {
  const leads = getLeads();
  const followupCandidates = leads.filter(l =>
    l.status === "contacted" &&
    !SKIP_STATUSES.includes(l.status) &&
    l.email &&
    l.followupCount < MAX_FOLLOWUPS &&
    daysSince(l.lastContacted) >= FOLLOWUP_DAYS
  );
  const targets = await takeSendable(followupCandidates, DAILY_LIMIT);

  if (!targets.length) {
    log.info("Follow-up batch: no leads ready.");
    return;
  }

  log.cron(`Follow-up batch — ${targets.length} leads`);

  let sent = 0;
  let failed = 0;

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
      logTouch(lead, type, email.subject);
      sent++;

      if (sent % 25 === 0) {
        await persistLeadsToGitHub(`Follow-up checkpoint: ${sent} sent`).catch(() => {});
      }
    } catch (err) {
      log.error(`Follow-up failed for ${lead.email}: ${err.message}`);
      failed++;
    }
    await delay(SEND_DELAY);
  }

  log.success(`Follow-up done — ✅ ${sent} sent | ❌ ${failed} failed`);
  await persistLeadsToGitHub(`Follow-up batch: ${sent} sent`);
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

  const hotWindow = getHotWindowLeads(leads).length;

  await sendNotification(
    `📊 CoverReach Daily — ${sentToday} sent`,
    `DAILY SUMMARY
${"=".repeat(50)}
✅ Sent today:           ${sentToday}
❌ Failed:               ${failedToday}

HOT WINDOW (30-60 days):
📋 Leads ready now:      ${hotWindow}

PIPELINE STATUS:
📋 New / Ready:          ${counts.new}
🔥 Dual-pitch leads:     ${counts.dual}
📤 Contacted (active):   ${counts.contacted}
💬 Replied:              ${counts.replied}
⚠️  Need email (NJCRIB): ${counts.noEmail}

STRATEGY: Hot window first → Nurture long-neglected leads with remaining capacity.
This ensures we eventually touch every lead while focusing on highest-conversion timing.

Richard Doron | (609) 757-2221`
  );
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
