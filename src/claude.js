import fetch from "node-fetch";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are Richard Doron, a commercial insurance specialist with 30 years of experience in New Jersey. You help all types of businesses get better commercial insurance.

YOUR VOICE:
- Direct, confident, veteran industry pro — not a salesman
- Short punchy sentences. Real talk. No fluff.
- You know NJ commercial insurance inside out
- You help businesses get BETTER RATES and BETTER COVERAGE

THREE TYPES OF LEADS YOU WRITE FOR:

1. TRUCKING (DOT leads) — commercial auto, cargo, DOT compliance, fleet
2. WORKERS COMP (NJCRIB leads) — getting OUT of assigned risk pool, saving 20-30% on WC
3. DUAL PITCH (both) — businesses in BOTH trucking AND WC assigned risk. Lead with WC expiry urgency, mention trucking too.

RULES:
- Use their FIRST NAME or business name in greeting
- Reference their specific data — fleet size, carrier, expiry date, premium, location
- For DUAL PITCH leads: mention WC expiry date and trucking in same email
- NEVER say "I hope this email finds you well" or "I wanted to reach out"
- Under 140 words
- End with ONE easy CTA — "just reply with X"
- ALWAYS end with:
Richard Doron
Commercial Insurance Specialist | 30 Years Experience
📞 (609) 757-2221

Output ONLY valid JSON: {"subject":"...","body":"..."}`;

function getFirstName(fullName) {
  if (!fullName || fullName === "nan") return null;
  return fullName.trim().split(" ")[0];
}

function detectLeadType(lead) {
  const src = lead.source || "dot";
  if (src === "njcrib_dot") return "dual";
  if (src === "njcrib") return "wc";
  return "trucking";
}

function getDaysUntilRenewal(lead) {
  const dateStr = lead.wcExpDate || lead.expirationDate || "";
  if (!dateStr) return null;
  try {
    const parts = dateStr.split("/");
    if (parts.length < 2) return null;
    const year = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
    const d = new Date(year, parseInt(parts[0]) - 1, parseInt(parts[1]));
    return Math.round((d - new Date()) / (1000 * 60 * 60 * 24));
  } catch { return null; }
}

function buildPrompt(lead, campaignType) {
  const firstName = getFirstName(lead.name) || lead.company?.split(" ")[0] || "there";
  const leadType = detectLeadType(lead);
  const notes = lead.notes || "";
  const daysLeft = getDaysUntilRenewal(lead);
  const isUrgent = daysLeft !== null && daysLeft <= 45 && daysLeft >= 0;

  // Extract key data from notes
  const extractVal = (pattern) => {
    const m = notes.match(pattern);
    return m ? m[1].trim() : "";
  };

  const city = extractVal(/in ([^,\.]+),/);
  const carrier = extractVal(/Current carrier: ([^.]+)/);
  const fleet = extractVal(/(\d+) power units/);
  const wcPremium = lead.wcPremium || extractVal(/WC premium: \$([\d,]+)/);
  const wcExpiry = lead.wcExpDate || lead.expirationDate || "";

  const prompts = {
    dual: {
      cold: `Write a cold outreach email to "${firstName}" about BOTH their trucking insurance AND workers comp.
Business: ${lead.company}, ${city || "NJ"}
WC policy expires: ${wcExpiry} (${daysLeft !== null ? daysLeft + " days" : "soon"})
WC est. premium: ${wcPremium ? "$" + wcPremium : "in assigned risk pool"}
Trucking fleet: ${fleet ? fleet + " power units" : "NJ carrier"}
Current insurer: ${carrier || "current provider"}
Lead with WC expiry urgency. Mention trucking savings too. Under 140 words. CTA: "Reply with 'review' and I will look at both policies."`,

      followup: `Follow-up to "${firstName}" — no reply. New angle on WC + trucking dual savings. Under 110 words. ${isUrgent ? `WC expires in ${daysLeft} days — add urgency.` : ""}`,
      qualify: `Qualification email to "${firstName}" — ask: renewal dates for both WC and trucking, fleet size, what they haul. Under 120 words.`,
      breakup: `Final break-up to "${firstName}". Brief, leave door open. Under 80 words.`,
    },
    wc: {
      cold: `Write a cold outreach email to "${firstName}" about workers compensation insurance.
