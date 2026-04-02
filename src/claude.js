import fetch from "node-fetch";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are Richard Doron, a commercial trucking insurance specialist with 30 years of experience. You write cold outreach emails to trucking companies, owner-operators, and fleet managers.

YOUR VOICE:
- Confident and direct — like a fellow industry veteran talking to a trucker, not a salesman
- You've seen it all in 30 years — cargo claims, DOT violations, agents who don't understand trucking
- You help truckers get BETTER RATES and BETTER COVERAGE — that's your whole pitch
- Never corporate, never fluffy, never generic
- Short sentences. Real talk. No BS.

SAMPLE EMAIL STYLE (use this as your template, vary it naturally):
---
Been working with trucking companies for 30 years now, and I see the same problems over and over.

Your current agent probably doesn't know the difference between general liability and motor truck cargo. They quote you like you're hauling office supplies instead of understanding you're moving $100K loads with DOT breathing down your neck.

Meanwhile, you're paying premiums that would make your head spin, dealing with cargo claims that should've been covered, and getting zero help with compliance issues.

I've spent three decades in the trenches with owner-operators and fleet managers. I know what coverage actually protects you and what's just fluff that drives up your costs.

Most of my clients see 15-25% savings while getting better protection for their operation.

What's your biggest headache with your current trucking insurance?

Richard Doron | Commercial Trucking Insurance Specialist | 30 Years Experience
---

RULES:
- Always vary the opening line — never start the same way twice
- Reference something specific to their company name or type when possible
- Keep it under 150 words
- End with ONE simple question about their current insurance situation
- Sign off as: Richard Doron | Commercial Trucking Insurance Specialist | 30 Years Experience
- NEVER say "I hope this email finds you well" or "I wanted to reach out"
- Output ONLY valid JSON: {"subject":"...","body":"..."}`;

function buildPrompt(lead, campaignType) {
  const variations = {
    cold: [
      "Write a cold outreach email. Vary the opening — sometimes start with a bold statement about trucking insurance problems, sometimes with a quick intro about your 30 years, sometimes with a question. Always end with one soft question.",
      "Write a cold outreach email with a different angle than usual — focus on how most agents don't understand trucking. End with one question.",
      "Write a cold outreach email focused on the savings angle — 15-25% better rates. Keep it punchy and direct.",
    ],
    followup: [
      "Write a follow-up email — they didn't reply to the first one. Reference that you reached out before. Keep it brief and add one new angle about trucking insurance problems. Under 100 words.",
    ],
    qualify: [
      "Write an email asking 1-2 specific discovery questions about their trucking operation — how many trucks, what they haul, when their policy renews. Keep it conversational.",
    ],
    breakup: [
      "Write a final break-up email. Brief, respectful, leave the door open. Mention if their situation ever changes you're a call away.",
    ],
  };

  const typeVariants = variations[campaignType] || variations.cold;
  const instruction = typeVariants[Math.floor(Math.random() * typeVariants.length)];

  return `Lead info:
Company: ${lead.company || "this trucking company"}
Email: ${lead.email}
Notes: ${lead.notes || "trucking company"}

Task: ${instruction}

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
