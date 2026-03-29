import { getLeads, updateLead, addHistoryEntry } from "./leads.js";
import { checkForReply, sendNotification } from "./gmail.js";
import { log } from "./logger.js";

export async function checkReplies() {
  const leads = getLeads();

  // Only check leads we've contacted but haven't heard back from
  const targets = leads.filter(l =>
    l.status === "contacted" && !l.repliedAt
  );

  if (!targets.length) {
    log.info("Reply check: no active leads to monitor.");
    return;
  }

  log.info(`Reply check: scanning ${targets.length} lead(s) for inbox replies...`);
  let repliesFound = 0;

  for (const lead of targets) {
    try {
      const reply = await checkForReply(lead.email);

      if (reply) {
        repliesFound++;
        log.reply(`Reply detected from ${lead.name} @ ${lead.company} | Subject: "${reply.subject}"`);

        // Update lead status
        updateLead(lead.id, {
          status: "replied",
          repliedAt: new Date().toISOString(),
        });
        addHistoryEntry(lead.id, {
          type: "reply_received",
          subject: reply.subject,
          messageId: reply.messageId,
        });

        // Send you an instant notification
        await sendNotification(
          `🔔 Reply from ${lead.name} — ${lead.company}`,
          buildNotificationBody(lead, reply)
        );
      }
    } catch (err) {
      log.error(`Reply check error for ${lead.email}: ${err.message}`);
    }

    // Small delay between Gmail API calls
    await new Promise(r => setTimeout(r, 500));
  }

  if (repliesFound === 0) {
    log.info(`Reply check complete — no new replies found.`);
  } else {
    log.success(`Reply check complete — ${repliesFound} new reply(s) detected!`);
  }
}

function buildNotificationBody(lead, reply) {
  const history = (lead.history || [])
    .filter(h => h.type !== "error")
    .map(h => `  • ${new Date(h.date).toLocaleDateString()} — ${h.type}: "${h.subject || ""}"`)
    .join("\n");

  return `Great news — ${lead.name} just replied to your outreach!

─────────────────────────────
LEAD DETAILS
─────────────────────────────
Name:     ${lead.name}
Title:    ${lead.role || "N/A"}
Company:  ${lead.company}
Email:    ${lead.email}
Type:     ${lead.type}
Notes:    ${lead.notes || "N/A"}

─────────────────────────────
THEIR REPLY
─────────────────────────────
Subject:  ${reply.subject}
Date:     ${reply.date}

Open Gmail to read and respond → https://mail.google.com

─────────────────────────────
OUTREACH HISTORY
─────────────────────────────
${history || "  (no history recorded)"}

— CoverReach Agent`;
}
