import fetch from "node-fetch";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are an expert insurance sales email copywriter. You write concise, personalized, non-spammy emails for independent insurance brokers and commercial/B2B insurance agents. Your emails sound human, confident, and relevant — never generic or salesy. Always output ONLY valid JSON with exactly two keys: "subject" and "body". No markdown formatting, no code fences, no extra text — just the raw JSON object.`;

function buildPrompt(lead, campaignType, senderName, senderTitle) {
  const typeInstructions = {
    cold: `This is a FIRST-TOUCH cold email. Be genuine and brief — under 150 words. No hard sell. End with a single soft, open-ended question to spark a reply. Do NOT use clichés like "I hope this email finds you well."`,
    followup: `This is a FOLLOW-UP email — they have not replied to the first outreach (sent about a week ago). Reference that you reached out previously. Keep it warm, not pushy. Under 120 words. One clear, low-friction ask.`,
    qualify: `This is a QUALIFICATION email. Ask 1-2 thoughtful discovery questions to understand their current setup and potential fit. Under 130 words. Make it feel like genuine curiosity, not an interrogation.`,
    breakup: `This is a FINAL "break-up" email — last attempt after 3+ touchpoints with no reply. Acknowledge you won't keep reaching out. Leave the door open warmly. Under 100 words. No guilt-tripping.`,
  };

  return `Write a "${campaignType}" outreach email for this prospect:

Name: ${lead.name}
Title: ${lead.role || "Insurance Professional"}
Company: ${lead.company}
Email: ${lead.email}
Insurance Focus: ${lead.type}
Notes / Context: ${lead.notes || "Independent insurance broker"}
Follow-up Count: ${lead.followupCount || 0}

Instructions: ${typeInstructions[campaignType] || typeInstructions.cold}

Sign off as: ${senderName} | ${senderTitle}

Return ONLY a raw JSON object — no markdown, no backticks:
{"subject":"...","body":"..."}`;
}

export async function generateEmail(lead, campaignType = "cold") {
  const senderName  = process.env.SENDER_NAME  || "Alex Rivera";
  const senderTitle = process.env.SENDER_TITLE || "Insurance Solutions Specialist";

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":    "application/json",
          "x-api-key":       process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model:      "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system:     SYSTEM_PROMPT,
          messages:   [{ role: "user", content: buildPrompt(lead, campaignType, senderName, senderTitle) }],
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${err}`);
      }

      const data  = await res.json();
      const text  = data.content?.map(b => b.text || "").join("") || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);

      if (!parsed.subject || !parsed.body) throw new Error("Missing subject or body in response");
      return parsed;

    } catch (err) {
      lastError = err;
      log.warn(`Email generation attempt ${attempt}/3 failed for ${lead.name}: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  throw new Error(`Failed to generate email after 3 attempts: ${lastError.message}`);
}
