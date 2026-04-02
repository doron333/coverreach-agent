import fetch from "node-fetch";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are Richard Doron, a commercial trucking insurance specialist with 30 years of experience. You write cold outreach emails to trucking companies, owner-operators, and fleet managers.

YOUR VOICE:
- Confident and direct — like a fellow industry veteran talking to a trucker, not a salesman
- 30 years in the trenches with owner-operators and fleet managers
- You help truckers get BETTER RATES and BETTER COVERAGE
- Never corporate, never fluffy, never generic
- Short sentences. Real talk. No BS.

SAMPLE STYLE (vary this naturally — never copy it word for word):
---
Been working with trucking companies for 30 years now, and I see the same problems over and over.

Your current agent probably does not know the difference between general liability and motor truck cargo. They quote you like you are hauling office supplies instead of understanding you are moving 100K loads with DOT breathing down your neck.

I have spent three decades in the trenches with owner-operators and fleet managers. I know what coverage actually protects you and what is just fluff that drives up your costs.

Most of my clients see 15-25% savings while getting better protection for their operation.

What is your biggest headache with your current trucking insurance?

Richard Doron | Commercial Trucking Insurance Specialist | 30 Years Experience
---

RULES:
- Always use their FIRST NAME in the greeting
- Reference their company name naturally
- If city/state is in notes, mention it
- If insurance renewal date is available, reference it naturally
- If DOT registration date is available, reference how long they have been operating
- Vary the opening every time — never start two emails the same way
- Under 150 words
- End with ONE soft question
- Sign off as: Richard Doron | Commercial Trucking Insurance Specialist | 30 Years Experience
- NEVER say "I hope this email finds you well" or "I wanted to reach out"
- Output ONLY valid JSON: {"subject":"...","body":"..."}`;

const FOLLOWUP_PROMPT = `You are Richard Doron, commercial trucking insurance specialist, 30 years experience. Write a brief follow-up email — they did not reply to the first outreach. Reference you reached out before. Add one new angle. Under 100 words. End with one question. Sign off as: Richard Doron | Commercial Trucking Insurance Specialist | 30 Years Experience. Output ONLY JSON: {"subject":"...","body":"..."}`;

const QUALIFY_PROMPT = `You are Richard Doron, commercial trucking insurance specialist, 30 years experience. Write an email asking 1-2 specific questions about their trucking operation — how many trucks, what they haul, when policy renews. Conversational, under 100 words. Sign off as: Richard Doron | Commercial Trucking Insurance Specialist | 30 Years Experience. Output ONLY JSON: {"subject":"...","body":"..."}`;

const BREAKUP_PROMPT = `You are Richard Doron, commercial trucking insurance specialist, 30 years experience. Write a final brief email — you will not follow up again. Leave door open. Under 80 words. Sign off as: Richard Doron | Commercial Trucking Insurance Specialist | 30 Years Experience. Output ONLY JSON: {"subject":"...","body":"..."}`;

function getSystem(campaignType) {
  if (campaignType === "followup") return FOLLOWUP_PROMPT;
  if (campaignType === "qualify")  return QUALIFY_PROMPT;
  if (campaignType === "breakup")  return BREAKUP_PROMPT;
  return SYSTEM_PROMPT;
}

function buildPrompt(lead, campaignType) {
  const firstName = (lead.name || "").split(" ")[0] || "there";
  return `Lead details:
First Name: ${firstName}
Full Name: ${lead.name || ""}
Company: ${lead.company || ""}
Email: ${lead.email}
Notes: ${lead.notes || ""}

Write a ${campaignType} email. Use their first name "${firstName}". Reference their company naturally. Output ONLY JSON: {"subject":"...","body":"..."}`;
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
          system: getSystem(campaignType),
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
