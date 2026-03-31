import { log } from "./logger.js";

async function resendEmail(to, subject, text, from_addr) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: from_addr,
      to,
      subject,
      text,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Resend API error");
  return data;
}

export async function sendEmail(to, subject, body) {
  const fromName = process.env.SENDER_NAME || "Matt Doron";
  const from = `${fromName} <onboarding@resend.dev>`;
  try {
    const result = await resendEmail(to, subject, body, from);
    log.send(`Email sent to ${to} via Resend`);
    return result;
  } catch (err) {
    log.error(`Resend failed to ${to}: ${err.message}`);
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
