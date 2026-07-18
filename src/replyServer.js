import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPipelineStats, getHotWindowBreakdown, getRecentActivity, getKeyInsights } from "./analytics.js";
import { getBrevoStats } from "./brevoStats.js";
import { getReplies, logReplyToCRM, logReplyLocally } from "./crm.js";
import { getLeads, saveLeads } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { persistLeadsToGitHub } from "./persist.js";
import { checkGmailReplies } from "./imapWatcher.js";
import { log } from "./logger.js";

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}


function extractReplyText(item) {
  const text = item.ExtractedMarkdownMessage || item.RawTextBody || item.RawHtmlBody || "";
  const cut = text.split(/On .* wrote:|-----Original Message-----|________________________________/)[0];
  return cut.trim().slice(0, 2000);
}

async function handleInboundReply(payload) {
  const items = payload.items || [payload];
  for (const item of items) {
    const fromEmail = (item.From?.Address || item.from || "").toLowerCase();
    if (!fromEmail) continue;
    const replyText = extractReplyText(item);
    const subject = item.Subject || item.subject || "(no subject)";
    const isStop = /^\s*(stop|remove|unsubscribe)\b/i.test(replyText);
    const leads = getLeads();
    const lead = leads.find((l) => (l.email || "").toLowerCase() === fromEmail);
    if (!lead) {
      await sendNotification(`\uD83D\uDCE8 Reply from unknown sender \u2014 ${fromEmail}`,
        `Subject: ${subject}\n\n${replyText}`).catch(() => {});
      continue;
    }
    if (isStop) {
      lead.status = "unsubscribed"; lead.campaignEligible = false; lead.currentCampaign = null;
      saveLeads(leads);
      await persistLeadsToGitHub(`Unsubscribe via reply: ${lead.company}`);
      continue;
    }
    lead.status = "replied"; lead.repliedAt = new Date().toISOString();
    if (!lead.history) lead.history = [];
    lead.history.push({ type: "reply_received", subject, ts: lead.repliedAt });
    saveLeads(leads);
    logReplyLocally(lead, replyText, subject);
    await logReplyToCRM(lead, replyText, subject);
    await sendNotification(`\uD83D\uDD25 HOT LEAD REPLIED \u2014 ${lead.company}`,
      `${lead.company} (${lead.email})\nRenewal: ${lead.renewalDate || "n/a"}\n\n"${replyText}"\n\n\u2192 Sequences stopped. Reply while they're warm!`).catch(() => {});
    await persistLeadsToGitHub(`Reply received: ${lead.company}`);
  }
}

