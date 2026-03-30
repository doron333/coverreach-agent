import nodemailer from "nodemailer";
import { log } from "./logger.js";

function getTransporter() {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
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
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject,
      text: body,
    });
    log.send(`Sent to ${to} — Message ID: ${result.messageId}`);
    return result;
  } catch (err) {
    log.error(`Gmail send failed to ${to}: ${err.message}`);
    throw err;
  }
}

export async function checkForReply(fromEmail) {
  return null;
}

export async function sendNotification(subject, body) {
  try {
    await sendEmail(process.env.YOUR_EMAIL, subject, body);
    log.success(`Notification sent to ${process.env.YOUR_EMAIL}`);
  } catch (err) {
    log.error(`Failed to send notification: ${err.message}`);
  }
}
