import fetch from "node-fetch";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are Richard Doron, a commercial trucking insurance specialist with 30 years of experience in New Jersey.

YOUR VOICE:
- Direct and confident — veteran industry pro, not a salesman
- Short punchy sentences. Real talk. No fluff.
- You know trucking inside out — DOT, cargo claims, premiums, compliance
- You help NJ carriers get better rates and better coverage

RULES:
- Use their FIRST NAME only in greeting — never "Hi there" or "Dear"
- Reference their specific fleet size, current carrier, city, and years in business when available
- NEVER say "I hope this email finds you well" or "I wanted to reach out" or "I am reaching out"
- NEVER start two emails the same way — vary openers every time
- Output ONLY valid JSON: {"subject":"...","body":"..."}

SIGNATURE — always end every email with exactly this:
Richard Doron
Commercial Trucking Insurance Specialist | 30 Years Experience
📞 (609) 757-2221`;

const SUBJECT_VARIANTS = {
  cold: [
    "Better rates for {company}'s {trucks}-unit fleet?",
    "{name} — are you overpaying for trucking coverage?",
    "30 years helping truckers cut insurance costs — quick question",
    "{company} — your {carrier} policy vs. what I can get you",
    "Trucking insurance that actually understands your operation",
    "{name} — {city} carriers are saving 15-25% right now",
  ],
  urgent: [
    "{name} — your renewal is coming up fast",
    "Before you renew with {carrier} — read this",
    "{company} renewal: I can get you better rates in 24 hours",
    "{name} — policy renewing soon? Let me run a quick comparison",
  ],
  followup: [
    "Following up — {company}",
    "{name}, still worth a quick look",
    "One more thought on your trucking coverage",
  ],
  qualify: [
    "Quick question for {name} at {company}",
    "{name} — two things I need to know",
  ],
  breakup: [
    "Closing the loop — {company}",
    "Last note, {name}",
  ]
};

function getDaysUntilRenewal(notes) {
  const match = notes && notes.match(/Insurance effective: ([\d\/]+)/);
  if (!match) return null;
  try {
    const parts = match[1].split("/");
    if (parts.length < 3) return null;
    const renewalDate = new Date(parts[2], parts[0] - 1, parts[1]);
    const today = new Date();
    const diff = Math.round((renewalDate - today) / (1000 * 60 * 60 * 24));
    return diff;
  } catch { return null; }
}

function getFirstName(fullName) {
  if (!fullName || fullName === "nan") return null;
  return fullName.trim().split(" ")[0];
}

function pickSubject(type, lead, daysUntilRenewal) {
  const firstName = getFirstName(lead.name) || "there";
  const company = lead.company || "your company";
  const carrier = (lead.notes && lead.notes.match(/Current carrier: ([^.]+)/)) ? lead.notes.match(/Current carrier: ([^.]+)/)[1].trim() : "your current carrier";
  const trucks = (lead.notes && lead.notes.match(/(\d+) power units/)) ? lead.notes.match(/(\d+) power units/)[1] : "";
  const city = lead.notes ? lead.notes.split(" in ")[1]?.split(".")[0] || "" : "";

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
    .replace("{carrier}", carrier)
    .replace("{trucks}", trucks)
    .replace("{city}", city);
}

function buildPrompt(lead, campaignType, daysUntilRenewal) {
  const firstName = getFirstName(lead.name) || "there";
  const isUrgent = daysUntilRenewal !== null && daysUntilRenewal <= 60 && daysUntilRenewal > 0;

  const tasks = {
    cold: isUrgent
      ? `Write an URGENT cold outreach email to "${firstName}". Their policy renews in ${daysUntilRenewal} days — this is the hook. Create real urgency without being pushy. Under 130 words. End with "Just reply with 'rates' and I'll pull a comparison before your renewal."`
      : `Write a cold outreach email to "${firstName}". Be specific — use their fleet size, current carrier, city, and years in business. Vary the opening. Under 140 words. End with a low-friction CTA like "just reply with 'quote'" or "just reply with 'rates'".`,
    followup: `Write a follow-up to "${firstName}" — they did not reply to the first email. New angle, under 110 words. ${isUrgent ? `Their renewal is in ${daysUntilRenewal} days — add urgency.` : "Add a fresh insight about trucking insurance costs."} Easy one-word CTA.`,
    qualify: `Write a qualification email to "${firstName}". Ask 1-2 specific questions — exact renewal date, number of trucks, what they haul. Conversational, under 120 words.`,
    breakup: `Write a final break-up email to "${firstName}". Short, respectful, leave door wide open. Under 80 words. No pressure. Make it memorable.`,
  };

  return `Lead details:
Name: ${lead.name || ""}
Company: ${lead.company || ""}
Email: ${lead.email}
Notes: ${lead.notes || "NJ trucking carrier"}
Days until renewal: ${daysUntilRenewal !== null ? daysUntilRenewal : "unknown"}

Task: ${tasks[campaignType] || tasks.cold}

Output ONLY JSON with keys subject and body. The subject line I provide separately — just output the body.
Output: {"subject":"","body":"..."}`;
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
