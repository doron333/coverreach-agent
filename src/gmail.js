import nodemailer from "nodemailer";
import { log } from "./logger.js";

function getTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.YOUR_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

// Send an email via Gmail
export async function sendEmail(to, subject, body) {
  const transporter = getTransporter();
  const fromName = process.env.SENDER_NAME || "Matt Doron";
  const fromEmail = process.env.YOUR_EMAIL;

  try {
    const result = await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      text: body,
    });
    return result;
  } catch (err) {
    log.error(`Gmail send failed to ${to}: ${err.message}`);
    throw err;
  }
}

// Check Gmail inbox for unread replies from a specific sender
export async function checkForReply(fromEmail) {
  // With App Password we use IMAP to check inbox
  // For simplicity, we'll use nodemailer + imap-simple
  // This is a lightweight check — returns null if no reply found
  try {
    const imapConfig = {
      imap: {
        user: process.env.YOUR_EMAIL,
        password: process.env.GMAIL_APP_PASSWORD,
        host: "imap.gmail.com",
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
      },
    };

    const imapSimple = await import("imap-simple");
    const connection = await imapSimple.connect(imapConfig);
    await connection.openBox("INBOX");

    const searchCriteria = ["UNSEEN", ["FROM", fromEmail]];
    const fetchOptions = { bodies: ["HEADER.FIELDS (FROM SUBJECT DATE)"], markSeen: true };
    const messages = await connection.search(searchCriteria, fetchOptions);
    await connection.end();

    if (!messages.length) return null;

    const header = messages[0].parts[0].body;
    return {
      subject: Array.isArray(header.subject) ? header.subject[0] : header.subject || "(no subject)",
      date: Array.isArray(header.date) ? header.date[0] : header.date || "",
      messageId: messages[0].attributes.uid,
    };
  } catch (err) {
    log.error(`Reply check failed for ${fromEmail}: ${err.message}`);
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