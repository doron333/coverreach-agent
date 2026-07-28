import { getLeads, saveLeads } from "./leads.js";
import { persistLeadsToGitHub } from "./persist.js";
import { log } from "./logger.js";

/**
 * REVENUE OUTCOME TRACKING
 * =========================
 * The agent already knows what it SENT and who REPLIED. Those are free —
 * they happen in software. What it cannot know on its own is what happened
 * after a human got involved: did the conversation turn into a meeting, a
 * quote, a bound policy, and how much premium was written.
 *
 * That last part is the only number an agency owner actually cares about,
 * and the only honest basis for saying what this system is worth. So those
 * stages are recorded by hand — one tap from the replies screen.
 *
 * THE FUNNEL
 *   contacted  → email sent                       (automatic)
 *   replied    → prospect responded               (automatic, via IMAP watcher)
 *   meeting    → call or appointment happened     (manual)
 *   quoted     → quote issued, premium known      (manual, $)
 *   bound      → policy sold                      (manual, $)
 *   lost       → went elsewhere / not interested  (manual)
 *
 * Commission is an ESTIMATE derived from bound premium. It is labeled as an
 * estimate everywhere it appears, because guessing at revenue and presenting
 * it as fact is how a good number becomes an embarrassing one in a meeting.
 */

export const STAGES = ["contacted", "replied", "meeting", "quoted", "bound", "lost"];

// Stages a human enters. Everything else the agent sets itself.
export const MANUAL_STAGES = ["meeting", "quoted", "bound", "lost"];

// Typical commercial P&C new-business commission. Override with
// COMMISSION_RATE in Railway if CJIA's actual schedule differs.
const DEFAULT_COMMISSION = parseFloat(process.env.COMMISSION_RATE || "0.12");

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : n;
}

/**
 * Record what happened with a lead. Returns the updated lead, or null if
 * the lead id was not found.
 */
export async function recordOutcome(leadId, { stage, premium, notes, producer } = {}) {
  if (!STAGES.includes(stage)) {
    throw new Error(`Unknown stage "${stage}". Valid: ${STAGES.join(", ")}`);
  }

  const leads = getLeads();
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) return null;

  if (!lead.outcome) {
    lead.outcome = { stage: null, quotedPremium: null, boundPremium: null, stageHistory: [] };
  }

  const amount = num(premium);
  const entry = {
    stage,
    ts: new Date().toISOString(),
    premium: amount,
    notes: notes || "",
    producer: producer || process.env.SENDER_NAME || "",
  };

  lead.outcome.stage = stage;
  lead.outcome.stageHistory.push(entry);
  lead.outcome.lastUpdated = entry.ts;

  if (stage === "quoted" && amount !== null) lead.outcome.quotedPremium = amount;
  if (stage === "bound" && amount !== null) {
    lead.outcome.boundPremium = amount;
    // A bound policy implies it was quoted, even if nobody logged that step.
    if (lead.outcome.quotedPremium === null) lead.outcome.quotedPremium = amount;
  }
  if (stage === "lost") lead.outcome.lostReason = notes || "";

  // A won or lost lead should never receive another automated touch.
  if (stage === "bound" || stage === "lost") {
    lead.campaignEligible = false;
    lead.status = stage === "bound" ? "won" : "closed_lost";
  }

  saveLeads(leads);
  await persistLeadsToGitHub(`Outcome: ${lead.company} → ${stage}${amount ? ` ($${amount.toLocaleString()})` : ""}`)
    .catch(() => {});

  log.success(`Outcome recorded — ${lead.company}: ${stage}${amount ? ` $${amount.toLocaleString()}` : ""}`);
  return lead;
}

/**
 * The funnel, with counts and conversion rates between steps.
 *
 * Counts are CUMULATIVE — reaching a later stage implies every earlier one.
 * A prospect who replied, took a meeting, then went elsewhere still counts
 * as a reply and a meeting. Otherwise recording a loss would make our own
 * reply rate look worse, which would quietly punish honest bookkeeping.
 */
const STAGE_ORDER = ["contacted", "replied", "meeting", "quoted", "bound"];

