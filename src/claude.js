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

NEVER INVENT A FACT
This is the most important rule. You only know what is in the lead's record: their company, city, fleet size, current carrier, renewal month, and cancellation if there is one. That is all. You must never state anything else as fact.

Specifically, you have NO knowledge of and must NEVER claim:
- a DOT compliance issue, violation, audit, or inspection finding
- that their rates went up, went down, or are about to change
- that a competitor undercut them or that a new carrier entered their market
- a coverage gap, a deficiency, or anything you "caught", "spotted", "noticed", or "found" in their file
- what they currently pay, or how much they could save as a specific number or percentage
- any deadline, program, or filing requirement

Insurance is a licensed business. Inventing a compliance problem to create urgency is a misrepresentation that can draw a regulatory complaint and destroy trust with the exact person you want as a client. If you feel the email needs more urgency, use the real renewal or cancellation date. That is enough. If there is no urgency, write a calm note instead.

You may offer opinions clearly framed as opinions ("it might be worth comparing", "carriers have been competitive on fleets your size"). You may not present a guess as a finding.

WHERE YOUR INFORMATION COMES FROM
Everything you know about them comes from public DOT and insurance filings. Never imply you heard it from a person or have inside information. Do not write "I heard" or "word is" or "someone mentioned." If it needs saying, say it plainly: "your filing shows" or just state the fact. If they ask how you knew, the honest answer is public filings.

DATES
Refer to the MONTH only. Never name a specific day, and never write a date like 8/22 or "August 22nd." Write "your renewal in August" or "before your August renewal." The day in these filings is often off by a week, and naming the wrong date makes you look like you are guessing. The month is reliable, so use it and nothing more precise.

USING THEIR INFORMATION
Pick ONE or TWO specific facts and use them naturally in a sentence. Don't recite their whole file back at them — a real person mentions the renewal date, or the carrier, or the truck count. Not all of it. Listing every data point is the fastest way to sound like a database.

VARY YOUR OPENINGS
Do not start every email the same way. Rotate naturally between: leading with their renewal, leading with their carrier, asking a direct question, or just saying what you do and why you're writing. Some emails should mention your experience, many should not — a real person doesn't recite their resume every time. Never open two emails in a batch with the same construction.

LENGTH
Under 100 words. Four short paragraphs at most. Shorter feels more personal and gets read.

ENDING
Ask something real, or make it easy to say yes: "Want me to take a look?" / "Worth a quick call?" / "Just hit reply if you want the numbers." Different every time. Never a formal call-to-action.

SIGN OFF
End with your name and phone number, nothing more. Vary how you sign — sometimes "Rich Doron", sometimes just "Rich", occasionally "- Rich". Always include (609) 757-2221 on its own line. Never add a title, company line, or tagline.

SUBJECT LINES
Short, lowercase or sentence case, like something a person typed. No company name stuffed in front of a dash. No colons or pipes. Under 6 words.
Every subject in a batch must be DIFFERENT. Do not default to "your <month> renewal" — that phrasing is overused and makes a batch look machine-generated. Pull from the specifics you were given: their carrier name, their fleet size, their city, or ask a plain question.

Good, and note how varied these are:
  "vanliner renewal coming up"
  "quick question"
  "before you renew"
  "4 trucks in paterson"
  "worth a look?"
  "your progressive policy"
  "coverage question"
  "renewal timing"
