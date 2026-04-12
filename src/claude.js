import fetch from "node-fetch";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are Richard Doron, a commercial trucking insurance specialist with 30 years of experience in New Jersey.

YOUR VOICE:
- Direct and confident — veteran industry pro, not a salesman
- Short punchy sentences. Real talk. No fluff.
- You know trucking inside out — DOT, cargo claims, premiums, compliance
- You help NJ carriers get better rates and better coverage

RULES:
- Use their FIRST NAME only in greeting
- Reference their specific fleet size, current carrier, years in business, and city when available
- Mention their renewal timing as an opportunity
- Under 140 words total
- End with ONE easy low-friction CTA — "just reply with X" style
- ALWAYS end with this exact signature:

Richard Doron
Commercial Trucking Insurance Specialist | 30 Years Experience
📞 (609) 757-2221

- NEVER say "I hope this email finds you well" or "I wanted to reach out" or "I am reaching out"
- NEVER start two emails the same way — vary openers every time
- Output ONLY valid JSON: {"subject":"...","body":"..."}`;

function getFirstName(fullName) {
  if (!fullName || fullName === "nan") return null;
  return fullName.trim().split(" ")[0];
}

function buildPrompt(lead, campaignType) {
  const firstName = getFirstName(lead.name) || "there";

  const tasks = {
    cold: `Write a cold outreach email. Address them as "${firstName}". Be specific — reference their fleet size, current carrier, city, and renewal date from the notes. Make it feel personal and relevant. End with a low-friction CTA like "just reply with 'quote'" or "just reply with 'interested'".`,
    followup: `Write a follow-up email to "${firstName}" — they did not reply to the first email. New angle, under 110 words. Add urgency around renewal timing or market rates. Easy one-word CTA.`,
    qualify: `Write a qualification email to "${firstName}". Ask 1-2 specific questions — how many trucks, what they haul, exact renewal date. Conversational, under 120 words.`,
    breakup: `Write a final break-up email to "${firstName}". Short, respectful, leave door wide open. Under 80 words. No pressure.`,
  };

  return `Lead details:
Name: ${lead.name || ""}
Company: ${lead.company || ""}
Email: ${lead.email}
Notes: ${lead.notes || "NJ trucking carrier"}

Task: ${tasks[campaignType] || tasks.cold}

Output ONLY JSON: {"subject":"...","body":"..."}`;
}

export async function generateEmail(lead, campaignType = "cold") {
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
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildPrompt(lead, campaignType) }],
        }),
      });

      if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
      const data  = await res.json();
      const text  = data.content?.map(b => b.text || "").join("") || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!parsed.subject || !parsed.body) throw new Error("Missing subject or body");
      return parsed;

    } catch (err) {
      lastError = err;
      log.warn(`Email generation attempt ${attempt}/3 failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`Failed after 3 attempts: ${lastError.message}`);
}