async function handleBrevoEvent(payload) {
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
      lead.status = "bounced"; lead.campaignEligible = false; changed = true;
    }
    if (event === "unsubscribed" || event === "spam" || event === "complaint") {
      lead.status = "unsubscribed"; lead.campaignEligible = false; lead.currentCampaign = null; changed = true;
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
      if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        res.writeHead(302, { Location: "/dashboard" });
        res.end();
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        const stats = getPipelineStats();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "alive", time: new Date().toISOString(), ...stats }));
        return;
      }

      // Test Brevo connection
      if (req.method === "GET" && req.url === "/test-brevo") {
        const brevoStats = await getBrevoStats();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(brevoStats, null, 2));
        return;
      }

      // ==================== SOPHISTICATED DASHBOARD ====================
      if (req.method === "GET" && req.url === "/dashboard") {
        const stats = getPipelineStats();
        const hot = getHotWindowBreakdown();
        const recent = getRecentActivity(6);
        const insights = getKeyInsights(stats, hot);
        const brevo = await getBrevoStats();

        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CoverReach Dashboard</title>
<style>
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background:#0f172a; color:#e2e8f0; margin:0; padding:24px; }
  .container { max-width:1200px; margin:0 auto; }
  h1 { font-size:28px; margin:0 0 8px; }
  .subtitle { color:#64748b; margin-bottom:32px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; margin-bottom:32px; }
  .card { background:#1e2937; border:1px solid #334155; border-radius:12px; padding:20px; }
  .metric { font-size:32px; font-weight:700; margin:8px 0 4px; }
  .label { font-size:13px; color:#94a3b8; }
  .section { margin-bottom:40px; }
  .section h2 { font-size:18px; margin-bottom:16px; color:#cbd5e1; }
  .nav { display:flex; gap:12px; margin-bottom:24px; }
  .nav a { background:#1e40af; color:white; padding:8px 16px; border-radius:8px; text-decoration:none; font-size:14px; }
  .insight { background:#1e2937; border-left:4px solid #f59e0b; padding:12px 16px; margin-bottom:8px; border-radius:6px; }
  .activity-item { background:#1e2937; padding:12px 16px; border-radius:8px; margin-bottom:8px; font-size:14px; }
  .highlight { color:#f59e0b; }
  .brevo-card { border-left: 4px solid #3b82f6; }
</style>
</head>
<body>
<div class="container">
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <div><h1>CoverReach</h1><div class="subtitle">Sophisticated Dashboard + Brevo Analytics</div></div>
    <div class="nav"><a href="/replies">Replies</a><a href="/health">Health</a></div>
  </div>

  <!-- PIPELINE -->
  <div class="section">
    <h2>Pipeline Overview</h2>
    <div class="grid">
      <div class="card"><div class="label">In Hot Window</div><div class="metric highlight">${stats.inWindowNow}</div></div>
      <div class="card"><div class="label">Cancellations</div><div class="metric" style="color:#ef4444">${stats.cancellationsInWindow}</div></div>
      <div class="card"><div class="label">Total Pipeline</div><div class="metric">${stats.totalPipeline}</div></div>
      <div class="card"><div class="label">Replied</div><div class="metric" style="color:#22c55e">${stats.replied}</div></div>
    </div>
  </div>

  <!-- KEY INSIGHTS -->
  <div class="section">
    <h2>Key Insights</h2>
    ${insights.map(i => `<div class="insight">${i}</div>`).join('')}
  </div>

  <!-- BREVO EMAIL PERFORMANCE -->
  <div class="section">
    <h2>Email Performance (Brevo)</h2>
    ${brevo.connected ? `
      <div class="grid">
        <div class="card brevo-card"><div class="label">Emails Sent</div><div class="metric">${brevo.sent}</div></div>
        <div class="card brevo-card"><div class="label">Open Rate</div><div class="metric">${brevo.openRate}</div></div>
        <div class="card brevo-card"><div class="label">Click Rate</div><div class="metric">${brevo.clickRate}</div></div>
        <div class="card brevo-card"><div class="label">Bounces</div><div class="metric" style="color:#ef4444">${brevo.bounces}</div></div>
      </div>
    ` : `<div class="card"><p style="color:#94a3b8">Brevo stats not available: ${brevo.message}</p></div>`}
  </div>

  <!-- HOT WINDOW -->
  <div class="section">
    <h2>Hot Window Breakdown</h2>
    <div class="grid">
      <div class="card"><div class="label">Total in Window</div><div class="metric">${hot.total}</div></div>
      <div class="card"><div class="label">Cancellations</div><div class="metric">${hot.cancellations}</div></div>
      <div class="card"><div class="label">Dual Pitch</div><div class="metric">${hot.dualPitch}</div></div>
      <div class="card"><div class="label">Trucking</div><div class="metric">${hot.trucking}</div></div>
    </div>
  </div>

  <!-- RECENT ACTIVITY -->
  <div class="section">
    <h2>Recent Activity</h2>
    ${recent.length > 0 ? recent.map(r => `
      <div class="activity-item">
        <strong>${r.company}</strong> — ${r.activityType === 'replied' ? 'Replied' : 'Contacted'} 
        ${r.cancellation ? '<span style="color:#ef4444">(Cancellation)</span>' : ''}<br>
        <span style="color:#94a3b8;font-size:13px">${r.email} • ${new Date(r.lastActivity).toLocaleString()}</span>
      </div>`).join('') : '<p style="color:#64748b">No recent activity yet.</p>'}
  </div>

  <div style="color:#64748b;font-size:12px;margin-top:40px">
    Updated: ${new Date().toLocaleString()} • CoverReach v2.1 (with Brevo)
  </div>
</div>
</body>
</html>`;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && req.url === "/replies") {
        const replies = getReplies().slice().reverse();
        const cards = replies.length ? replies.map(r => `
          <div style="background:#1e2937;padding:16px 18px;margin-bottom:14px;border-radius:10px;${r.cancellation ? "border-left:4px solid #ef4444;" : ""}">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div>
                <strong style="font-size:16px;">${r.company || "Unknown"}</strong>${r.cancellation ? ' <span style="color:#ef4444;font-size:11px;font-weight:bold;">\u26A0\uFE0F CANCELLATION</span>' : ""}
                <div style="color:#94a3b8;font-size:12px;margin-top:2px;">${r.name ? r.name + " \u00b7 " : ""}Renewal: ${r.renewalDate || "n/a"}${r.phone ? " \u00b7 \uD83D\uDCDE " + r.phone : ""}</div>
              </div>
              <div style="color:#64748b;font-size:11px;">${(r.ts || "").slice(0,16).replace("T"," ")}</div>
            </div>
            <div style="margin:10px 0 6px;font-size:13px;">Replied from: <a href="mailto:${r.email}?subject=Re: ${encodeURIComponent(r.subject || "your insurance")}" style="color:#60a5fa;font-weight:bold;font-size:14px;text-decoration:none;">${r.email}</a></div>
            <div style="background:#0f172a;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.6;white-space:pre-wrap;">${(r.reply || "(no text captured)").replace(/</g,"&lt;")}</div>
          </div>`).join("") : '<p style="color:#94a3b8;">No replies yet \u2014 when a prospect responds, they appear here with their message and reply-to address.</p>';
        const html = `<!DOCTYPE html><html><head><title>Replies \u2022 CoverReach</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:24px;max-width:900px;margin:auto}</style></head><body><h1>\uD83D\uDD25 Customer Replies (${replies.length})</h1><p style="color:#64748b;font-size:13px;">Newest first \u00b7 Tap an email address to reply directly</p>${cards}<p><a href="/dashboard" style="color:#60a5fa">\u2190 Back to Dashboard</a></p></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && (req.url === "/demo"      if (req.method === "GET" && (req.url === "/demo" || req.url === "/demo/")) {
        try {
          const html = fs.readFileSync(path.join(__dirname2, "demo.html"), "utf8");
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);
        } catch { res.writeHead(404); res.end("demo not found"); }
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/check-replies")) {
        const u = new URL(req.url, "http://x");
        const days = Math.min(parseInt(u.searchParams.get("days") || "2"), 30);
        const result = await checkGmailReplies(days);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && req.url === "/test-persist") {
        const ok = await persistLeadsToGitHub("Persistence test from /test-persist");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ persisted: ok }));
        return;
      }

      if (req.method === "POST" && req.url === "/webhook/inbound") {
        const body = await readBody(req);
        res.writeHead(200); res.end("ok");
        handleInboundReply(JSON.parse(body)).catch((e) => log.error(`Inbound: ${e.message}`));
        return;
      }

      if (req.method === "POST" && req.url === "/webhook/brevo") {
        const body = await readBody(req);
        res.writeHead(200); res.end("ok");
        handleBrevoEvent(JSON.parse(body)).catch((e) => log.error(`Event: ${e.message}`));
        return;
      }

      res.writeHead(404); res.end("Not found");
    } catch (e) {
      res.writeHead(500); res.end("Error");
    }
  });

  server.listen(PORT, () => log.success(`Server running on port ${PORT}`));
}
