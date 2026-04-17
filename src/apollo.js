import fetch from "node-fetch";
import { getLeads, saveLeads } from "./leads.js";
import { log } from "./logger.js";
import { sendNotification } from "./gmail.js";

const APOLLO_API = "https://api.apollo.io/v1";

// NJ commercial business searches
const SEARCH_CONFIGS = [
  {
    label: "Contractors & Construction",
    industries: ["Construction"],
    titles: ["Owner", "President", "Principal", "CEO", "Partner"],
    employeeRanges: [["1", "50"]],
  },
  {
    label: "Transportation & Trucking",
    industries: ["Transportation", "Trucking", "Logistics"],
    titles: ["Owner", "President", "CEO", "Principal"],
    employeeRanges: [["1", "100"]],
  },
  {
    label: "Restaurants & Food Service",
    industries: ["Restaurants", "Food & Beverages"],
    titles: ["Owner", "Operator", "President", "Manager"],
    employeeRanges: [["1", "50"]],
  },
  {
    label: "Manufacturing",
    industries: ["Manufacturing"],
    titles: ["Owner", "President", "CEO", "Principal"],
    employeeRanges: [["5", "200"]],
  },
  {
    label: "Healthcare & Medical",
    industries: ["Hospital & Health Care", "Medical Practice"],
    titles: ["Owner", "President", "Principal", "Director"],
    employeeRanges: [["1", "100"]],
  },
  {
    label: "Retail & Services",
    industries: ["Retail", "Consumer Services", "Automotive"],
    titles: ["Owner", "President", "CEO"],
    employeeRanges: [["1", "50"]],
  },
];

async function apolloSearch(config, page = 1) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error("APOLLO_API_KEY not set");

  const payload = {
    api_key: apiKey,
    page,
    per_page: 100,
    person_locations: ["New Jersey, United States"],
    person_titles: config.titles,
    organization_industry_tag_ids: [],
    q_organization_keyword_tags: config.industries,
    contact_email_status: ["verified", "likely to engage"],
    prospected_by_current_team: ["no"],
  };

  const res = await fetch(`${APOLLO_API}/mixed_people/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Apollo API error ${res.status}: ${err.slice(0, 200)}`);
  }

  return await res.json();
}

function apolloToLead(person, industryLabel) {
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ");
  const company = person.organization?.name || "";
  const email = person.email || "";
  const city = person.city || person.organization?.city || "";
  const state = person.state || person.organization?.state || "NJ";
  const title = person.title || "";
  const employees = person.organization?.estimated_num_employees || "";
  const phone = person.phone_numbers?.[0]?.sanitized_number || person.organization?.phone || "";

  if (!email || !company) return null;

  return {
    id: `apollo_${person.id || Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    name,
    company,
    role: title,
    email: email.toLowerCase(),
    phone,
    type: "Commercial Insurance",
    source: "apollo",
    industry: industryLabel,
    notes: `Commercial business in ${city}, ${state}. Industry: ${industryLabel}. Title: ${title}. ${employees ? `Employees: ${employees}.` : ""}`,
    status: "new",
    history: [],
    lastContacted: null,
    repliedAt: null,
    followupCount: 0,
  };
}

export async function pullApolloLeads(maxPerSearch = 200) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    log.warn("APOLLO_API_KEY not configured — skipping Apollo pull");
    return 0;
  }

  log.info("Apollo pull starting...");

  const existing = getLeads();
  const existingEmails = new Set(existing.map(l => l.email?.toLowerCase()).filter(Boolean));

  let totalAdded = 0;
  const newLeads = [];

  for (const config of SEARCH_CONFIGS) {
    try {
      log.info(`Apollo: pulling ${config.label}...`);
      let page = 1;
      let pulled = 0;

      while (pulled < maxPerSearch) {
        const data = await apolloSearch(config, page);
        const people = data.people || data.contacts || [];

        if (!people.length) break;

        for (const person of people) {
          const lead = apolloToLead(person, config.label);
          if (!lead) continue;
          if (existingEmails.has(lead.email)) continue;

          existingEmails.add(lead.email);
          newLeads.push(lead);
          pulled++;
        }

        if (people.length < 100) break;
        page++;
        await new Promise(r => setTimeout(r, 1000));
      }

      log.success(`Apollo ${config.label}: ${pulled} new leads`);
      totalAdded += pulled;

    } catch (err) {
      log.error(`Apollo ${config.label} failed: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  if (newLeads.length > 0) {
    const combined = [...existing, ...newLeads];
    saveLeads(combined);
    log.success(`Apollo pull complete — ${totalAdded} new leads added`);

    await sendNotification(
      `🚀 Apollo Pull Complete — ${totalAdded} new leads added`,
      `Weekly Apollo lead pull results:\n\n${SEARCH_CONFIGS.map(c => `• ${c.label}`).join("\n")}\n\nTotal new leads: ${totalAdded}\nAll leads loaded and ready for outreach.\n\nRichard Doron | (609) 757-2221`
    );
  }

  return totalAdded;
}
