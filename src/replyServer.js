import http from "http";
import { getLeads, saveLeads } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { persistLeadsToGitHub } from "./persist.js";
import { log } from "./logger.js";
import { getReplies, logReplyToCRM, logReplyLocally } from "./crm.js";
import { checkGmailReplies } from "./imapWatcher.js";

/**
 * REPLY DETECTION — Brevo Inbound Webhook
 * ========================================
 * How it works:
 *   1. A dedicated inbound address (e.g. reply@<brevo-inbound-domain>) is set
 *      as the Reply-To on all outbound emails.
 *   2. When a prospect replies, Brevo's inbound parser POSTs the full email
 *      to this webhook: POST /webhook/inbound
 *   3. We match the sender to a lead, mark them REPLIED (stops all sequences),
 *      persist state, and fire an instant 🔥 HOT LEAD alert to Richard.
 *
 * Also exposes:
 *   GET /health         — Railway healthcheck + status JSON
 *   POST /webhook/brevo — Brevo transactional events (bounces, unsubs, opens)
 *
 * Setup (one-time, in Brevo dashboard):
 *   Inbound parsing → add route → point to https://<railway-url>/webhook/inbound
 */

const PORT = process.env.PORT || 8080;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function extractReplyText(item) {
  // Brevo inbound payload: prefer ExtractedMarkdownMessage, fall back to RawTextBody
  const text = item.ExtractedMarkdownMessage || item.RawTextBody || item.RawHtmlBody || "";
  // First 500 chars, strip quoted history
  const cut = text.split(/On .* wrote:|-----Original Message-----|________________________________/)[0];
  return cut.trim().slice(0, 500);
}

async function handleInboundReply(payload) {
  const items = payload.items || [payload];

  for (const item of items) {
    const fromEmail = (item.From?.Address || item.from || "").toLowerCase();
    if (!fromEmail) continue;

    const replyText = extractReplyText(item);
    const subject = item.Subject || item.subject || "(no subject)";

    // STOP/unsubscribe handling
    const isStop = /^\s*(stop|remove|unsubscribe)\b/i.test(replyText);

    const leads = getLeads();
    const lead = leads.find((l) => (l.email || "").toLowerCase() === fromEmail);

    if (!lead) {
      log.warn(`Inbound reply from unknown sender: ${fromEmail}`);
      // Still forward it to Richard so nothing is lost
      await sendNotification(
        `📨 Reply from unknown sender — ${fromEmail}`,
        `Subject: ${subject}\n\n${replyText}\n\n(Not matched to any lead in the database.)`
      ).catch(() => {});
      continue;
    }

    if (isStop) {
      lead.status = "unsubscribed";
      lead.campaignEligible = false;
      lead.currentCampaign = null;
      saveLeads(leads);
      log.warn(`🛑 UNSUBSCRIBE via reply: ${lead.company} (${fromEmail})`);
      await persistLeadsToGitHub(`Unsubscribe via reply: ${lead.company}`);
      continue;
    }

    // Mark replied — this stops all future sequence emails for this lead
    lead.status = "replied";
    lead.repliedAt = new Date().toISOString();
    if (!lead.history) lead.history = [];
    lead.history.push({ type: "reply_received", subject, ts: lead.repliedAt });
    saveLeads(leads);

    log.success(`🔥 HOT LEAD REPLIED: ${lead.company} (${fromEmail})`);
    logReplyLocally(lead, replyText, subject);
    await logReplyToCRM(lead, replyText, subject);

    // Instant alert to Richard with full context
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

    await persistLeadsToGitHub(`Reply received: ${lead.company} marked replied`);
  }
}

async function handleBrevoEvent(payload) {
  // Transactional webhook events: hard_bounce, unsubscribed, spam, etc.
  const events = Array.isArray(payload) ? payload : [payload];
  const leads = getLeads();
  let changed = false;

  for (const ev of events) {
    const email = (ev.email || "").toLowerCase();
    const event = ev.event || "";
    if (!email) continue;

    const lead = leads.find((l) => (l.email || "").toLowerCase() === email);
    if (!lead) continue;

    if (event === "hard_bounce" || event === "invalid_email" || event === "blocked") {
      lead.status = "bounced";
      lead.campaignEligible = false;
      changed = true;
      log.warn(`❌ Bounced (permanent): ${lead.company} (${email})`);
    }
    if (event === "unsubscribed" || event === "spam") {
      lead.status = "unsubscribed";
      lead.campaignEligible = false;
      lead.currentCampaign = null;
      changed = true;
      log.warn(`🛑 Unsubscribed via ${event}: ${lead.company} (${email})`);
    }
  }

  if (changed) {
    saveLeads(leads);
    await persistLeadsToGitHub("Webhook: bounce/unsubscribe updates");
  }
}

