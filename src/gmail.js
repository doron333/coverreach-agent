import { log } from "./logger.js";
import { markUnsubscribed, markBounced } from "./leads.js";
import { listUnsubHeaders, unsubscribeUrl } from "./unsubscribe.js";

async function brevoSend(to, subject, body) {
  // Prospect mail goes from the AUTHENTICATED domain (SPF + DKIM + DMARC all
  // aligned as of 8/7). Sending as @gmail.com through Brevo failed
  // authentication and landed in spam — that was the cause of ~0% opens and
  // zero replies across the first 1,100+ sends. Do not point this back at a
  // free mailbox. Internal notifications still go to YOUR_EMAIL.
  const fromEmail = process.env.OUTREACH_FROM_EMAIL || "rich@outreach.centraljerseyins.com";
  const fromName  = process.env.SENDER_NAME || "Rich Doron";

  // Replies must still reach Rich's inbox, which is where the IMAP watcher looks.
  const replyTo = process.env.GMAIL_USER || process.env.YOUR_EMAIL;

  // Gmail fingerprints message bodies. An identical opt-out line on every send
  // is the single strongest match anchor we control — roughly 1,150 messages
  // carrying this exact string were spam-filed before the domain was
  // authenticated, and that learned pattern followed the content to the new
  // domain. Rotating the wording breaks the fingerprint while keeping a clear,
  // CAN-SPAM compliant opt-out on every message.
  const UNSUB_VARIANTS = [
    "\n\nIf you'd rather not hear from me, just reply STOP.",
    "\n\nNot interested? Reply STOP and I won't follow up.",
    "\n\nReply STOP if you'd like me to take you off my list.",
    "\n\nIf this isn't useful, reply STOP and I'll leave you alone.",
    "\n\nDon't want these? Just reply STOP.",
    "\n\nReply STOP any time and I'll stop reaching out.",
  ];
  // Deterministic per recipient, so a given prospect always sees the same
  // wording across their sequence, but a batch is varied.
  const seed = String(to).split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const unsubLine = UNSUB_VARIANTS[seed % UNSUB_VARIANTS.length];

  // CAN-SPAM requires a valid physical postal address on commercial email.
  // It also helps deliverability — filters treat a real address as a
  // legitimacy signal, and we had none until now.
  // NOTE: centraljerseyins.com lists two different Medford addresses across
  // its own pages (205 Tuckerton Rd Suite 206 on /contact, 180 Tuckerton Rd
  // Unit 8 elsewhere). Confirm with Rich and correct POSTAL_ADDRESS if needed.
  const POSTAL_ADDRESS = process.env.POSTAL_ADDRESS ||
    "Central Jersey Insurance Associates, 205 Tuckerton Rd., Suite 206, Medford, NJ 08055";
  // Vary the presentation so the footer itself does not become a fingerprint.
  const ADDR_FORMATS = [
    `\n${POSTAL_ADDRESS}`,
    `\n\n${POSTAL_ADDRESS}`,
    `\n--\n${POSTAL_ADDRESS}`,
  ];
  const addrLine = ADDR_FORMATS[seed % ADDR_FORMATS.length];

  const payload = {
    sender: { name: fromName, email: fromEmail },
    replyTo: { email: replyTo, name: fromName },
    to: [{ email: to }],
    // BCC removed 7/18: was doubling Brevo credit burn (every prospect email
    // also sent a copy to Richard). Visibility now comes from the touch log,
    // /replies dashboard, daily summary, and hot-lead alerts instead.
    subject,
    textContent: body + unsubLine + addrLine,
    // Gmail and Yahoo have required one-click unsubscribe headers from bulk
    // senders since Feb 2024. Without them we are treated as not following
    // bulk-sender rules, which costs inbox placement. This also gives Gmail's
    // native Unsubscribe control, so an uninterested recipient taps that
    // instead of the spam button — a far cheaper outcome for us.
    headers: listUnsubHeaders(to),
  };

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    if (data.message && data.message.includes("blocked")) {
      markBounced(to);
      throw new Error(`Blocked/bounced: ${to}`);
    }
    throw new Error(data.message || JSON.stringify(data));
  }
  return data;
}

export async function sendEmail(to, subject, body) {
  try {
    const result = await brevoSend(to, subject, body);
    log.send(`✉  Sent → ${to} | "${subject}"`);
    return result;
  } catch (err) {
    log.error(`Brevo failed → ${to}: ${err.message}`);
    throw err;
  }
}

export async function checkForReply(fromEmail) {
  return null;
}

export async function sendNotification(subject, body) {
  try {
    const fromName = process.env.SENDER_NAME || "Richard Doron";
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "CoverReach Agent", email: process.env.YOUR_EMAIL },
        to: [{ email: process.env.YOUR_EMAIL }],
        subject,
        textContent: body,
      }),
    });
    const data = await res.json();
    if (!res.ok) log.error(`Notification failed: ${data.message}`);
  } catch (err) {
    log.error(`Notification error: ${err.message}`);
  }
}
