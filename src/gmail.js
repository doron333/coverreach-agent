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
    log.send(`Email sent to ${to}`);
    return result;
  } catch (err) {
    log.error(`Email send failed to ${to}: ${err.message}`);
    throw err;
  }
}

export async function checkForReply(fromEmail) {
  // Simple check using nodemailer SMTP verify — IMAP check happens via Gmail search
  // For now return null — reply detection via Gmail API will be added separately
  return null;
}

export async function sendNotification(subject, body) {
  try {
    await sendEmail(process.env.YOUR_EMAIL, subject, body);
  } catch (err) {
    log.error(`Notification failed: ${err.message}`);
  }
}
