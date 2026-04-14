import fetch from "node-fetch";
import { log } from "./logger.js";

const TRUCKING_SYSTEM = `You are Richard Doron, a commercial trucking insurance specialist with 30 years of experience in New Jersey.

YOUR VOICE:
- Direct and confident — veteran industry pro, not a salesman
- Short punchy sentences. Real talk. No fluff.
- You know trucking inside out — DOT, cargo claims, premiums, compliance
- You help NJ carriers get better rates and better coverage

RULES:
- Use their FIRST NAME only in greeting
- Reference their specific fleet size, current carrier, city, and years in business when available
- NEVER say "I hope this email finds you well" or "I wanted to reach out"
- Vary openers every time
- Under 140 words
- End with ONE low-friction CTA
- ALWAYS end with:
Richard Doron
Commercial Trucking Insurance Specialist | 30 Years Experience
📞 (609) 757-2221
- Output ONLY valid JSON: {"subject":"...","body":"..."}`;

const PITCH_SUBJECTS = [
  "33% open rates vs 15-20% industry average",
  "Set it and forget it: 299 prospect emails daily",
  "Replace your $3K/month agency spend with this",
  "Your competitors are already automating outreach",
  "299 personalized carrier emails/day — zero effort from you",
];

const PITCH_SYSTEM = `You are Matt Doron pitching CoverReach, a done-for-you AI email outreach system for insurance offices.

COMBINE THESE THREE ANGLES INTO ONE EMAIL:
1. STAT ANGLE: 33% open rates vs industry 15-20% average — lead with the proof
2. SET AND FORGET ANGLE: 299 personalized emails/day, zero daily effort, AI handles everything
3. COST ANGLE: Better results than a $3,000/month agency for just $199/month

KEY FACTS:
- Sends 299 personalized AI-written emails per day automatically
- References each carrier's real fleet size, current insurer, city, renewal date
- Already proven live on a New Jersey trucking book of business
- Matt builds, manages, and maintains everything
- They just close the deals

TONE: Direct, confident, one insurance professional to another. No fluff. Lead with results.
LENGTH: Under 175 words
CTA: Soft — reply for a demo or to see the numbers
SIGN OFF: Matt Doron | CoverReach | (609) 622-5037
Output ONLY valid JSON: {"subject":"...","body":"..."}`;

const TRUCKING_SUBJECTS = {
  cold: [
    "Better rates for {company}'s {trucks}-unit fleet?",
    "{name} — are you overpaying for trucking coverage?",
    "30 years helping truckers cut insurance costs",
    "{company} — your {carrier} policy vs. what I can get you",
    "{name} — {city} carriers are saving 15-25% right now",
    "Trucking insurance that actually understands your operation",
  ],
  urgent: [
    "{name} — your renewal is coming up fast",
    "Before you renew with {carrier} — read this",
    "{company} renewal: better rates in 24 hours",
    "{name} — policy renewing soon? Let me run a comparison",
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
    const renewalDate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
    const today = new Date();
    const diff = Math.round((renewalDate - today) / (1000 * 60 * 60 * 24));
    return diff;
  } catch { return null; }
}

function getFirstName(fullName) {
  if (!fullName || fullName === "nan") return null;
  return fullName.trim().split(" ")[0];
}

function pickTruckingSubject(type, lead, daysUntilRenewal) {
  const firstName = getFirstName(lead.name) || "";
  const company = lead.company || "your company";
  const carrier = (lead.notes && lead.notes.match(/Current carrier: ([^.]+)/)) ? lead.notes.match(/Current carrier: ([^.]+)/)[1].trim() : "your carrier";
  const trucks = (lead.notes && lead.notes.match(/(\d+) power units/)) ? lead.notes.match(/(\d+) power units/)[1] : "";
  const city = lead.notes ? (lead.notes.split(" in ")[1] || "").split(".")[0] : "";

  let variants;
  if (daysUntilRenewal !== null && daysUntilRenewal <= 60 && daysUntilRenewal > 0) {
    variants = TRUCKING_SUBJECTS.urgent;
  } else {
    variants = TRUCKING_SUBJECTS[type] || TRUCKING_SUBJECTS.cold;
  }

  const template = variants[Math.floor(Math.random() * variants.length)];
  return template
    .replace("{name}", firstName)
    .replace("{company}", company)
    .replace("{carrier}", carrier)
    .replace("{trucks}", trucks)
    .replace("{city}", city);
}

function buildTruckingPrompt(lead, campaignType, daysUntilRenewal) {
  const firstName = getFirstName(lead.name) || "there";
  const isUrgent = daysUntilRenewal !== null && daysUntilRenewal <= 60 && daysUntilRenewal > 0;

  const tasks = {
    cold: isUrgent
      ? `Write an URGENT cold email to "${firstName}". Policy renews in ${daysUntilRenewal} days — use this as the hook. Under 130 words. CTA: "Just reply with 'rates' and I'll pull a comparison before your renewal."`
      : `Write a cold email to "${firstName}". Use their fleet size, current carrier, city, and years in business. Vary the opening. Under 140 words. Low-friction CTA.`,
    followup: `Follow-up to "${firstName}" — no reply to first email. New angle, under 110 words. ${isUrgent ? `Renewal in ${daysUntilRenewal} days — add urgency.` : "Fresh insight about trucking insurance costs."}`,
    qualify: `Qualification email to "${firstName}". Ask 1-2 specific questions — exact renewal date, trucks, cargo. Under 120 words.`,
    breakup: `Final break-up email to "${firstName}". Short, respectful, leave door open. Under 80 words.`,
  };

  return `Lead:
Name: ${lead.name || ""}
Company: ${lead.company || ""}
Notes: ${lead.notes || "NJ trucking carrier"}
Days until renewal: ${daysUntilRenewal !== null ? daysUntilRenewal : "unknown"}

Task: ${tasks[campaignType] || tasks.cold}
Output ONLY JSON: {"subject":"","body":"..."}`;
}

function buildPitchPrompt(lead) {
  const firstName = getFirstName(lead.name) || "there";
  const company = lead.company || "your agency";
  const subject = PITCH_SUBJECTS[Math.floor(Math.random() * PITCH_SUBJECTS.length)];

  return `Write a pitch email combining all three angles (open rate stats, set-and-forget automation, cost vs agencies) for:
Name: ${firstName}
Company: ${company}

Make it feel personal to an insurance office owner. Subject: "${subject}"
Output ONLY JSON: {"subject":"${subject}","body":"..."}`;
}

export async function generateEmail(lead, campaignType = "cold") {
  const isPitchLead = lead.type === "insurance_office";
  const daysUntilRenewal = isPitchLead ? null : getDaysUntilRenewal(lead.notes);

  const system = isPitchLead ? PITCH_SYSTEM : TRUCKING_SYSTEM;
  const prompt = isPitchLead
    ? buildPitchPrompt(lead)
    : buildTruckingPrompt(lead, campaignType, daysUntilRenewal);

  const subject = isPitchLead
    ? null
    : pickTruckingSubject(campaignType, lead, daysUntilRenewal);

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
          max_tokens: 1000,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!parsed.body) throw new Error("Missing body");

      return {
        subject: parsed.subject || subject,
        body: parsed.body
      };

    } catch (err) {
      lastError = err;
      log.warn(`Email generation attempt ${attempt}/3 failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`Failed after 3 attempts: ${lastError.message}`);
}
