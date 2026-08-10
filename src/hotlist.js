import { getLeads, saveLeads } from "./leads.js";
import { getReplies } from "./crm.js";
import { persistLeadsToGitHub } from "./persist.js";
import { log } from "./logger.js";

/**
 * HOT LIST — PERMANENT RECORD OF EVERYONE WHO EVER REPLIED
 * ========================================================
 * A reply is the single most valuable signal a prospect ever gives us. It
 * says a real person read the message, recognised the situation, and wrote
 * back. That is worth far more than any purchased list, and it must not be
 * lost when the campaign resets each year.
 *
 * The problem this solves: the annual reset archives a lead's campaign
 * outcome into campaignHistory and sets status back to "new". Without a
 * durable marker, someone who replied in 2026 becomes indistinguishable
 * from a cold record in 2027 — and next year's email opens with "I place
 * trucking coverage in Jersey" instead of "we spoke last August."
 *
 * So every reply also writes two fields that no reset ever touches:
 *   everReplied   true, permanently
 *   replyHistory  [{ campaign, ts, subject, excerpt }]
 *
 * Next year those leads get contacted first, with their history in hand.
 */

/** Marks a lead as having replied, permanently. Safe to call repeatedly. */
export function markEverReplied(lead, { subject = "", excerpt = "", campaign = null } = {}) {
  if (!lead) return;
  lead.everReplied = true;
  if (!Array.isArray(lead.replyHistory)) lead.replyHistory = [];

  const ts = lead.repliedAt || new Date().toISOString();
  const already = lead.replyHistory.some((r) => r.ts === ts);
  if (!already) {
    lead.replyHistory.push({
      campaign: campaign || lead.currentCampaign || "unknown",
      ts,
      subject: subject || "",
      excerpt: String(excerpt || "").slice(0, 300),
    });
  }
}

/**
 * Backfills everReplied across the whole book from existing records. Used
 * once to capture replies that happened before this flag existed, and safe
 * to re-run.
 */
export async function backfillHotList() {
  const leads = getLeads();
  const replies = getReplies();
  const byEmail = new Map();
  for (const r of replies) {
    const e = (r.email || "").toLowerCase();
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e).push(r);
  }

  let marked = 0;
  for (const lead of leads) {
    const email = (lead.email || "").toLowerCase();
    const logged = byEmail.get(email) || [];
    const repliedNow = lead.status === "replied" || !!lead.repliedAt;
    const repliedBefore = Object.values(lead.campaignHistory || {}).some((h) => h.repliedAt);

    if (!logged.length && !repliedNow && !repliedBefore) continue;
    if (lead.everReplied && (lead.replyHistory || []).length) continue;

    if (logged.length) {
      for (const r of logged) {
        lead.repliedAt = lead.repliedAt || r.ts;
        markEverReplied(lead, { subject: r.subject, excerpt: r.reply, campaign: r.campaign });
      }
    } else {
      markEverReplied(lead, { subject: "(reply recorded before hot list existed)" });
    }
    marked++;
  }

  if (marked) {
    saveLeads(leads);
    await persistLeadsToGitHub(`Hot list backfill: ${marked} prospects marked as having replied`).catch(() => {});
  }
  log.success(`Hot list: ${marked} prospect(s) marked, ${getHotList().length} total`);
  return { marked, total: getHotList().length };
}

/**
 * Everyone who has ever replied, newest first. This is the list to work
 * first in any future campaign.
 */
export function getHotList() {
  return getLeads()
    .filter((l) => l.everReplied)
    .map((l) => {
      const history = l.replyHistory || [];
      const last = history[history.length - 1] || {};
      return {
        id: l.id,
        company: l.company,
        name: l.name,
        email: l.email,
        phone: l.phone,
        city: l.city,
        state: l.state,
        units: l.units,
        carrier: l.carrier,
        renewalDate: l.renewalDate,
        status: l.status,
        outcome: l.outcome?.stage || null,
        boundPremium: l.outcome?.boundPremium || null,
        replyCount: history.length,
        firstReplied: history[0]?.ts || l.repliedAt || null,
        lastReplied: last.ts || l.repliedAt || null,
        lastSubject: last.subject || "",
        lastExcerpt: last.excerpt || "",
        campaigns: [...new Set(history.map((h) => h.campaign).filter(Boolean))],
      };
    })
    .sort((a, b) => (b.lastReplied || "").localeCompare(a.lastReplied || ""));
}
