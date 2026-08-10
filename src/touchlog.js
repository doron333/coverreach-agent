import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOUCHLOG_PATH = path.join(__dirname, "../data/touchlog.json");

/**
 * PERMANENT TOUCH LOG
 * ====================
 * Append-only record of EVERY email the agent ever sends.
 * Never reset, never wiped — even across campaign years.
 *
 * This is the source of truth for:
 *   - "Who did we contact last July?" → next year's warm prospect list
 *   - Compliance records (what was sent, when, to whom)
 *   - Multi-year relationship history per lead
 *
 * Each entry:
 * {
 *   ts: ISO timestamp,
 *   campaign: "july-2026",
 *   leadId, email, company,
 *   touchType: "cold" | "followup" | "qualify" | "breakup",
 *   subject: "...",
 *   renewalDate: "7/15/2026"
 * }
 */

/** Full touch log, oldest first. Used by the activity dashboard. */
export function getTouchlog() {
  try {
    if (!fs.existsSync(TOUCHLOG_PATH)) return [];
    return JSON.parse(fs.readFileSync(TOUCHLOG_PATH, "utf8"));
  } catch (err) {
    log.error(`Touchlog read failed: ${err.message}`);
    return [];
  }
}

export function logTouch(lead, touchType, subject) {
  try {
    let touchlog = [];
    if (fs.existsSync(TOUCHLOG_PATH)) {
      try { touchlog = JSON.parse(fs.readFileSync(TOUCHLOG_PATH, "utf8")); }
      catch { touchlog = []; }
    }

    touchlog.push({
      ts: new Date().toISOString(),
      campaign: lead.currentCampaign || "unknown",
      leadId: lead.id,
      email: lead.email,
      company: lead.company,
      touchType,
      subject,
      renewalDate: lead.renewalDate || null,
      cancellation: lead.cancellation || null,
    });

    fs.writeFileSync(TOUCHLOG_PATH, JSON.stringify(touchlog, null, 2));
  } catch (err) {
    log.error(`Touch log write failed: ${err.message}`);
  }
}

/**
 * Build next year's prospect list from a prior campaign.
 * Everyone touched in e.g. "july-2026" becomes a follow-up
 * prospect for "july-2027" — with their full touch history attached.
 *
 * Usage:
 *   node -e "import('./src/touchlog.js').then(m => console.log(JSON.stringify(m.getPriorCampaignProspects('july-2026'), null, 2)))"
 */
export function getPriorCampaignProspects(campaignId) {
  if (!fs.existsSync(TOUCHLOG_PATH)) return [];
  const touchlog = JSON.parse(fs.readFileSync(TOUCHLOG_PATH, "utf8"));

  const byEmail = {};
  for (const t of touchlog.filter(t => t.campaign === campaignId)) {
    if (!byEmail[t.email]) {
      byEmail[t.email] = {
        email: t.email,
        company: t.company,
        leadId: t.leadId,
        renewalDate: t.renewalDate,
        touches: [],
      };
    }
    byEmail[t.email].touches.push({ ts: t.ts, type: t.touchType, subject: t.subject });
  }

  return Object.values(byEmail).map(p => ({
    ...p,
    totalTouches: p.touches.length,
    firstTouch: p.touches[0]?.ts,
    lastTouch: p.touches[p.touches.length - 1]?.ts,
  }));
}

export function touchlogStats() {
  if (!fs.existsSync(TOUCHLOG_PATH)) return { total: 0, campaigns: {} };
  const touchlog = JSON.parse(fs.readFileSync(TOUCHLOG_PATH, "utf8"));
  const campaigns = {};
  for (const t of touchlog) {
    if (!campaigns[t.campaign]) campaigns[t.campaign] = { touches: 0, uniqueLeads: new Set() };
    campaigns[t.campaign].touches++;
    campaigns[t.campaign].uniqueLeads.add(t.email);
  }
  const result = { total: touchlog.length, campaigns: {} };
  for (const [c, data] of Object.entries(campaigns)) {
    result.campaigns[c] = { touches: data.touches, uniqueLeads: data.uniqueLeads.size };
  }
  return result;
}
