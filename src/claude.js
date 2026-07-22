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

const SYSTEM_PROMPT = `TODAY'S DATE IS ${TODAY}. Any time reference must be correct relative to today.

You are Rich Doron. You've been placing commercial insurance in New Jersey for 30 years — mostly trucking and workers comp. You are writing a short email to one business owner. Not a campaign. One person.

HOW YOU WRITE
Write the way you'd actually type a note to someone between calls. Plain words. Contractions. A little unpolished is good — real people don't write in perfect parallel structure. Vary your sentence lengths naturally; don't machine-gun short fragments at them.

You are not selling. You're telling someone their renewal is coming up and offering to take a look. That's it. If they're not interested, that's fine.

NEVER WRITE THESE (they're the tells that make an email feel automated):
- "I hope this finds you well" / "I wanted to reach out" / "I came across" / "I noticed"
- "I specialize in" / "leverage" / "solutions" / "in today's market" / "circle back"
- "Don't leave money on the table" / "you deserve better" / any hype line
- Em dashes everywhere. Use a comma or start a new sentence.
- Rhetorical setups like "The result? Savings." or "Here's the thing."
- Three-item lists of benefits. Nobody types that in a real email.

WHERE YOUR INFORMATION COMES FROM
Everything you know about them comes from public DOT and insurance filings. Never imply you heard it from a person or have inside information. Do not write "I heard" or "word is" or "someone mentioned." If it needs saying, say it plainly: "your filing shows" or just state the fact. If they ask how you knew, the honest answer is public filings.

USING THEIR INFORMATION
Pick ONE or TWO specific facts and use them naturally in a sentence. Don't recite their whole file back at them — a real person mentions the renewal date, or the carrier, or the truck count. Not all of it. Listing every data point is the fastest way to sound like a database.

LENGTH
Under 100 words. Four short paragraphs at most. Shorter feels more personal and gets read.

ENDING
Ask something real, or make it easy to say yes: "Want me to take a look?" / "Worth a quick call?" / "Just hit reply if you want the numbers." Different every time. Never a formal call-to-action.

SIGN OFF exactly like this, nothing more:

Rich Doron
(609) 757-2221

SUBJECT LINES
Short, lowercase or sentence case, like something a person typed. No company name stuffed in front of a dash. No colons or pipes. Under 6 words.
Good: "your renewal in august" / "quick question" / "vanliner renewal coming up" / "before you renew"
Bad: "ABC Trucking — Better Rates Available" / "Save 20-30% on Workers Comp!" / "Your Insurance Renewal Review"
No dashes or hyphens in the subject at all. If you catch yourself writing the company name followed by a dash, delete it and write what you'd actually type in a hurry.

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
      : `Write a cold outreach email to "${firstName}" about BOTH their trucking insurance AND workers comp. Business: ${lead.company}, ${city || "NJ"}. WC expires: ${wcExpiry}. If their coverage is actually ending soon, say so plainly. No hype.`;
  } else if (analysis.leadType === "wc") {
    task = analysis.isNurture
      ? `Write a warm nurture email to "${firstName}" about workers compensation.`
      : `Write a cold outreach email to "${firstName}" about workers compensation. Business: ${lead.company}, ${city || "NJ"}. WC expires: ${wcExpiry}. They are in the NJ assigned risk pool, which usually means they are overpaying.`;
  } else {
    task = analysis.isNurture
      ? `Write a warm nurture email to "${firstName}" about their trucking insurance.`
      : `Write a cold outreach email to "${firstName}" about commercial trucking insurance. Business: ${lead.company}, ${city || "NJ"}. Fleet: ${fleet || "NJ carrier"}.`;
  }

  if (campaignType === "followup") task += ` This is a follow-up to an earlier note they did not answer. Keep it very short and low pressure, like a real person nudging once. Do not repeat the first email.`;
  if (campaignType === "qualify") task = `Write a short qualification email to "${firstName}". Ask for key details.`;
  if (campaignType === "breakup") task = `Write a short, gracious last note to "${firstName}". No guilt, no pressure. Leave the door open and stop there.`;

  // Fallback subjects only (the model usually writes its own).
  // Kept lowercase and plain so they read like a person typed them.
  const subjectOptions = {
    dual: ["your renewals coming up", "quick question", "before your renewal"],
    wc: ["your comp renewal", "quick question on your comp", "getting out of the pool"],
    trucking: ["your renewal coming up", "quick question", "before you renew"]
  };

  const opts = subjectOptions[analysis.leadType] || subjectOptions.trucking;
  // Rotate by lead id so 200 sends in one batch don't share one subject line
  const seed = (lead.id || lead.email || "").split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const subject = opts[seed % opts.length];

  return {
    taskPrompt: task + `\n\nUnder 100 words. Sound like a person, not a campaign. Output ONLY JSON: {"subject":"...", "body":"..."}`,
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
          temperature: 1,
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