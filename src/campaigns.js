import { getLeads, saveLeads } from "./leads.js";
import { log } from "./logger.js";

/**
 * CAMPAIGN SYSTEM
 * ================
 * Leads are reusable year over year. Renewal dates recur annually —
 * a July 2026 renewal is also a July 2027 renewal.
 *
 * Each campaign (e.g. "july-2026") tracks its own contact state.
 * When a campaign ends, results are archived to lead.campaignHistory.
 * Next year, resetCampaign("july-2027") makes the same leads eligible again.
 *
 * PERMANENT statuses (never reset, legal requirement):
 *   - unsubscribed  (CAN-SPAM: must honor forever)
 *   - bounced       (email invalid, no point retrying)
 *
 * Statuses that DO reset each year:
 *   - contacted / cold (no reply last year ≠ no reply this year)
 *   - replied (they engaged last year — warm lead for this year!)
 */

const PERMANENT_STATUSES = ["unsubscribed", "bounced"];

/**
 * Archive the current campaign results into campaignHistory,
 * then reset eligible leads to "new" for the next campaign.
 *
 * Usage (run once a year, e.g. June 2027):
 *   node -e "import('./src/campaigns.js').then(m => m.resetCampaign('july-2027'))"
 */
export function resetCampaign(newCampaignId) {
  const leads = getLeads();
  let archived = 0, reset = 0, kept = 0;

  for (const lead of leads) {
    const oldCampaign = lead.currentCampaign;
    if (!oldCampaign) continue; // never was in a campaign

    // 1. Archive last campaign's outcome
    if (!lead.campaignHistory) lead.campaignHistory = {};
    // everReplied and replyHistory are deliberately never touched here.
    // They are the whole point of the hot list: a prospect who replied in a
    // prior year must not come back next year looking like a cold record.
    lead.campaignHistory[oldCampaign] = {
      finalStatus: lead.status,
      contacted: lead.lastContacted || null,
      repliedAt: lead.repliedAt || null,
      followupCount: lead.followupCount || 0,
      emailsSent: (lead.history || []).length,
    };
    archived++;

    // 2. Permanent statuses never reset
    if (PERMANENT_STATUSES.includes(lead.status)) {
      lead.currentCampaign = null; // out of all future campaigns
      kept++;
      continue;
    }

    // 3. Reset for the new campaign year
    lead.status = "new";
    lead.currentCampaign = newCampaignId;
    lead.campaignEligible = true;
    lead.lastContacted = null;
    lead.repliedAt = null;
    lead.followupCount = 0;
    lead.history = [];

    // 4. Flag prior responders as warm — they engaged before
    const prior = lead.campaignHistory[oldCampaign];
    if (prior && prior.repliedAt) {
      lead.warmLead = true;
      lead.notes = (lead.notes || "") + ` ⭐ REPLIED in ${oldCampaign} — warm lead, reference prior conversation.`;
    }

    reset++;
  }

  saveLeads(leads);
  log.success(`Campaign reset → ${newCampaignId}: ${reset} leads re-eligible | ${kept} permanently excluded | ${archived} archived`);
  return { reset, kept, archived };
}

/**
 * Get stats for the current campaign
 */
export function campaignStats() {
  const leads = getLeads();
  const inCampaign = leads.filter(l => l.currentCampaign);
  const stats = {
    campaign: inCampaign[0]?.currentCampaign || "none",
    total: inCampaign.length,
    new: inCampaign.filter(l => l.status === "new").length,
    contacted: inCampaign.filter(l => l.status === "contacted").length,
    replied: inCampaign.filter(l => l.status === "replied").length,
    cold: inCampaign.filter(l => l.status === "cold").length,
    unsubscribed: leads.filter(l => l.status === "unsubscribed").length,
    bounced: leads.filter(l => l.status === "bounced").length,
    warm: inCampaign.filter(l => l.warmLead).length,
  };
  return stats;
}