Never put a specific date in the subject. Never repeat the same construction twice.
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

  // We reference the MONTH only, never an exact day. The day in DOT/insurance
  // filings is often stale or off by a week, and naming a wrong date is the
  // fastest way to lose credibility with an owner who knows their own policy.
  const monthName = (d) => {
    if (!d) return "";
    const s = String(d).trim();
    let dt = null;
    const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (mdy) dt = new Date(Number(mdy[3]), Number(mdy[1]) - 1, 1);
    else if (!isNaN(Date.parse(s))) dt = new Date(Date.parse(s));
    if (!dt || isNaN(dt)) return "";
    return dt.toLocaleDateString("en-US", { month: "long" });
  };

  const renewalMonth = monthName(lead.renewalDate);
  const wcExpiryMonth = monthName(lead.wcExpDate || lead.expirationDate);
  const cancelMonth = monthName(lead.cancellation);

  const carrierLine = carrier ? ` Current carrier: ${carrier}.` : "";
  // If they are being cancelled, that is the ONLY date that matters. Mentioning
  // the renewal month too makes the model merge them and state a wrong date.
  // A cancellation that already happened must never be written as upcoming.
  // Telling an owner "your carrier is cancelling you in July" on August 7 makes
  // us look like we're reading stale filings — which we would be. A past
  // cancellation is still a strong opening, just a different one.
  const cancelDateObj = (() => {
    if (!lead.cancellation) return null;
    const m = String(lead.cancellation).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    const t = Date.parse(lead.cancellation);
    return isNaN(t) ? null : new Date(t);
  })();
  const cancelAgeDays = cancelDateObj
    ? Math.floor((Date.now() - cancelDateObj.getTime()) / 86400000)
    : null;
  const cancelIsPast = cancelAgeDays !== null && cancelAgeDays > 0;

  // A cancellation from two or three months ago is no longer news. That
  // operator has already found coverage or gone out of business, and opening
  // with it makes us look like we are reading months-old filings. Past the
  // cutoff we ignore the cancellation entirely and treat them as an ordinary
  // renewal prospect, which is what they now are.
  const CANCEL_STALE_DAYS = parseInt(process.env.CANCEL_STALE_DAYS || "60");
  const cancelIsStale = cancelAgeDays !== null && cancelAgeDays > CANCEL_STALE_DAYS;

  const useCancel = cancelMonth && !cancelIsStale;
  const renewalLine = (!useCancel && renewalMonth) ? ` Their policy renews in ${renewalMonth}.` : "";

  const cancelLine = !useCancel
    ? ""
    : cancelIsPast
      ? ` CRITICAL TENSE RULE: ${carrier || "their carrier"} ALREADY CANCELLED their coverage back in ${cancelMonth}. That month is IN THE PAST — today is ${TODAY}. Write entirely in PAST TENSE. Never say the cancellation is upcoming, never say "before ${cancelMonth} hits", never use "is cancelling" or "will cancel". Open by acknowledging it already happened and ask whether they got it straightened out, then offer help for operations that have had a carrier drop them.`
      : ` IMPORTANT: their carrier is cancelling them in ${cancelMonth} — they will need new coverage regardless of price. Say this plainly and offer to help.`;

  let task = "";

  if (analysis.leadType === "dual") {
    task = analysis.isNurture
      ? `Write a warm, low-pressure nurture email to "${firstName}" at ${lead.company} about both their trucking and workers comp.${renewalLine}`
      : `Write a cold outreach email to "${firstName}" about BOTH their trucking insurance AND workers comp. Business: ${lead.company}, ${city || "NJ"}.${carrierLine}${renewalLine}${wcExpiryMonth ? ` Their workers comp expires in ${wcExpiryMonth}.` : ""}${cancelLine}`;
  } else if (analysis.leadType === "wc") {
    task = analysis.isNurture
      ? `Write a warm nurture email to "${firstName}" at ${lead.company} about workers compensation.${wcExpiryMonth ? ` Their coverage expires in ${wcExpiryMonth}.` : ""}`
      : `Write a cold outreach email to "${firstName}" about workers compensation. Business: ${lead.company}, ${city || "NJ"}.${wcExpiryMonth ? ` Their coverage expires in ${wcExpiryMonth}.` : ""} They are in the NJ assigned risk pool, which usually means they are overpaying.${cancelLine}`;
  } else {
    task = analysis.isNurture
      ? `Write a warm nurture email to "${firstName}" at ${lead.company} about their trucking insurance.${renewalLine}`
      : `Write a cold outreach email to "${firstName}" about commercial trucking insurance. Business: ${lead.company}, ${city || "NJ"}.${fleet ? ` Fleet: ${fleet} power units.` : ""}${carrierLine}${renewalLine}${cancelLine}`;
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

      // Enforce the sign-off. The model occasionally drops it, and an email
      // with no name or phone number is worse than no email at all.
      let body = (parsed.body || "").trimEnd();
      if (!body.includes("(609) 757-2221")) {
        // Only used when the model forgot entirely. Vary it so the fallback
        // does not reintroduce a single fixed fingerprint.
        const SIGNOFFS = ["Rich Doron", "Rich", "- Rich"];
        const s = String(lead.id || lead.email || "").split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
        body = body.replace(/\n*(Rich(ard)? Doron.*)$/i, "").trimEnd();
        body += `\n\n${SIGNOFFS[s % SIGNOFFS.length]}\n(609) 757-2221`;
      }

      // Strip any stray date-with-day the model slipped in (e.g. "August 22nd", "8/22")
      body = body
        .replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(st|nd|rd|th)?\b/gi, "$1")
        .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "");

      const cleanSubject = (parsed.subject || subject)
        .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "")
        .trim();

      return { subject: cleanSubject || subject, body };
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}