import { getLeads, markUnsubscribed, updateLead } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { sendSMS } from "./sms.js";
import { log } from "./logger.js";

const UNSUB_KEYWORDS = /^(stop|remove|unsubscribe|opt.?out|do not contact|take me off|please remove)/i;

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

  // Check for unsubscribe
  if (UNSUB_KEYWORDS.test(body.trim()) || UNSUB_KEYWORDS.test(subject.trim())) {
    markUnsubscribed(fromEmail);
    log.info(`Unsubscribed: ${fromEmail}`);

    await sendSMS(`CoverReach: ${lead.name || fromEmail} from ${lead.company || "unknown"} unsubscribed. Removed from list.`);

    await sendNotification(
      `🚫 Unsubscribe — ${fromEmail}`,
      `${lead.name || fromEmail} from ${lead.company || "unknown"} requested removal.\n\nMarked as unsubscribed. No more emails will be sent.`
    );
    return;
  }

  // Hot lead!
  updateLead(lead.id, { status: "replied", repliedAt: new Date().toISOString() });

  // Fire SMS immediately
  await sendSMS(
`🔥 HOT LEAD REPLIED!

${lead.name || fromEmail}
${lead.company || ""}
${lead.email}

"${body.trim().slice(0, 120)}${body.trim().length > 120 ? "..." : ""}"

Call or reply now!
(609) 757-2221`
  );

  // Fire email notification
  await sendNotification(
    `🔥 HOT LEAD REPLIED — ${lead.name || fromEmail} | ${lead.company || ""}`,
    `${"=".repeat(50)}
HOT LEAD REPLIED — ACTION REQUIRED
${"=".repeat(50)}

Name:     ${lead.name || "Unknown"}
Company:  ${lead.company || "Unknown"}
Email:    ${fromEmail}
Notes:    ${lead.notes || ""}

THEIR MESSAGE:
"${body}"

${"=".repeat(50)}
→ Reply at: https://mail.google.com
→ All automated emails STOPPED for this contact.
${"=".repeat(50)}
Richard Doron | (609) 757-2221`
  );

  log.success(`🔥 HOT LEAD: ${lead.name || fromEmail} replied! SMS + email sent.`);
}
