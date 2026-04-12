import { getLeads, markUnsubscribed, updateLead } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { sendSMS } from "./sms.js";
import { log } from "./logger.js";

const UNSUB_KEYWORDS = /^(stop|remove|unsubscribe|opt.?out|do not contact|take me off|please remove)/i;
const ALERT_PHONE = process.env.ALERT_PHONE || "+16096225037";

export async function checkReplies() {
  const leads = getLeads();
  const active = leads.filter(l => l.status === "contacted");

  if (!active.length) {
    log.info("Reply check: no active leads to monitor.");
    return;
  }

  log.info(`Reply check: monitoring ${active.length} contacted leads.`);
}

export async function handleInboundReply(fromEmail, subject, body) {
  const leads = getLeads();
  const lead = leads.find(l => l.email.toLowerCase() === fromEmail.toLowerCase());

  if (!lead) {
    log.warn(`Reply from unknown email: ${fromEmail}`);
    return;
  }

  // Check for unsubscribe request
  if (UNSUB_KEYWORDS.test(body.trim()) || UNSUB_KEYWORDS.test(subject.trim())) {
    markUnsubscribed(fromEmail);
    log.info(`Unsubscribed: ${fromEmail}`);

    await sendNotification(
      `🚫 Unsubscribe — ${lead.name || fromEmail}`,
      `${lead.name || fromEmail} from ${lead.company || "unknown"} requested removal.\n\nThey have been marked unsubscribed and will receive no more emails.\n\nMessage: "${body.trim().slice(0, 200)}"`
    );

    try {
      await sendSMS(ALERT_PHONE, `🚫 Unsubscribe: ${lead.name || fromEmail} (${lead.company || ""}) asked to be removed.`);
    } catch(e) { log.warn(`SMS failed: ${e.message}`); }

    return;
  }

  // Hot lead replied!
  updateLead(lead.id, { status: "replied", repliedAt: new Date().toISOString() });

  const smsMessage = `🔥 HOT LEAD REPLIED!

${lead.name || fromEmail}
${lead.company || ""}
${fromEmail}
${lead.notes ? lead.notes.split(".")[0] : ""}

Message: "${body.trim().slice(0, 120)}"

Reply: mail.google.com`;

  const emailBody = `${"=".repeat(50)}
🔥 HOT LEAD REPLIED!
${"=".repeat(50)}

Name:     ${lead.name || "Unknown"}
Company:  ${lead.company || "Unknown"}  
Email:    ${fromEmail}
Notes:    ${lead.notes || ""}

THEIR MESSAGE:
${body}

${"=".repeat(50)}
→ Reply at: https://mail.google.com
→ All automated emails to this contact STOPPED.
${"=".repeat(50)}
Richard Doron | (609) 757-2221`;

  // Send email notification
  await sendNotification(
    `🔥 HOT LEAD — ${lead.name || fromEmail} | ${lead.company || ""}`,
    emailBody
  );

  // Send SMS alert
  try {
    await sendSMS(ALERT_PHONE, smsMessage);
    log.success(`📱 SMS alert sent for hot lead: ${lead.name || fromEmail}`);
  } catch(e) {
    log.warn(`SMS alert failed: ${e.message}`);
  }

  log.success(`🔥 HOT LEAD: ${lead.name || fromEmail} @ ${lead.company} replied!`);
}
