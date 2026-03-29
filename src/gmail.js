import { google } from "googleapis";
import { log } from "./logger.js";

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    "urn:ietf:wg:oauth:2.0:oob"
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oauth2Client;
}

// Build a RFC 2822 encoded email message
function buildRawMessage(to, subject, body, fromName, fromEmail) {
  const message = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
  ].join("\r\n");

  return Buffer.from(message).toString("base64url");
}

// Send an email via Gmail API
export async function sendEmail(to, subject, body) {
  const auth = getAuth();
  const gmail = google.gmail({ version: "v1", auth });

  const fromName  = process.env.SENDER_NAME  || "Insurance Solutions Specialist";
  const fromEmail = process.env.YOUR_EMAIL;

  const raw = buildRawMessage(to, subject, body, fromName, fromEmail);

  try {
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    return res.data;
  } catch (err) {
    log.error(`Gmail send failed to ${to}: ${err.message}`);
    throw err;
  }
}

// Search inbox for unread messages from a specific sender
export async function checkForReply(fromEmail) {
  const auth = getAuth();
  const gmail = google.gmail({ version: "v1", auth });

  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: `from:${fromEmail} is:unread in:inbox`,
      maxResults: 5,
    });

    const messages = res.data.messages || [];
    if (!messages.length) return null;

    // Get the first unread message details
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messages[0].id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = msg.data.payload.headers;
    const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
    const date    = headers.find(h => h.name === "Date")?.value || "";

    // Mark it as read so we don't alert twice
    await gmail.users.messages.modify({
      userId: "me",
      id: messages[0].id,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });

    return { subject, date, messageId: messages[0].id };
  } catch (err) {
    log.error(`Gmail reply check failed for ${fromEmail}: ${err.message}`);
    return null;
  }
}

// Send yourself a notification email
export async function sendNotification(subject, body) {
  try {
    await sendEmail(process.env.YOUR_EMAIL, subject, body);
  } catch (err) {
    log.error(`Failed to send notification: ${err.message}`);
  }
}
