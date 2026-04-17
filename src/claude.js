import fetch from "node-fetch";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are Richard Doron, a commercial insurance specialist with 30 years of experience in New Jersey. You help ALL types of businesses get better commercial insurance rates.

YOUR VOICE:
- Direct and confident — veteran industry pro, not a salesman
- Short punchy sentences. Real talk. No fluff.
- You know commercial insurance inside out — GL, WC, commercial auto, BOP, contractors, fleet, property
- You help NJ businesses get better rates and better coverage across ALL commercial lines

COVERAGE TYPES YOU SPECIALIZE IN:
- Commercial General Liability (GL)
- Workers Compensation (WC)
- Commercial Auto & Fleet
- Business Owners Policy (BOP)
- Contractors Liability
- Commercial Property
- Excess & Umbrella
- Professional Liability
- Commercial Trucking

RULES:
- Use their FIRST NAME or business name naturally in greeting
- Reference their specific business type, industry, city, and any policy data available
- Match the insurance angle to their business type:
  * Trucking/transport → commercial auto, cargo, DOT compliance
  * Construction/contractors → GL, WC, contractors liability
  * Retail/restaurants → BOP, GL, property
  * Manufacturing → GL, WC, property, product liability
  * Service businesses → GL, professional liability, WC
  * Any business with vehicles → commercial auto
- NEVER say "I hope this email finds you well" or "I wanted to reach out"
- NEVER start two emails the same way — vary openers every time
- Under 140 words
- End with ONE low-friction CTA — "just reply with X"
- ALWAYS end with this exact signature:
Richard Doron
Commercial Insurance Specialist | 30 Years Experience
📞 (609) 757-2221

