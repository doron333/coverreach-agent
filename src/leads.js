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

export function prioritizeByRenewal() {
  const leads = getLeads();
  const today = new Date();

  const scored = leads.map(l => {
    let score = 0;
    // Dual pitch leads get highest priority
    if (l.source === "njcrib_dot") score += 50;
    
    // Score by renewal urgency
    const dateStr = l.wcExpDate || l.expirationDate || "";
    if (dateStr) {
      try {
        const parts = dateStr.split("/");
        if (parts.length >= 2) {
          const year = parts[2] ? parseInt(parts[2]) : today.getFullYear();
          const renewal = new Date(year, parseInt(parts[0]) - 1, parseInt(parts[1]));
          const days = Math.round((renewal - today) / (1000 * 60 * 60 * 24));
          if (days >= 0 && days <= 30) score += 100;
          else if (days > 0 && days <= 60) score += 75;
          else if (days > 0 && days <= 90) score += 50;
        }
      } catch {}
    }
    return { ...l, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  const sorted = scored.map(({ _score, ...l }) => l);
  saveLeads(sorted);
  return sorted;
}
