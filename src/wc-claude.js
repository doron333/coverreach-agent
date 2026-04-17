import fetch from "node-fetch";
import { log } from "./logger.js";

const WC_SYSTEM_PROMPT = `You are Richard Doron, a commercial insurance specialist with 30 years of experience in New Jersey, specializing in workers compensation insurance.

YOUR VOICE:
- Direct and confident — veteran industry pro talking to a business owner
- You know WC inside out — experience mods, assigned risk pool, class codes, premiums
- You help businesses get OUT of the assigned risk pool and save 20-30% on WC
- Short sentences. Real talk. No fluff.

RULES:
- Use their business name naturally
- Reference their assigned risk pool status — this is the key pain point
- Mention their policy expiration timing
- Under 140 words
- End with easy CTA: "just reply with your FEIN and I'll run a quick comparison"
- ALWAYS end with this signature:
Richard Doron
Commercial Insurance Specialist | 30 Years Experience
📞 (609) 757-2221

- Output ONLY valid JSON: {"subject":"...","body":"..."}`;

export async function generateWCEmail(lead) {
  const daysUntilExpiry = lead.expirationDate ? Math.round(
    (new Date(lead.expirationDate) - new Date()) / (1000 * 60 * 60 * 24)
  ) : null;

  const isUrgent = daysUntilExpiry !== null && daysUntilExpiry <= 45;

  const prompt = `Write a cold outreach email for this NJ business about their workers compensation insurance:
Business: ${lead.company}
City: ${lead.city || "New Jersey"}
Notes: ${lead.notes}
Days until policy expires: ${daysUntilExpiry !== null ? daysUntilExpiry : "unknown"}

${isUrgent ? "URGENT — their policy expires soon. Create real urgency." : "Standard outreach — focus on getting them out of assigned risk pool."}

Key message: They are in the NJ assigned risk WC pool (paying higher rates). You can help them get into the voluntary market and save 20-30%.

Output ONLY JSON: {"subject":"...","body":"..."}`;

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
        system: WC_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    const text = data.content?.map(b => b.text || "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    log.error(`WC email generation failed: ${err.message}`);
    throw err;
  }
}