Business: ${lead.company}, ${city || lead.county || "NJ"}
WC policy expires: ${wcExpiry} (${daysLeft !== null ? daysLeft + " days" : "soon"})
Est. WC premium: ${wcPremium ? "$" + wcPremium : "unknown"}
Key message: They are in the NJ ASSIGNED RISK POOL — paying higher rates. You can get them into the voluntary market and save 20-30%.
${isUrgent ? "URGENT — expires very soon. Create urgency." : ""}
Under 140 words. CTA: "Reply with 'rates' and I will run a comparison before your renewal."`,

      followup: `Follow-up WC email to "${firstName}". ${isUrgent ? `URGENT — expires in ${daysLeft} days.` : "New angle on assigned risk pool savings."} Under 110 words.`,
      qualify: `WC qualification email to "${firstName}" — ask exact renewal date, number of employees, payroll amount. Under 120 words.`,
      breakup: `Final break-up to "${firstName}". Brief, door open. Under 80 words.`,
    },
    trucking: {
      cold: `Write a cold outreach email to "${firstName}" about commercial trucking insurance.
Business: ${lead.company}, ${city || "NJ"}
Fleet: ${fleet ? fleet + " power units" : "NJ carrier"}
Current carrier: ${carrier || "current insurer"}
Insurance renewal: ${lead.notes?.match(/Insurance effective: ([^.]+)/)?.[1] || "coming up"}
${isUrgent ? "URGENT — renewal approaching." : ""}
Under 140 words. End with low-friction CTA.`,

      followup: `Follow-up trucking email to "${firstName}". New angle. Under 110 words.`,
      qualify: `Trucking qualification email to "${firstName}" — ask fleet size, what they haul, renewal date. Under 120 words.`,
      breakup: `Final break-up to "${firstName}". Brief, door open. Under 80 words.`,
    },
  };

  const typePrompts = prompts[leadType] || prompts.trucking;
  const taskPrompt = typePrompts[campaignType] || typePrompts.cold;

  // Subject line variants by type
  const subjects = {
    dual: [
      `${lead.company} — WC expires ${wcExpiry} + trucking review`,
      `${firstName} — save on both WC and trucking insurance`,
      `Before your WC renews — quick question for ${lead.company}`,
      `WC + trucking review for ${lead.company}`,
    ],
    wc: [
      `${lead.company} — your WC policy expires ${wcExpiry}`,
      `Get out of assigned risk — save 20-30% on WC`,
      `${firstName} — better WC rates before your renewal`,
      `WC review for ${lead.company} — ${daysLeft || ""} days left`,
    ],
    trucking: [
      `Better rates for ${lead.company}?`,
      `${firstName} — are you overpaying for trucking coverage?`,
      `30 years helping NJ truckers cut insurance costs`,
      `${lead.company} — quick question about your coverage`,
      `${fleet ? fleet + "-unit fleet" : "Trucking"} insurance review`,
    ],
  };

  const subjectList = subjects[leadType] || subjects.trucking;
  const subject = subjectList[Math.floor(Math.random() * subjectList.length)];

  return { taskPrompt, subject };
}

export async function generateEmail(lead, campaignType = "cold") {
  const { taskPrompt, subject } = buildPrompt(lead, campaignType);

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
          messages: [{ role: "user", content: taskPrompt + "\n\nOutput ONLY JSON: {\"subject\":\"\",\"body\":\"...\"}" }],
        }),
      });

      if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!parsed.body) throw new Error("Missing body");
      return { subject: parsed.subject || subject, body: parsed.body };

    } catch (err) {
      lastError = err;
      log.warn(`Email generation attempt ${attempt}/3 failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`Failed after 3 attempts: ${lastError.message}`);
}
