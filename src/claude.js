import fetch from "node-fetch";
import { log } from "./logger.js";

const TODAY = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

/**
 * UPGRADED CLAUDE MODULE
 * 
 * Improvements:
 * - Added lightweight lead analysis / router before generation
 * - Better support for hot-window vs nurture context
 * - Cleaner structure for future self-improving angle tracking
 * - Still uses fast/cheap Haiku model
 */

const SYSTEM_PROMPT = `TODAY'S DATE IS ${TODAY}. All time references must be accurate relative to today.

You are Richard Doron, a commercial insurance specialist with 30 years of experience in New Jersey. You help businesses get better commercial insurance — especially trucking and workers compensation.

YOUR VOICE:
- Direct, confident, veteran industry pro — not a pushy salesman
- Short punchy sentences. Real talk. No fluff or corporate speak.
- You know NJ commercial insurance inside out
- You help businesses get BETTER RATES and BETTER COVERAGE

LEAD TYPES YOU SPECIALIZE IN:
1. TRUCKING (DOT leads) — commercial auto, cargo, fleet, DOT compliance
2. WORKERS COMP (NJCRIB leads) — getting OUT of the assigned risk pool, saving 20-30%
3. DUAL PITCH — businesses that need both trucking and WC

GENERAL RULES:
- Use the person's FIRST NAME or business name in the greeting
- Reference specific data from the lead (fleet size, current carrier, expiry date, premium, location, notes)
- NEVER use generic openers like "I hope this email finds you well" or "I wanted to reach out"
- Keep emails under 140 words (shorter is better)
- End with ONE low-friction CTA: "just reply to this email" or "call me direct"
- ALWAYS sign off exactly like this:

Richard Doron
Commercial Insurance Specialist | 30 Years Experience
📞 (609) 757-2221

Output ONLY valid JSON in this exact format:
{"subject": "...", "body": "..."}`;

function getFirstName(fullName) {
  if (!fullName || fullName === "nan") return null;
  return fullName.trim().split(" ")[0];
}

function analyzeLead(lead, campaignType = "cold", context = {}) {
  const isHotWindow = context.isHotWindow ?? true;
  const isNurture = context.isNurture ?? false;

  const src = lead.source || "dot";
  const leadType = src === "njcrib_dot" ? "dual" : src === "njcrib" ? "wc" : "trucking";

  let urgency = "normal";
  if (lead.cancellation) urgency = "high";

  return { leadType, urgency, isHotWindow, isNurture };
}

function buildPrompt(lead, campaignType = "cold", context = {}) {
  const analysis = analyzeLead(lead, campaignType, context);
  const firstName = getFirstName(lead.name) || lead.company?.split(" ")[0] || "there";

  const notes = lead.notes || "";
  const extract = (pattern) => (notes.match(pattern) || [])[1] || "";

  const city = extract(/in ([^,\.]+)/);
  const carrier = extract(/Current carrier: ([^.]+)/);
  const fleet = extract(/(\d+) power units/);
  const wcPremium = lead.wcPremium || extract(/WC premium: \$([\d,]+)/);
  const wcExpiry = lead.wcExpDate || lead.expirationDate || "";

  let task = "";

  if (analysis.leadType === "dual") {
    task = analysis.isNurture 
      ? `Write a warm, low-pressure nurture email to "${firstName}" about both their trucking and workers comp.`
      : `Write a cold outreach email to "${firstName}" about BOTH their trucking insurance AND workers comp. Business: ${lead.company}, ${city || "NJ"}. WC expires: ${wcExpiry}. Lead with urgency if in window.`;
  } else if (analysis.leadType === "wc") {
    task = analysis.isNurture
      ? `Write a warm nurture email to "${firstName}" about workers compensation.`
      : `Write a cold outreach email to "${firstName}" about workers compensation. Business: ${lead.company}, ${city || "NJ"}. WC expires: ${wcExpiry}. They are in the NJ ASSIGNED RISK POOL.`;
  } else {
    task = analysis.isNurture
      ? `Write a warm nurture email to "${firstName}" about their trucking insurance.`
      : `Write a cold outreach email to "${firstName}" about commercial trucking insurance. Business: ${lead.company}, ${city || "NJ"}. Fleet: ${fleet || "NJ carrier"}.`;
  }

  if (campaignType === "followup") task += ` This is a follow-up. Use a new angle.`;
  if (campaignType === "qualify") task = `Write a short qualification email to "${firstName}". Ask for key details.`;
  if (campaignType === "breakup") task = `Write a brief break-up email to "${firstName}".`;

  const subjectOptions = {
    dual: [`${lead.company} — WC + Trucking review`, `${firstName} — better options on both`],
    wc: [`${lead.company} — WC expires ${wcExpiry}`, `Get out of assigned risk — save 20-30%`],
    trucking: [`Better rates for ${lead.company}?`, `${firstName} — trucking insurance review`]
  };

  const subject = (subjectOptions[analysis.leadType] || subjectOptions.trucking)[0];

  return {
    taskPrompt: task + `\n\nUnder 140 words. Output ONLY JSON: {"subject":"...", "body":"..."}`,
    subject
  };
}

export async function generateEmail(lead, campaignType = "cold", context = {}) {
  const { taskPrompt, subject } = buildPrompt(lead, campaignType, context);

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
          max_tokens: 600,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: taskPrompt }],
        }),
      });

      if (!res.ok) throw new Error(`Anthropic ${res.status}`);
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);

      return { subject: parsed.subject || subject, body: parsed.body };
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}