import { log } from "./logger.js";
import { markUnsubscribed, markBounced } from "./leads.js";

async function brevoSend(to, subject, body) {
  const fromEmail = process.env.YOUR_EMAIL;
  const fromName  = process.env.SENDER_NAME || "Richard Doron";
  const bccEmail  = process.env.BCC_EMAIL || process.env.YOUR_EMAIL;

  const unsubLine = "\n\n---\nTo unsubscribe reply with STOP or REMOVE.";

  const payload = {
    sender: { name: fromName, email: fromEmail },
    to: [{ email: to }],
    bcc: [{ email: bccEmail }],
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
