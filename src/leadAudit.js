import { getLeads, saveLeads } from "./leads.js";
import { validateEmail, normalizeEmail } from "./validate.js";
import { persistLeadsToGitHub } from "./persist.js";
import { log } from "./logger.js";

/**
 * LEAD HYGIENE AUDIT
 * ===================
 * Standing quality control on every address in the database. Runs:
 *   - automatically whenever new leads are imported
 *   - on a weekly schedule
 *   - on demand at GET /audit  (preview)  and  GET /audit?apply=true  (fix)
 *
 * WHAT IT DOES
 *   repaired    → address was broken but salvageable, rewritten in place
 *                 ("tap transport llc@x.com", "user@yahoo,com", "a@gmial.com")
 *   suppressed  → address can never deliver, marked bounced so it is never
 *                 retried and never counted against a daily send budget
 *   roleAddress → info@ / dispatch@ / office@ — deliverable but low reply
 *                 rate. Flagged only, never suppressed.
 *   duplicate   → same address on multiple lead records; the extras are
 *                 flagged so one prospect is not emailed several times.
 *
 * SAFETY RULE
 * A lead is only suppressed on definitive proof (malformed syntax, or a
 * domain that does not exist). A DNS timeout is never treated as proof —
 * an audit on 7/22 found 152 of 175 "dead" domains were merely slow, and
 * suppressing those would have destroyed real prospects.
 */

const ROLE_PREFIXES = new Set([
  "info", "sales", "admin", "office", "contact", "support", "billing",
  "accounting", "dispatch", "service", "help", "hr", "careers", "noreply",
  "no-reply", "webmaster", "mail", "inquiries", "customerservice",
]);

// Statuses we never touch — already resolved, or the person opted out.
const IMMUTABLE = new Set(["unsubscribed", "bounced", "replied"]);

export async function auditLeads({ apply = false, onlyStatus = null } = {}) {
  const started = Date.now();
  const leads = getLeads();

  const scope = leads.filter(l => {
    if (IMMUTABLE.has(l.status)) return false;
    if (onlyStatus && l.status !== onlyStatus) return false;
    return true;
  });

  const report = {
    scanned: scope.length,
    repaired: [],
    suppressed: [],
    roleAddresses: 0,
    duplicates: [],
    unverifiedDns: 0,
    applied: apply,
  };

  const seen = new Map(); // normalized address -> first lead id that used it

  for (const lead of scope) {
    const original = lead.email || "";
    const result = await validateEmail(original);

    if (!result.ok) {
      report.suppressed.push({
        id: lead.id, company: lead.company,
        email: original, reason: result.reason,
      });
      if (apply) {
        lead.status = "bounced";
        lead.campaignEligible = false;
        lead.bounceReason = `audit:${result.reason}`;
      }
      continue;
    }

    if (result.reason === "unverified_dns") report.unverifiedDns++;

    if (result.email !== original.trim().toLowerCase()) {
      report.repaired.push({
        id: lead.id, company: lead.company,
        from: original, to: result.email,
      });
      if (apply) lead.email = result.email;
    }

    const addr = result.email;
    if (ROLE_PREFIXES.has(addr.split("@")[0])) report.roleAddresses++;

    if (seen.has(addr)) {
      report.duplicates.push({
        id: lead.id, company: lead.company,
        email: addr, duplicateOf: seen.get(addr),
      });
      if (apply) lead.duplicateOf = seen.get(addr);
    } else {
      seen.set(addr, lead.id);
    }
  }

  report.durationMs = Date.now() - started;
  report.summary =
    `scanned ${report.scanned} · repaired ${report.repaired.length} · ` +
    `suppressed ${report.suppressed.length} · duplicates ${report.duplicates.length} · ` +
    `role addresses ${report.roleAddresses}`;

  if (apply && (report.repaired.length || report.suppressed.length || report.duplicates.length)) {
    saveLeads(leads);
    await persistLeadsToGitHub(
      `Lead audit: repaired ${report.repaired.length}, suppressed ${report.suppressed.length}`
    ).catch(() => {});
  }

  log[apply ? "success" : "info"](
    `Lead audit ${apply ? "APPLIED" : "(preview)"} — ${report.summary}`
  );
  return report;
}

/**
 * Called right after new leads are imported. Audits only the freshly added
 * records so a bad spreadsheet never reaches the send queue.
 */
export async function auditNewLeads(newLeadIds = []) {
  if (!newLeadIds.length) return null;
  const ids = new Set(newLeadIds);
  const leads = getLeads();
  const fresh = leads.filter(l => ids.has(l.id));
  if (!fresh.length) return null;

  log.info(`Auditing ${fresh.length} newly imported leads before they enter the queue...`);

  const report = { scanned: fresh.length, repaired: 0, suppressed: 0, roleAddresses: 0 };
  for (const lead of fresh) {
    const original = lead.email || "";
    const result = await validateEmail(original);
    if (!result.ok) {
      lead.status = "bounced";
      lead.campaignEligible = false;
      lead.bounceReason = `import_audit:${result.reason}`;
      report.suppressed++;
      continue;
    }
    if (result.email !== original.trim().toLowerCase()) {
      lead.email = result.email;
      report.repaired++;
    }
    if (ROLE_PREFIXES.has(result.email.split("@")[0])) report.roleAddresses++;
  }

  saveLeads(leads);
  await persistLeadsToGitHub(
    `Import audit: ${report.repaired} repaired, ${report.suppressed} suppressed of ${report.scanned} new leads`
  ).catch(() => {});

  log.success(
    `Import audit — ${report.scanned} new leads: ${report.repaired} repaired, ` +
    `${report.suppressed} unsendable, ${report.roleAddresses} role addresses`
  );
  return report;
}
