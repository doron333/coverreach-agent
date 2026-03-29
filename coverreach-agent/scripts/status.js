/**
 * CoverReach — Status Dashboard
 * Usage: node scripts/status.js
 */

import { getLeads, daysSince } from "../src/leads.js";

function main() {
  const leads = getLeads();
  const byStatus = {
    new:       leads.filter(l => l.status === "new"),
    contacted: leads.filter(l => l.status === "contacted"),
    replied:   leads.filter(l => l.status === "replied"),
    cold:      leads.filter(l => l.status === "cold"),
  };

  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH — Agent Status            ║
╚══════════════════════════════════════════════╝

LEAD SUMMARY
  Total:      ${leads.length}
  New:        ${byStatus.new.length}       (ready for cold outreach)
  Contacted:  ${byStatus.contacted.length}       (awaiting reply / follow-up)
  Replied:    ${byStatus.replied.length}       (hot leads — follow up manually!)
  Cold:       ${byStatus.cold.length}       (max follow-ups reached, no reply)

`);

  if (byStatus.replied.length) {
    console.log("🔥 REPLIED LEADS (take action!):");
    for (const l of byStatus.replied) {
      console.log(`   • ${l.name} @ ${l.company} <${l.email}> — replied ${new Date(l.repliedAt).toLocaleDateString()}`);
    }
    console.log("");
  }

  if (byStatus.contacted.length) {
    console.log("⏳ FOLLOW-UP QUEUE (contacted, no reply):");
    for (const l of byStatus.contacted) {
      const days = Math.floor(daysSince(l.lastContacted));
      const ready = days >= parseInt(process.env.FOLLOWUP_AFTER_DAYS || "7");
      const flag  = ready ? "✓ READY" : `  ${days}d ago`;
      console.log(`   ${flag.padEnd(10)} ${l.name} @ ${l.company} (follow-up #${l.followupCount})`);
    }
    console.log("");
  }

  console.log("RECENT HISTORY (last 10 entries):");
  const allHistory = leads
    .flatMap(l => (l.history || []).map(h => ({ ...h, leadName: l.name, leadCompany: l.company })))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10);

  for (const h of allHistory) {
    const date = new Date(h.date).toLocaleDateString();
    console.log(`   ${date}  ${h.type.padEnd(14)} ${h.leadName} @ ${h.leadCompany}`);
  }
  console.log("");
}

main();
