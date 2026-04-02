import fetch from "node-fetch";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are Richard Doron, a commercial trucking insurance specialist with 30 years of experience writing short, human cold emails to trucking company owners.

YOUR VOICE:
- Sounds like a real person, not a marketer
- Confident but humble — you know trucking insurance inside out
- Short, direct sentences. No fluff.
- Never mention DOT databases, data sources, or how you found them
- Never use words like "rates getting crushed", "hammered", or overly dramatic phrases
- Never say "I hope this finds you well" or "I wanted to reach out"
- Never sound like a mass email

GOOD EMAIL EXAMPLE:
---
Subject: Quick question about your coverage

Hi Zoly,

I work with trucking and moving companies across New Jersey on their commercial insurance. Been doing it for 30 years.

Most of the owners I talk to are either overpaying, underinsured, or both — usually because their agent doesn't specialize in trucking.

I've helped a lot of similar operations get better coverage at lower cost. Would it be worth a quick 10 minute call to see if I can do the same for you?

Richard Doron | Commercial Trucking Insurance | 30 Years

---

RULES:
- Use their first name naturally in the greeting
- Mention their company name once max
- NEVER mention DOT, databases, or how you found their info
- Keep subject lines simple and conversational — no exclamation marks, no gimmicks
- Under 120 words
- End with ONE simple low-pressure question or offer
- Sign off as: Richard Doron | Commercial Trucking Insurance | 30 Years
- Output ONLY valid JSON: {"subject":"...","body":"..."}`;

const OPENING_VARIATIONS = [
  "I work with trucking companies across the area on their commercial insurance.",
  "I specialize in commercial insurance for trucking and transportation companies.",
  "I've been working with trucking operations on their insurance for 30 years.",
  "I help trucking companies get better coverage without overpaying.",
  "My entire practice is built around commercial insurance for trucking companies.",
];

const MIDDLE_VARIATIONS = [
  "Most owners I talk to are overpaying — usually because their agent doesn't specialize in trucking.",
  "The biggest problem I see is agents who treat trucking like any other business. It's not.",
  "After 30 years I know what coverage actually protects you on the road and what's just expensive paper.",
  "Most of my clients save 15-25% while actually improving their coverage once we review their policy.",
  "A lot of carriers are carrying gaps they don't know about until a claim gets denied.",
];

function buildPrompt(lead, campaignType) {
  const firstName = lead.name ? lead.name.split(" ")[0] : "there";
  const opening = OPENING_VARIATIONS[Math.floor(Math.random() * OPENING_VARIATIONS.length)];
  const middle = MIDDLE_VARIATIONS[Math.floor(Math.random() * MIDDLE_VARIATIONS.length)];

  const prompts = {
    cold: `Write a natural, human cold email to ${firstName} at ${lead.company || "their trucking company"} in ${lead.notes?.match(/in ([^.]+)\./)?.[1] || "the area"}.

Opening direction: "${opening}"
Middle direction: "${middle}"

Keep it under 120 words. Sound like one professional reaching out to another — not a sales blast. End with a simple low-pressure offer for a quick call.`,

    followup: `Write a brief, warm follow-up email to ${firstName} at ${lead.company || "their company"}. They didn't reply to the first email. Reference that you reached out previously. One new thought. Under 80 words. Very low pressure.`,

    qualify: `Write a short email to ${firstName} asking one simple question about their trucking insurance — when it renews, how many trucks they run, or whether they've ever shopped it. Under 80 words. Conversational.`,

    breakup: `Write a final brief email to ${firstName}. Acknowledge they may not be interested. Leave door open gracefully. Under 60 words. No pressure at all.`,
  };

  return prompts[campaignType] || prompts.cold;
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
