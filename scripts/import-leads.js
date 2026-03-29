/**
 * CoverReach — Lead Importer
 * Usage: node scripts/import-leads.js path/to/leads.csv
 *
 * Supports CSV files with columns: name, email, company, role, type, notes
 * Column headers are auto-detected (case-insensitive, handles variations)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { importLeads, getLeads } from "../src/leads.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIELD_ALIASES = {
  name:    ["name", "full name", "contact", "first name", "contact name"],
  company: ["company", "agency", "firm", "organization", "brokerage", "business"],
  role:    ["role", "title", "job title", "position", "job", "designation"],
  email:   ["email", "email address", "e-mail", "mail"],
  type:    ["insurance type", "type", "line", "product", "insurance line", "coverage"],
  notes:   ["notes", "context", "details", "background", "info", "comments"],
};

function detectCol(headers, field) {
  const aliases = FIELD_ALIASES[field];
  return headers.find(h => aliases.some(a => h.toLowerCase().trim().includes(a))) || null;
}

function parseCSV(content) {
  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
  const colMap = {};
  for (const field of Object.keys(FIELD_ALIASES)) {
    colMap[field] = detectCol(headers, field);
  }

  console.log("\nDetected column mapping:");
  for (const [field, col] of Object.entries(colMap)) {
    console.log(`  ${field.padEnd(10)} → ${col || "(not found)"}`);
  }

  if (!colMap.name || !colMap.email || !colMap.company) {
    console.error("\n❌ Missing required columns: name, email, and company are required.");
    process.exit(1);
  }

  return lines.slice(1).map(line => {
    const values = line.split(",").map(v => v.replace(/"/g, "").trim());
    const row = {};
    headers.forEach((h, i) => row[h] = values[i] || "");
    const lead = {};
    for (const [field, col] of Object.entries(colMap)) {
      lead[field] = col ? row[col] || "" : "";
    }
    return lead;
  }).filter(l => l.email && l.name && l.company);
}

function parseJSON(content) {
  const data = JSON.parse(content);
  return Array.isArray(data) ? data : [];
}

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error("Usage: node scripts/import-leads.js path/to/leads.csv");
    process.exit(1);
  }

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`❌ File not found: ${absPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(absPath, "utf8");
  const ext = path.extname(absPath).toLowerCase();
  let leads;

  if (ext === ".csv") {
    leads = parseCSV(content);
  } else if (ext === ".json") {
    leads = parseJSON(content);
  } else {
    console.error("❌ Unsupported file type. Use .csv or .json");
    process.exit(1);
  }

  console.log(`\nParsed ${leads.length} leads from file.`);

  const before = getLeads().length;
  const added  = importLeads(leads);
  const after  = getLeads().length;

  console.log(`\n✅ Import complete:`);
  console.log(`   Added:     ${added} new leads`);
  console.log(`   Skipped:   ${leads.length - added} (duplicates)`);
  console.log(`   Total now: ${after} leads in database\n`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
