import { getLeads, saveLeads, updateLead, addHistoryEntry, daysSince, deduplicateLeads, prioritizeByRenewal, getHotWindowLeads } from "./leads.js";
import { generateEmail } from "./claude.js";
import { sendEmail, sendNotification } from "./gmail.js";
import { persistLeadsToGitHub } from "./persist.js";
import { logTouch } from "./touchlog.js";
import { validateEmail } from "./validate.js";
import { log } from "./logger.js";

const SEND_DELAY = parseInt(process.env.SEND_DELAY_MS || "5000");
// One follow-up only (8/7, Matt's call). Was a 3-touch sequence over 21 days,
// but with the runway floor at 10 days the later touches would land after the
// prospect's renewal had already passed. A single well-timed nudge fits; a
// long sequence does not.
const MAX_FOLLOWUPS = parseInt(process.env.MAX_FOLLOWUPS || "1");
const FOLLOWUP_DAYS = parseInt(process.env.FOLLOWUP_AFTER_DAYS || "7");
// ── SENDING VOLUME: AUTOMATIC WARM-UP RAMP ──────────────────────────────────
//
// 8/7/2026: outreach.centraljerseyins.com is authenticated. Google confirms
// spf=pass, dkim=pass, dmarc=pass. The old failure (554 5.7.9) is resolved.
//
// But the domain is BRAND NEW and has no sending reputation. Mailbox providers
// distrust unknown domains that suddenly send at volume, regardless of how
// well they authenticate. Authentication makes you eligible for the inbox;
// reputation is what actually gets you there, and it is earned by sending
// modest, consistent volume with few complaints over a couple of weeks.
//
// Blowing past this would burn CJIA's real domain — a far more expensive
// mistake than burning a throwaway Gmail. So volume ramps on a schedule.
//
// To go straight to full volume anyway, set DAILY_LIMIT_OVERRIDE in Railway.
const WARMUP_START = process.env.WARMUP_START_DATE || "2026-08-07";
const WARMUP_SCHEDULE = [
  { throughDay: 3,  limit: 40 },   // days 0-3   establish a baseline
  { throughDay: 7,  limit: 80 },   // days 4-7   double
  { throughDay: 11, limit: 150 },  // days 8-11
  { throughDay: 14, limit: 200 },  // days 12-14
];
const FULL_VOLUME = 250;

// The warm-up number is a TOTAL DAILY BUDGET across cold + follow-up batches,
// not a per-batch cap. Previously each batch got the full limit, so "250/day"
// was really 500/day — which is exactly the kind of surprise volume spike that
// gets a new domain flagged. Cold outreach gets 60% of the budget, follow-ups
// 40%, since follow-ups go to people who already received (and tolerated) mail.
// The daily number is a TOTAL budget shared by cold outreach and follow-ups.
// Follow-ups only reserve what they will actually use — if none are pending,
// the entire budget goes to cold outreach rather than sitting idle. Cold runs
// first, so it needs to know in advance how much to leave behind.
function pendingFollowups() {
  try {
    const leads = getLeads();
    return leads.filter(l =>
      l.status === "contacted" &&
      l.email &&
      (l.followupCount || 0) < MAX_FOLLOWUPS &&
      daysSince(l.lastContacted) >= FOLLOWUP_DAYS
    ).length;
  } catch {
    return 0;
  }
}

// Follow-ups may claim up to 40% of the day, but never more than they need.
function followupBudget() {
  const share = Math.round(warmupLimit() * 0.4);
  return Math.min(share, pendingFollowups());
}

// Cold gets everything follow-ups are not going to use.
function coldBudget() {
  return Math.max(1, warmupLimit() - followupBudget());
}

function warmupLimit() {
  const override = parseInt(process.env.DAILY_LIMIT_OVERRIDE || "0");
  if (override > 0) return override;

  const start = new Date(`${WARMUP_START}T00:00:00Z`);
  const dayNum = Math.floor((Date.now() - start.getTime()) / 86400000);
  if (dayNum < 0) return WARMUP_SCHEDULE[0].limit;

  for (const step of WARMUP_SCHEDULE) {
    if (dayNum <= step.throughDay) return step.limit;
  }
  return FULL_VOLUME;
}

// Evaluated per batch so the ramp advances on its own, no redeploy needed.

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

/**
 * A renewal that has already passed is not an opportunity — it is a stale
 * record. Emailing someone in August about their July renewal makes us look
 * like we are working from old data, and it burns sending reputation on a
 * message that cannot convert.
 *
 * Cancellations are the exception: if a carrier dropped them, they still need
 * coverage regardless of what the renewal date said.
 */
