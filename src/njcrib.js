import puppeteer from "puppeteer";
import { getLeads, saveLeads } from "./leads.js";
import { log } from "./logger.js";
import { sendNotification } from "./gmail.js";

const NJ_COUNTIES = [
  "Atlantic", "Bergen", "Burlington", "Camden", "Cape May",
  "Cumberland", "Essex", "Gloucester", "Hudson", "Hunterdon",
  "Mercer", "Middlesex", "Monmouth", "Morris", "Ocean",
  "Passaic", "Salem", "Somerset", "Sussex", "Union", "Warren"
];

function getDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

function makeLeadId(name, city) {
  return "wc_" + (name + city).toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 20) + "_" + Date.now();
}

export async function scrapeNJCRIB() {
  log.info("NJCRIB scraper starting...");
  
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  const allResults = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");

    const fromDate = getDaysFromNow(0);
    const toDate = getDaysFromNow(90);

    log.info(`Scraping policies expiring ${fromDate} to ${toDate}...`);

    for (const county of NJ_COUNTIES) {
      try {
        log.info(`Scraping ${county} County...`);
        await page.goto("https://www.njcrib.com/InformationServices/ResidualMarket", {
          waitUntil: "networkidle2",
          timeout: 30000
        });

        // Select search type: County Within A Policy Expiration Date Range
        await page.select("select#searchType", "CountyExpirationDateRange").catch(() =>
          page.evaluate(() => {
            const sel = document.querySelector("select");
            if (sel) sel.value = sel.options[3]?.value || sel.options[0].value;
          })
        );

        await page.waitForTimeout(500);

        // Fill county
        await page.evaluate((c) => {
          const inputs = document.querySelectorAll("input, select");
          inputs.forEach(el => {
            if (el.name?.toLowerCase().includes("county") || el.id?.toLowerCase().includes("county")) {
              if (el.tagName === "SELECT") {
                Array.from(el.options).forEach(opt => {
                  if (opt.text.includes(c)) el.value = opt.value;
                });
              } else {
                el.value = c;
              }
            }
          });
        }, county);

        // Fill date range
        await page.evaluate((from, to) => {
          document.querySelectorAll("input").forEach(el => {
            const n = (el.name || el.id || "").toLowerCase();
            if (n.includes("from") || n.includes("start") || n.includes("begin")) el.value = from;
            if (n.includes("to") || n.includes("end")) el.value = to;
          });
        }, fromDate, toDate);

        // Submit
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
          page.click("button[type=submit], input[type=submit]").catch(() =>
            page.evaluate(() => document.querySelector("form")?.submit())
          )
        ]);

        await page.waitForTimeout(2000);

        // Extract table data
        const rows = await page.evaluate(() => {
          const results = [];
          const tables = document.querySelectorAll("table");
          tables.forEach(table => {
            const rows = table.querySelectorAll("tr");
            rows.forEach((row, i) => {
              if (i === 0) return; // skip header
              const cells = row.querySelectorAll("td");
              if (cells.length >= 4) {
                results.push({
                  name: cells[0]?.innerText?.trim() || "",
                  city: cells[1]?.innerText?.trim() || "",
                  govClass: cells[2]?.innerText?.trim() || "",
                  mod: cells[3]?.innerText?.trim() || "",
                  premium: cells[4]?.innerText?.trim() || "",
                  expirationDate: cells[5]?.innerText?.trim() || "",
                });
              }
            });
          });
          return results;
        });

        log.info(`${county}: found ${rows.length} policies`);
        rows.forEach(r => r.county = county);
        allResults.push(...rows);

      } catch (err) {
        log.warn(`${county} County scrape failed: ${err.message}`);
      }
    }

  } finally {
    await browser.close();
  }

  log.info(`Total NJCRIB results: ${allResults.length} policies found`);
  return allResults;
}

export async function loadNJCRIBLeads() {
  const results = await scrapeNJCRIB();
  
  if (!results.length) {
    log.warn("No NJCRIB results found — skipping lead import");
    return 0;
  }

  const existing = getLeads();
  const existingEmails = new Set(existing.map(l => l.email?.toLowerCase()));
  const existingNames = new Set(existing.map(l => (l.name + l.company).toLowerCase().replace(/\s/g, "")));

  let added = 0;
  const newLeads = [];

  for (const r of results) {
    if (!r.name || r.name.length < 2) continue;

    // Deduplicate by name+city combo
    const key = (r.name + r.city).toLowerCase().replace(/\s/g, "");
    if (existingNames.has(key)) continue;
    existingNames.add(key);

    const lead = {
      id: makeLeadId(r.name, r.city),
      name: r.name,
      company: r.name,
      role: "Business Owner",
      email: null, // No email from NJCRIB — will need enrichment
      type: "Workers Compensation Insurance",
      notes: `WC assigned risk policy in ${r.city}, ${r.county} County NJ. Gov class: ${r.govClass}. Mod: ${r.mod}. Est. premium: ${r.premium}. Policy expires: ${r.expirationDate}.`,
      status: "new",
      source: "njcrib",
      history: [],
      lastContacted: null,
      repliedAt: null,
      followupCount: 0,
      expirationDate: r.expirationDate,
    };

    newLeads.push(lead);
    added++;
  }

  if (added > 0) {
    const combined = [...existing, ...newLeads];
    saveLeads(combined);
    log.success(`Added ${added} new WC leads from NJCRIB`);

    await sendNotification(
      `📋 NJCRIB Scrape Complete — ${added} new WC leads added`,
      `NJCRIB Weekly Scrape Results\n\nPolicies expiring in next 90 days: ${results.length}\nNew leads added: ${added}\nDuplicates skipped: ${results.length - added}\n\nThese businesses are in the NJ assigned risk WC pool and actively need better coverage.\n\nRichard Doron | (609) 757-2221`
    );
  }

  return added;
}
