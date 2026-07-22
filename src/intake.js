import { getLeads, saveLeads } from "./leads.js";
import { auditNewLeads } from "./leadAudit.js";
import { log } from "./logger.js";

/**
 * LEAD INTAKE
 * ============
 * The single supported way new leads enter the database. Every path in —
 * spreadsheet import, API pull, manual add — should go through here so
 * nothing reaches the send queue unvetted.
 *
 * Steps:
 *   1. drop records with no email
 *   2. drop duplicates (against the existing book AND within the new batch)
 *   3. normalize into the standard lead shape
 *   4. run the deliverability audit on the new records only
 *   5. persist
 *
 * Returns a summary you can print or email.
 */

function monthName(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  const dt = mdy
    ? new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]))
    : (isNaN(Date.parse(s)) ? null : new Date(Date.parse(s)));
  if (!dt || isNaN(dt)) return null;
  return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
}

export async function importLeads(incoming = [], { source = "import" } = {}) {
  const existing = getLeads();
  const existingEmails = new Set(
    existing.map(l => (l.email || "").trim().toLowerCase()).filter(Boolean)
  );

  const summary = {
    received: incoming.length,
    noEmail: 0,
    duplicateExisting: 0,
    duplicateInBatch: 0,
    added: 0,
    audit: null,
  };

  const batchSeen = new Set();
  const toAdd = [];

  for (const raw of incoming) {
    const email = (raw.email || "").trim().toLowerCase();
    if (!email) { summary.noEmail++; continue; }
    if (existingEmails.has(email)) { summary.duplicateExisting++; continue; }
    if (batchSeen.has(email)) { summary.duplicateInBatch++; continue; }
    batchSeen.add(email);

    const id = raw.id || `lead_${source}_${email.replace(/[^a-z0-9]/g, "").slice(0, 24)}_${toAdd.length}`;
    toAdd.push({
      id,
      name: raw.name || raw.company || "",
      company: raw.company || "",
      role: raw.role || "Owner/Operator",
      email,
      phone: raw.phone || "",
      type: raw.type || "Commercial Insurance",
      notes: raw.notes || "",
      status: "new",
      history: [],
      lastContacted: null,
      repliedAt: null,
      followupCount: 0,
      source: raw.source || source,
      city: raw.city || "",
      state: raw.state || "",
      carrier: raw.carrier || "",
      units: raw.units || 0,
      renewalDate: monthName(raw.renewalDate),
      cancellation: monthName(raw.cancellation),
      campaignHistory: {},
      currentCampaign: "rolling",
    });
  }

  if (!toAdd.length) {
    log.warn(`Import: nothing new to add (${summary.received} received, all skipped)`);
    return summary;
  }

  saveLeads([...existing, ...toAdd]);
  summary.added = toAdd.length;
  log.success(
    `Import: added ${summary.added} leads ` +
    `(${summary.duplicateExisting} already known, ${summary.duplicateInBatch} dupes in file, ${summary.noEmail} no email)`
  );

  // Vet the new records before they can ever be sent to
  summary.audit = await auditNewLeads(toAdd.map(l => l.id));
  return summary;
}