function renewalHasPassed(lead) {
  if (lead.cancellation) return false;
  if (!lead.renewalDate) return false;
  const [m, d, y] = String(lead.renewalDate).split("/").map(Number);
  if (!m || !d || !y) return false;
  return new Date(y, m - 1, d).getTime() < Date.now();
}

/**
 * @param {{maxSends?: number}} opts - maxSends caps this run only. Used by the
 *   manual /run-cold endpoint so a test run cannot exceed the warm-up budget.
 */
export async function runColdBatch(opts = {}) {
  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Removed ${dupes} duplicates`);

  prioritizeByRenewal();
  const allLeads = getLeads();

  const hotLeads = getHotWindowLeads(allLeads);

  // SEGMENT PRIORITY DURING WARM-UP
  //
  // Measured over the first four days on the authenticated domain:
  //   business domains  14.3% open
  //   Yahoo / AOL        8.3%
  //   Microsoft          8.3%
  //   Gmail              0.9%   ← and 70% of the list
  //
  // Mailbox providers weigh recipient engagement when deciding placement, so
  // pushing most of our volume at the segment that never opens teaches Gmail
  // we are unwanted. During warm-up we lead with the segments that actually
  // engage, which builds a positive record, and ramp Gmail afterwards.
  //
  // This only reorders WHO GOES FIRST — every lead still gets contacted inside
  // its renewal window. Cancellations override everything, since those people
  // need coverage regardless of which mailbox they use.
  const SEGMENT_PRIORITY_UNTIL = process.env.SEGMENT_PRIORITY_UNTIL || "2026-08-31";
  const segmentPhase = Date.now() < Date.parse(`${SEGMENT_PRIORITY_UNTIL}T23:59:59Z`);

  const FREE_MAIL = new Set([
    "gmail.com", "googlemail.com", "yahoo.com", "aol.com", "ymail.com",
    "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com",
    "comcast.net", "verizon.net", "optonline.net", "att.net", "sbcglobal.net",
  ]);

  // Lower rank goes first.
  function segmentRank(lead) {
    const domain = String(lead.email || "").split("@")[1] || "";
    if (!domain) return 9;
    if (!FREE_MAIL.has(domain)) return 0;                       // business domain
    if (["yahoo.com", "aol.com", "ymail.com"].includes(domain)) return 1;
    if (["hotmail.com", "outlook.com", "live.com", "msn.com"].includes(domain)) return 1;
    if (["gmail.com", "googlemail.com"].includes(domain)) return 3;
    return 2;                                                    // other consumer ISPs
  }

  const sortedHot = hotLeads.sort((a, b) => {
    // 1. Cancellations always first — they need coverage regardless.
    if (a.cancellation && !b.cancellation) return -1;
    if (!a.cancellation && b.cancellation) return 1;

    // 2. During warm-up, favour segments that actually open.
    if (segmentPhase) {
      const rankDiff = segmentRank(a) - segmentRank(b);
      if (rankDiff !== 0) return rankDiff;
    }

    // 3. Then soonest renewal.
    const aDays = a._daysToRenewal ?? 999;
    const bDays = b._daysToRenewal ?? 999;
    return aDays - bDays;
  });

  if (segmentPhase) {
    const lead100 = sortedHot.slice(0, 100);
    const biz = lead100.filter((l) => segmentRank(l) === 0).length;
    log.info(`Segment priority active until ${SEGMENT_PRIORITY_UNTIL} — ${biz}/100 of the front of the queue are business domains`);
  }

  const cap = opts.maxSends && opts.maxSends > 0
    ? Math.min(opts.maxSends, coldBudget())
    : coldBudget();
  const hotTargets = await takeSendable(sortedHot, cap);

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

  const remainingBudget = cap - sent;
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
    daysSince(l.lastContacted) >= FOLLOWUP_DAYS &&
    !renewalHasPassed(l)
  );
  const targets = await takeSendable(followupCandidates, followupBudget());

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
      // With MAX_FOLLOWUPS=1 every follow-up is the last one, so it should read
      // like a light final nudge rather than a formal break-up letter.
      const isLast = followupCount >= MAX_FOLLOWUPS;
      const type = MAX_FOLLOWUPS === 1
        ? "followup"
        : (isLast ? "breakup" : followupCount === 2 ? "qualify" : "followup");

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
