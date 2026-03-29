import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEADS_FILE = path.join(__dirname, "../data/leads.json");

export function getLeads() {
  if (!fs.existsSync(LEADS_FILE)) {
    fs.writeFileSync(LEADS_FILE, "[]");
    return [];
  }
  return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
}

export function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

export function updateLead(id, updates) {
  const leads = getLeads();
  const idx = leads.findIndex(l => l.id === id);
  if (idx === -1) return;
  leads[idx] = { ...leads[idx], ...updates };
  saveLeads(leads);
  return leads[idx];
}

export function addHistoryEntry(id, entry) {
  const leads = getLeads();
  const idx = leads.findIndex(l => l.id === id);
  if (idx === -1) return;
  leads[idx].history = [...(leads[idx].history || []), { ...entry, date: new Date().toISOString() }];
  saveLeads(leads);
}

export function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}

// Import leads from a plain JS array (used by the importer script)
export function importLeads(newLeads) {
  const existing = getLeads();
  const existingEmails = new Set(existing.map(l => l.email.toLowerCase()));
  let added = 0;

  for (const lead of newLeads) {
    if (!lead.email || existingEmails.has(lead.email.toLowerCase())) continue;
    existing.push({
      id: `lead_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: lead.name || "",
      company: lead.company || "",
      role: lead.role || "",
      email: lead.email.toLowerCase().trim(),
      type: lead.type || "Commercial General Liability",
      notes: lead.notes || "",
      status: "new",
      history: [],
      lastContacted: null,
      repliedAt: null,
      followupCount: 0,
    });
    existingEmails.add(lead.email.toLowerCase());
    added++;
  }

  saveLeads(existing);
  return added;
}
