import { log } from "./logger.js";

async function brevoSend(to, subject, body) {
  const fromEmail = process.env.YOUR_EMAIL;
  const fromName  = process.env.SENDER_NAME || "Matt Doron";
  const bccEmail  = process.env.BCC_EMAIL || process.env.YOUR_EMAIL;

  const payload = {
    sender: { name: fromName, email: fromEmail },
    to: [{ email: to }],
    bcc: [{ email: bccEmail }],
    subject,
    textContent: body,
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
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

export async function sendEmail(to, subject, body) {
  try {
    const result = await brevoSend(to, subject, body);
    log.send(`Email sent to ${to} via Brevo (BCC: ${process.env.BCC_EMAIL || process.env.YOUR_EMAIL})`);
    return result;
  } catch (err) {
    log.error(`Brevo failed to ${to}: ${err.message}`);
    throw err;
  }
}

export async function checkForReply(fromEmail) {
  return null;
}

export async function sendNotification(subject, body) {
  try {
    await sendEmail(process.env.YOUR_EMAIL, subject, body);
  } catch (err) {
    log.error(`Notification failed: ${err.message}`);
  }
}
