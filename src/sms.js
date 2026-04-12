import fetch from "node-fetch";
import { log } from "./logger.js";

export async function sendSMS(message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;
  const to         = process.env.ALERT_PHONE;

  if (!accountSid || !authToken || !from || !to) {
    log.warn("Twilio not configured — skipping SMS");
    return;
  }

  const body = new URLSearchParams({ From: from, To: to, Body: message });
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const data = await res.json();
    if (data.sid) {
      log.success(`📱 SMS sent to ${to} — SID: ${data.sid}`);
    } else {
      log.error(`SMS failed: ${JSON.stringify(data)}`);
    }
    return data;
  } catch (err) {
    log.error(`SMS error: ${err.message}`);
  }
}
