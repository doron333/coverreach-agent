import { getLeads, markUnsubscribed, updateLead } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { log } from "./logger.js";

const UNSUB_KEYWORDS = /^(stop|remove|unsubscribe|opt.?out|do not contact|take me off|please remove)/i;

export async function checkReplies() {
  const leads = getLeads();
  const active = leads.filter(l => l.status === "contacted");

  if (!active.length) {
    log.info("Reply check: no active leads to monitor.");
    return;
  }

  // In a full implementation this would check Gmail API
  // For now we log that we checked
  log.info(`Reply check: monitoring ${active.length} contacted leads.`);
}

export async function handleInboundReply(fromEmail, subject, body) {
  // Called when a reply is detected
  const leads = getLeads();
  const lead = leads.find(l => l.email.toLowerCase() === fromEmail.toLowerCase());

  if (!lead) {
    log.warn(`Reply from unknown email: ${fromEmail}`);
    return;
  }

  // Check for unsubscribe
  if (UNSUB_KEYWORDS.test(body.trim()) || UNSUB_KEYWORDS.test(subject.trim())) {
    markUnsubscribed(fromEmail);
    log.info(`Unsubscribed: ${fromEmail}`);
    await sendNotification(
      `🚫 Unsubscribe Request — ${fromEmail}`,
      `${lead.name || fromEmail} from ${lead.company || "unknown"} has requested to be removed.\n\nThey have been marked as unsubscribed and will not receive any more emails.\n\nReply: "${body.trim().slice(0, 200)}"`
    );
    return;
  }

  // Hot lead — mark replied and notify
  updateLead(lead.id, { status: "replied", repliedAt: new Date().toISOString() });

  await sendNotification(
    `🔥 HOT LEAD REPLIED — ${lead.name || fromEmail} | ${lead.company || ""}`,
    `${"=".repeat(50)}
HOT LEAD REPLIED!
${"=".repeat(50)}

Name:     ${lead.name || "Unknown"}
Company:  ${lead.company || "Unknown"}
Email:    ${fromEmail}
Notes:    ${lead.notes || ""}

THEIR MESSAGE:
${body}

${"=".repeat(50)}
→ Reply at: https://mail.google.com
→ All automated emails to this contact have been STOPPED.
${"=".repeat(50)}
Richard Doron | (609) 757-2221`
  );

  log.success(`🔥 HOT LEAD: ${lead.name || fromEmail} replied!`);
}