- Output ONLY valid JSON: {"subject":"...","body":"..."}`;

const SUBJECT_VARIANTS = {
  cold: [
    "Better rates for {company}?",
    "{name} — are you overpaying for commercial insurance?",
    "30 years helping NJ businesses cut insurance costs",
    "{company} — quick question about your coverage",
    "Commercial insurance review for {company}",
    "{name} — {city} businesses are saving 15-25% right now",
    "Is {company} getting the best rates on the market?",
    "One question for {name} at {company}",
  ],
  urgent: [
    "{name} — your policy renewal is coming up",
    "Before you renew — read this",
    "{company} renewal: I can get you better rates in 24 hours",
    "{name} — policy renewing soon? Let me run a comparison",
  ],
  followup: [
    "Following up — {company}",
    "{name}, still worth a quick look",
    "One more thought on your coverage",
    "Circling back — {company}",
  ],
  qualify: [
    "Quick question for {name} at {company}",
    "{name} — two things I need to know",
    "Help me understand your situation, {name}",
  ],
  breakup: [
    "Closing the loop — {company}",
    "Last note, {name}",
    "Leaving the door open — {company}",
  ]
};

function getDaysUntilRenewal(notes) {
  const match = notes && notes.match(/(?:expires?|renewal|effective):?\s*([\d\/]+)/i);
  if (!match) return null;
  try {
    const parts = match[1].split("/");
    if (parts.length < 2) return null;
    const year = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
    const renewalDate = new Date(year, parseInt(parts[0]) - 1, parseInt(parts[1]));
    const today = new Date();
    const diff = Math.round((renewalDate - today) / (1000 * 60 * 60 * 24));
    return diff;
  } catch { return null; }
}

function getFirstName(fullName) {
  if (!fullName || fullName === "nan") return null;
  return fullName.trim().split(" ")[0];
}

function detectBusinessType(lead) {
  const text = ((lead.company || "") + " " + (lead.notes || "") + " " + (lead.type || "")).toLowerCase();
  if (text.match(/truck|transport|carrier|freight|logistics|hauling|moving|motor/)) return "trucking";
  if (text.match(/construct|contractor|builder|electrician|plumber|hvac|roofing|landscap/)) return "contractor";
  if (text.match(/restaurant|food|cafe|diner|bar|tavern|catering/)) return "restaurant";
  if (text.match(/retail|store|shop|boutique|salon|spa/)) return "retail";
  if (text.match(/manufactur|fabricat|processing|warehouse/)) return "manufacturing";
  if (text.match(/medical|dental|health|clinic|therapy|physician/)) return "medical";
  if (text.match(/workers.?comp|wc|assigned risk/)) return "workers_comp";
  return "general";
}

function pickSubject(type, lead, daysUntilRenewal) {
  const firstName = getFirstName(lead.name) || "";
  const company = lead.company || "your business";
  const city = lead.notes ? (lead.notes.split(" in ")[1]?.split(",")[0] || "") : "";

  let variants;
  if (daysUntilRenewal !== null && daysUntilRenewal <= 60 && daysUntilRenewal > 0) {
    variants = SUBJECT_VARIANTS.urgent;
  } else {
    variants = SUBJECT_VARIANTS[type] || SUBJECT_VARIANTS.cold;
  }

  const template = variants[Math.floor(Math.random() * variants.length)];
  return template
    .replace("{name}", firstName)
    .replace("{company}", company)
    .replace("{city}", city);
}

function buildPrompt(lead, campaignType, daysUntilRenewal) {
  const firstName = getFirstName(lead.name) || lead.company?.split(" ")[0] || "there";
  const bizType = detectBusinessType(lead);
  const isUrgent = daysUntilRenewal !== null && daysUntilRenewal <= 60 && daysUntilRenewal > 0;

  const angleMap = {
    trucking: "commercial auto, cargo coverage, DOT compliance, and fleet insurance",
    contractor: "general liability, workers comp, and contractors coverage",
    restaurant: "business owners policy (BOP), general liability, and liquor liability",
    retail: "business owners policy, general liability, and property coverage",
    manufacturing: "general liability, workers comp, property, and product liability",
    medical: "professional liability, general liability, and workers comp",
    workers_comp: "workers compensation — specifically getting out of the assigned risk pool",
    general: "commercial general liability, workers comp, and business insurance",
  };

  const angle = angleMap[bizType] || angleMap.general;

  const tasks = {
    cold: isUrgent
      ? `Write an URGENT cold outreach email to "${firstName}" about their ${angle}. Their policy renews in ${daysUntilRenewal} days. Under 130 words. End with "Just reply with 'rates' and I'll pull a comparison before your renewal."`
      : `Write a cold outreach email to "${firstName}" about ${angle} for their business. Be specific to their industry. Vary the opening. Under 140 words. End with low-friction CTA.`,
    followup: `Write a follow-up email to "${firstName}" — no reply to first email. New angle about ${angle}. Under 110 words. ${isUrgent ? `Renewal in ${daysUntilRenewal} days — add urgency.` : ""}`,
    qualify: `Write a qualification email to "${firstName}" asking 1-2 specific questions about their ${angle} situation. Under 120 words.`,
    breakup: `Write a final break-up email to "${firstName}". Short, respectful, leave door open. Under 80 words.`,
  };

  return `Lead details:
Name: ${lead.name || ""}
Company: ${lead.company || ""}
Business type: ${bizType}
Location: ${lead.notes?.split(" in ")[1]?.split(".")[0] || "New Jersey"}
Notes: ${lead.notes || "NJ commercial business"}
Days until renewal: ${daysUntilRenewal !== null ? daysUntilRenewal : "unknown"}
Insurance angle: ${angle}

Task: ${tasks[campaignType] || tasks.cold}

Output ONLY JSON: {"subject":"","body":"..."}`;
}

export async function generateEmail(lead, campaignType = "cold") {
  const daysUntilRenewal = getDaysUntilRenewal(lead.notes);
  const subject = pickSubject(campaignType, lead, daysUntilRenewal);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 800,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildPrompt(lead, campaignType, daysUntilRenewal) }],
        }),
      });

      if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!parsed.body) throw new Error("Missing body");
      return { subject, body: parsed.body };

    } catch (err) {
      lastError = err;
      log.warn(`Email generation attempt ${attempt}/3 failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`Failed after 3 attempts: ${lastError.message}`);
}