function highestStageIndex(lead) {
  let idx = -1;

  // Automatic signals
  if (lead.lastContacted || ["contacted", "cold", "replied", "won", "closed_lost"].includes(lead.status)) idx = 0;
  if (lead.repliedAt || lead.status === "replied") idx = Math.max(idx, 1);
  if (lead.status === "won") idx = Math.max(idx, 4);

  // Manually recorded outcomes, current and historical
  const stages = [lead.outcome?.stage, ...(lead.outcome?.stageHistory || []).map((h) => h.stage)];
  for (const s of stages) {
    const i = STAGE_ORDER.indexOf(s);
    if (i > idx) idx = i;
  }
  return idx;
}

export function getFunnel() {
  const leads = getLeads();
  const counts = { contacted: 0, replied: 0, meeting: 0, quoted: 0, bound: 0, lost: 0 };

  for (const lead of leads) {
    const idx = highestStageIndex(lead);
    if (idx < 0) continue;
    for (let i = 0; i <= idx; i++) counts[STAGE_ORDER[i]]++;
    if (lead.outcome?.stage === "lost" || lead.status === "closed_lost") counts.lost++;
  }

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  return {
    counts,
    rates: {
      replyRate: pct(counts.replied, counts.contacted),
      meetingRate: pct(counts.meeting, counts.replied),
      quoteRate: pct(counts.quoted, counts.meeting),
      bindRate: pct(counts.bound, counts.quoted),
      contactToBind: pct(counts.bound, counts.contacted),
    },
  };
}

/** Dollar figures. Commission is explicitly an estimate. */
export function getRevenueStats(commissionRate = DEFAULT_COMMISSION) {
  const leads = getLeads();
  let quotedPipeline = 0, boundPremium = 0, quotedCount = 0, boundCount = 0;
  const wins = [];

  for (const lead of leads) {
    const o = lead.outcome;
    if (!o) continue;
    if (o.stage === "quoted" && o.quotedPremium) {
      quotedPipeline += o.quotedPremium;
      quotedCount++;
    }
    if (o.stage === "bound" && o.boundPremium) {
      boundPremium += o.boundPremium;
      boundCount++;
      wins.push({
        company: lead.company,
        premium: o.boundPremium,
        ts: o.lastUpdated,
        renewalDate: lead.renewalDate,
      });
    }
  }

  wins.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  return {
    quotedPipeline,
    quotedCount,
    boundPremium,
    boundCount,
    avgBoundPremium: boundCount ? Math.round(boundPremium / boundCount) : 0,
    estimatedCommission: Math.round(boundPremium * commissionRate),
    commissionRate,
    // Bound policies renew. This is what the same book is worth next year
    // if nothing is lost — the argument for the system compounding.
    recurringNextYear: Math.round(boundPremium * commissionRate),
    wins: wins.slice(0, 25),
  };
}

/**
 * Leads that replied but have no human outcome logged yet. This is the
 * work queue — a reply with nothing recorded after it is a dropped ball.
 */
export function getNeedsAction() {
  const leads = getLeads();
  return leads
    .filter((l) => {
      const replied = l.status === "replied" || l.repliedAt;
      if (!replied) return false;
      const s = l.outcome?.stage;
      return !s || s === "replied";
    })
    .sort((a, b) => (b.repliedAt || "").localeCompare(a.repliedAt || ""))
    .map((l) => ({
      id: l.id,
      company: l.company,
      name: l.name,
      email: l.email,
      phone: l.phone,
      repliedAt: l.repliedAt,
      renewalDate: l.renewalDate,
      cancellation: l.cancellation,
    }));
}

/** Leads with an open outcome — meeting or quote in flight. */
export function getOpenPipeline() {
  const leads = getLeads();
  return leads
    .filter((l) => ["meeting", "quoted"].includes(l.outcome?.stage))
    .sort((a, b) => (b.outcome?.lastUpdated || "").localeCompare(a.outcome?.lastUpdated || ""))
    .map((l) => ({
      id: l.id,
      company: l.company,
      email: l.email,
      phone: l.phone,
      stage: l.outcome.stage,
      premium: l.outcome.quotedPremium,
      renewalDate: l.renewalDate,
      lastUpdated: l.outcome.lastUpdated,
    }));
}
