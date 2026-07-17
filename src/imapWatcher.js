import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getLeads, saveLeads } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { persistLeadsToGitHub } from "./persist.js";
import { log } from "./logger.js";

/**
 * GMAIL REPLY WATCHER (IMAP polling — free, no Brevo Pro needed)
 * ===============================================================
 * Every REPLY_CHECK_CRON tick (default: every 30 min), this:
 *   1. Connects to Gmail via IMAP (imap.gmail.com)
 *   2. Scans UNSEEN messages in the inbox
 *   3. Matches senders against the lead database
 *   4. On a match: marks lead REPLIED → all sequences stop for them,
 *      fires an instant 🔥 HOT LEAD alert, persists state to GitHub
 *   5. Handles STOP/REMOVE replies as permanent unsubscribes
 *
 * Required env vars (Railway):
 *   GMAIL_USER          = theinsurancemanwhocan@gmail.com
 *   GMAIL_APP_PASSWORD  = 16-char app password from Google Account settings
 *
 * Setup: myaccount.google.com/apppasswords (requires 2-Step Verification on)
 */

function getConfig() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  };
}

function cleanReplyText(text) {
  if (!text) return "";
  const cut = text.split(/On .* wrote:|-----Original Message-----|________________________________|From: /)[0];
  return cut.trim().slice(0, 500);
}

export async function checkGmailReplies() {
  const config = getConfig();
  if (!config) {
    log.warn("Gmail watcher: GMAIL_USER / GMAIL_APP_PASSWORD not set — reply detection inactive");
    return { checked: 0, matched: 0 };
  }

  const client = new ImapFlow(config);
  let checked = 0, matched = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Unseen messages only — we mark matched ones as seen after processing
      const unseen = await client.search({ seen: false });
      if (!unseen || !unseen.length) {
        log.info("Gmail watcher: no new messages");
        return { checked: 0, matched: 0 };
      }

      const leads = getLeads();
      const leadsByEmail = {};
      for (const l of leads) {
        if (l.email) leadsByEmail[l.email.toLowerCase()] = l;
      }

      let stateChanged = false;

      for (const uid of unseen) {
        checked++;
        const msg = await client.fetchOne(uid, { source: true });
        if (!msg?.source) continue;

        const parsed = await simpleParser(msg.source);
        const fromEmail = (parsed.from?.value?.[0]?.address || "").toLowerCase();
        if (!fromEmail) continue;

        // Skip our own BCC copies and internal mail
        if (fromEmail === config.auth.user.toLowerCase()) continue;
        if (fromEmail.includes("brevo") || fromEmail.includes("mailin")) continue;

        const lead = leadsByEmail[fromEmail];
        if (!lead) continue; // not a lead — leave unread for Richard

        const replyText = cleanReplyText(parsed.text || "");
        const subject = parsed.subject || "(no subject)";
        const isStop = /^\s*(stop|remove|unsubscribe)\b/i.test(replyText);

        if (isStop) {
          lead.status = "unsubscribed";
          lead.campaignEligible = false;
          lead.currentCampaign = null;
          stateChanged = true;
          log.warn(`🛑 UNSUBSCRIBE via reply: ${lead.company} (${fromEmail})`);
          await client.messageFlagsAdd(uid, ["\\Seen"]);
          continue;
        }

        if (lead.status === "replied") {
          // Already known — nothing to do
          await client.messageFlagsAdd(uid, ["\\Seen"]);
          continue;
        }

        // 🔥 New reply!
        lead.status = "replied";
        lead.repliedAt = new Date().toISOString();
        if (!lead.history) lead.history = [];
        lead.history.push({ type: "reply_received", subject, ts: lead.repliedAt });
        stateChanged = true;
        matched++;

        log.success(`🔥 HOT LEAD REPLIED: ${lead.company} (${fromEmail})`);

        await sendNotification(
          `🔥 HOT LEAD REPLIED — ${lead.name || lead.company} | ${lead.company}`,
          `HOT LEAD REPLIED — ACTION REQUIRED
${"=".repeat(44)}

Company:  ${lead.company}
Contact:  ${lead.name || "Unknown"}
Email:    ${lead.email}
Renewal:  ${lead.renewalDate || "see notes"}
${lead.cancellation ? `⚠️ CANCELLATION: ${lead.cancellation} — they NEED a carrier\n` : ""}
THEIR MESSAGE:
"${replyText}"

${"=".repeat(44)}
→ All automated emails to this lead are STOPPED
→ Reply from your inbox while they're warm!`
        ).catch((e) => log.error(`Alert failed: ${e.message}`));

        await client.messageFlagsAdd(uid, ["\\Seen"]);
      }

      if (stateChanged) {
        // Lead objects were mutated in place — save the array directly
        saveLeads(leads);
        await persistLeadsToGitHub(`Reply watcher: ${matched} replies detected`);
      }

      log.info(`Gmail watcher: checked ${checked} new messages, ${matched} lead replies`);
      return { checked, matched };
    } finally {
      lock.release();
    }
  } catch (err) {
    log.error(`Gmail watcher error: ${err.message}`);
    return { checked, matched, error: err.message };
  } finally {
    try { await client.logout(); } catch {}
  }
}
