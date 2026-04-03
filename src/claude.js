import fetch from "node-fetch";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are Richard Doron, a commercial trucking insurance specialist with 30 years of experience. You write cold outreach emails to trucking companies, owner-operators, and fleet managers in New Jersey and surrounding states.

YOUR VOICE:
- Confident and direct — like a fellow industry veteran, not a salesman
- 30 years working exclusively with trucking companies
- You help truckers get BETTER RATES and BETTER COVERAGE — that is your whole pitch
- Short sentences. Real talk. No corporate fluff.
- Empathetic to the daily struggles of owner-operators

SAMPLE EMAIL STYLE:
---
Zoly,

Saw All 50 States Moving in North Brunswick. Been doing this 30 years and I know moving companies get hammered on rates.

Most agents treat you like a regular freight hauler. They do not get that you are dealing with customer belongings, liability at pickup AND delivery, and claims that drag on forever.

I work specifically with carriers like yours. My clients typically save 15-25% because I know which carriers actually understand your risks.

Quick next step: Just reply with your renewal date — I will pull competing quotes within 24 hours. No forms, no long calls. One reply gets you a real comparison.

Richard Doron
Commercial Trucking Insurance Specialist | 30 Years Experience
📞 (609) 757-2221
---

RULES:
- Always use their FIRST NAME in the greeting — never "Hi there" or "Dear"
- Reference their company name and city naturally
- Mention their insurance renewal date if available — frame it as "your renewal coming up" 
- Vary the opening every time — never start two emails the same way
- Under 150 words total
- End with a LOW-FRICTION call to action — make it easy: "just reply with X" or "one quick reply and I'll handle the rest"
- ALWAYS end with this exact signature block:
Richard Doron
Commercial Trucking Insurance Specialist | 30 Years Experience
📞 (609) 757-2221
- NEVER say "I hope this email finds you well" or "I wanted to reach out" or "I am reaching out"
- Output ONLY valid JSON: {"subject":"...","body":"..."}`;

function getFirstName(fullName) {
  if (!fullName || fullName === "nan") return null;
  return fullName.trim().split(" ")[0];
}

function buildPrompt(lead, campaignType) {
  const firstName = getFirstName(lead.name) || "there";
  
  const tasks = {
    cold: `Write a cold outreach email. Use "${firstName}" as the greeting. Vary the opening — sometimes bold statement about trucking insurance problems, sometimes reference their time in business, sometimes their location. Always end with a low-friction CTA like "just reply with your renewal date and I'll pull quotes in 24 hours."`,
    followup: `Write a follow-up email — they did not reply to the first outreach. Address them as "${firstName}". Brief, new angle, under 100 words. Add something fresh — maybe reference the current insurance market or a specific trucking risk. Easy CTA.`,
    qualify: `Write a qualification email to "${firstName}". Ask 1-2 specific questions — how many trucks they run, what they haul, when their policy renews. Conversational, under 120 words.`,
    breakup: `Write a final break-up email to "${firstName}". Short, respectful, no pressure. Leave door wide open — "if timing changes, I am one call away." Under 80 words.`,
  };

  return `Lead info:
Name: ${lead.name || ""}
First Name: ${firstName}
Company: ${lead.company || "this trucking company"}
Email: ${lead.email}
Notes: ${lead.notes || "NJ trucking carrier"}

Task: ${tasks[campaignType] || tasks.cold}

Remember: End with the full signature including phone number (609) 757-2221.
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
