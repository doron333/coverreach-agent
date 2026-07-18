import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEADS_PATH = path.join(__dirname, "../data/leads.json");

let leadsCache = null;

export function getLeads() {
  if (!leadsCache) {
    try {
      leadsCache = JSON.parse(fs.readFileSync(LEADS_PATH, "utf8"));
    } catch {
      leadsCache = [];
    }
  }
  return leadsCache;
}

export function saveLeads(leads) {
  leadsCache = leads;
  fs.writeFileSync(LEADS_PATH, JSON.stringify(leads, null, 2));
}

export function updateLead(id, updates) {
  const leads = getLeads();
  const idx = leads.findIndex(l => l.id === id);
  if (idx !== -1) {
    leads[idx] = { ...leads[idx], ...updates };
    saveLeads(leads);
  }
}

export function addHistoryEntry(id, entry) {
  const leads = getLeads();
  const idx = leads.findIndex(l => l.id === id);
  if (idx !== -1) {
    if (!leads[idx].history) leads[idx].history = [];
    leads[idx].history.push({ ...entry, date: new Date().toISOString() });
    saveLeads(leads);
  }
}

export function markUnsubscribed(email) {
  if (!email) return;
  const leads = getLeads();
  const idx = leads.findIndex(l => (l.email || "").toLowerCase() === email.toLowerCase());
  if (idx !== -1) {
    leads[idx].status = "unsubscribed";
    saveLeads(leads);
  }
}

export function markBounced(email) {
  if (!email) return;
  const leads = getLeads();
  const idx = leads.findIndex(l => (l.email || "").toLowerCase() === email.toLowerCase());
  if (idx !== -1) {
    leads[idx].status = "bounced";
    saveLeads(leads);
  }
}

export function daysSince(dateStr) {
  if (!dateStr) return 999;
  try {
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  } catch { return 999; }
}

export function deduplicateLeads() {
  const leads = getLeads();
  const seen = new Set();
  const deduped = leads.filter(l => {
    const key = (l.email || l.id || "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length < leads.length) {
    saveLeads(deduped);
    return leads.length - deduped.length;
  }
  return 0;
}

/**
 * Improved scoring for hybrid "touch everyone over time" strategy.
 * - Hot renewal window leads get very high scores.
 * - Cancellations get top priority.
 * - Dual-pitch leads boosted.
 * - Leads that haven't been touched in a long time get a nurture boost
 *   so we eventually reach the entire list (compounding asset).
 */
export function prioritizeByRenewal() {
  const leads = getLeads();
  const today = new Date();

  const scored = leads.map(l => {
    let score = 0;

    // === Core renewal urgency (highest impact) ===
    const dateStr = l.wcExpDate || l.expirationDate || l.renewalDate || "";
    let daysToRenewal = 999;
    if (dateStr) {
      try {
        const parts = dateStr.split("/");
        if (parts.length >= 2) {
          const year = parts[2] ? parseInt(parts[2]) : today.getFullYear();
          const renewal = new Date(year, parseInt(parts[0]) - 1, parseInt(parts[1]));
          daysToRenewal = Math.round((renewal - today) / (1000 * 60 * 60 * 24));
        }
      } catch {}
    }

    // Hot window scoring (30-60 days primary, cancellations extended)
    if (l.cancellation) {
      if (daysToRenewal >= 0 && daysToRenewal <= 75) score += 200;
    } else {
      if (daysToRenewal >= 30 && daysToRenewal <= 60) score += 150;
      else if (daysToRenewal > 0 && daysToRenewal < 30) score += 80;
      else if (daysToRenewal > 60 && daysToRenewal <= 90) score += 40;
    }

    // Dual pitch bonus
    if (l.source === "njcrib_dot") score += 60;

    // === Nurture / "touch everyone eventually" bonus ===
    const daysSinceContact = daysSince(l.lastContacted);
    if (daysSinceContact > 120) score += 35;
    else if (daysSinceContact > 90) score += 25;
    else if (daysSinceContact > 60) score += 15;

    if (l.notes && l.notes.length > 80) score += 10;

    return { ...l, _score: score, _daysToRenewal: daysToRenewal };
  });

  scored.sort((a, b) => b._score - a._score);
  const sorted = scored.map(({ _score, _daysToRenewal, ...l }) => l);
  saveLeads(sorted);
  return sorted;
}

/**
 * Returns leads that are in the true hot renewal window right now.
 */
export function getHotWindowLeads(leads) {
  return leads.filter(l => {
    if (!l.email || l.email === "null") return false;
    if (["unsubscribed", "bounced", "replied", "cold", "no_email"].includes(l.status)) return false;

    const dateStr = l.wcExpDate || l.expirationDate || l.renewalDate || "";
    if (!dateStr) return false;

    try {
      const parts = dateStr.split("/");
      if (parts.length < 2) return false;
      const year = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
      const renewal = new Date(year, parseInt(parts[0]) - 1, parseInt(parts[1]));
      const days = Math.floor((renewal - Date.now()) / 86400000);

      if (l.cancellation) return days >= 0 && days <= 75;
      return days >= 30 && days <= 60;
    } catch {
      return false;
    }
  });
}