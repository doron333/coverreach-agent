import { log } from "./logger.js";
import { markUnsubscribed, markBounced } from "./leads.js";

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

  const unsubLine = "\n\n---\nTo unsubscribe reply with STOP or REMOVE.";

  const payload = {
    sender: { name: fromName, email: fromEmail },
    replyTo: { email: replyTo, name: fromName },
    to: [{ email: to }],
    // BCC removed 7/18: was doubling Brevo credit burn (every prospect email
    // also sent a copy to Richard). Visibility now comes from the touch log,
    // /replies dashboard, daily summary, and hot-lead alerts instead.
    subject,
    textContent: body + unsubLine,
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