export function startReplyServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        const leads = getLeads();
        const inWin = (l) => {
          if (!l.renewalDate) return false;
          const [m, d, y] = l.renewalDate.split("/").map(Number);
          const days = Math.floor((new Date(y, m - 1, d) - Date.now()) / 86400000);
          return l.cancellation ? (days >= 0 && days <= 75) : (days >= 30 && days <= 60);
        };
        const stats = {
          status: "alive",
          time: new Date().toISOString(),
          githubTokenSet: !!process.env.GITHUB_TOKEN,
          gmailSet: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
          coldCron: process.env.COLD_CRON || "0 19 * * * (default)",
          followupCron: process.env.FOLLOWUP_CRON || "30 19 * * * (default)",
          dailyLimit: process.env.DAILY_LIMIT || "100 (default)",
          inWindowNow: leads.filter((l) => l.status === "new" && l.email && inWin(l)).length,
          totalPipeline: leads.filter((l) => l.status === "new" && l.email).length,
          contacted: leads.filter((l) => l.status === "contacted").length,
          replied: leads.filter((l) => l.status === "replied").length,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stats));
        return;
      }

      if (req.method === "GET" && req.url === "/replies") {
        const replies = getReplies().slice().reverse();
        const cards = replies.map(r => `
          <div class="card${r.cancellation ? " urgent" : ""}">
            <div class="top">
              <div>
                <div class="co">${r.company || "Unknown Company"}${r.cancellation ? " <span class=\"flag\">⚠️ CANCELLATION</span>" : ""}</div>
                <div class="who">${r.name ? r.name + " · " : ""}Renewal: ${r.renewalDate || "n/a"}${r.phone ? " · 📞 " + r.phone : ""}</div>
              </div>
              <div class="when">${(r.ts || "").slice(0, 16).replace("T", " ")}</div>
            </div>
            <div class="from">
              Replied from: <a class="mail" href="mailto:${r.email}?subject=Re: ${encodeURIComponent(r.subject || "your insurance")}">${r.email}</a>
            </div>
            <div class="msg">${(r.reply || "(no text captured)").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>
          </div>`).join("");
        const html = `<!DOCTYPE html><html><head><title>CoverReach — Replies</title>
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <style>
            body{font-family:Arial,sans-serif;margin:16px;color:#1f2328;background:#f6f8fa}
            h1{font-size:20px;margin-bottom:4px} .count{color:#c8472a}
            .sub{color:#656d76;font-size:12px;margin-bottom:16px}
            .card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:14px 16px;margin-bottom:12px}
            .card.urgent{border-left:4px solid #c8472a}
            .top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
            .co{font-weight:bold;font-size:15px}
            .flag{color:#c8472a;font-size:11px;font-weight:bold}
            .who{color:#656d76;font-size:12px;margin-top:2px}
            .when{color:#8b949e;font-size:11px;white-space:nowrap}
            .from{margin:10px 0 6px;font-size:13px}
            .mail{color:#0969da;font-weight:bold;text-decoration:none;font-size:14px}
            .msg{background:#f6f8fa;border-radius:6px;padding:10px 12px;font-size:13px;line-height:1.6;white-space:pre-wrap}
            .empty{color:#656d76;text-align:center;padding:40px}
          </style></head><body>
          <h1>🔥 CoverReach — Customer Replies <span class="count">(${replies.length})</span></h1>
          <div class="sub">Newest first · Tap an email address to reply directly</div>
          ${cards || '<div class="empty">No replies yet — when a prospect responds, they appear here with their message and reply-to address.</div>'}
          </body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && req.url === "/test-persist") {
        // Attempt a real GitHub persistence and report the outcome
        const result = await persistLeadsToGitHub("Persistence test from /test-persist");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && req.url === "/check-replies") {
        // Manual trigger for the Gmail reply check (also verifies IMAP credentials)
        const result = await checkGmailReplies();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && req.url === "/webhook/inbound") {
        const body = await readBody(req);
        res.writeHead(200);
        res.end("ok");
        // Process async after responding (Brevo wants fast 200s)
        handleInboundReply(JSON.parse(body)).catch((e) =>
          log.error(`Inbound handler error: ${e.message}`)
        );
        return;
      }

      if (req.method === "POST" && req.url === "/webhook/brevo") {
        const body = await readBody(req);
        res.writeHead(200);
        res.end("ok");
        handleBrevoEvent(JSON.parse(body)).catch((e) =>
          log.error(`Event handler error: ${e.message}`)
        );
        return;
      }

      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      log.error(`Server error: ${err.message}`);
      try { res.writeHead(500); res.end("error"); } catch {}
    }
  });

  server.listen(PORT, () => {
    log.success(`Reply webhook server listening on :${PORT}`);
    log.info(`  GET  /health          — status`);
    log.info(`  POST /webhook/inbound — prospect replies (Brevo inbound parse)`);
    log.info(`  POST /webhook/brevo   — bounces/unsubscribes (Brevo events)`);
  });

  return server;
}
