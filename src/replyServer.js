import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getLeads, saveLeads } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { persistLeadsToGitHub } from "./persist.js";
import { log } from "./logger.js";
import { getReplies, logReplyToCRM, logReplyLocally } from "./crm.js";
import { checkGmailReplies } from "./imapWatcher.js";
import { getPipelineStats, getHotWindowBreakdown } from "./analytics.js";

const PORT = process.env.PORT || 8080;
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));

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
  return cut.trim().slice(0, 500);
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
      log.warn(`Inbound reply from unknown sender: ${fromEmail}`);
      await sendNotification(`📨 Reply from unknown sender — ${fromEmail}`, `Subject: ${subject}\n\n${replyText}`).catch(() => {});
      continue;
    }
    if (isStop) {
      lead.status = "unsubscribed";
      lead.campaignEligible = false;
      saveLeads(leads);
      await persistLeadsToGitHub(`Unsubscribe: ${lead.company}`);
      continue;
    }
    lead.status = "replied";
    lead.repliedAt = new Date().toISOString();
    if (!lead.history) lead.history = [];
    lead.history.push({ type: "reply_received", subject, ts: lead.repliedAt });
    saveLeads(leads);
    log.success(`🔥 HOT LEAD REPLIED: ${lead.company}`);
    await sendNotification(`🔥 HOT LEAD REPLIED — ${lead.company}`, `Company: ${lead.company}\nEmail: ${lead.email}\nMessage: ${replyText}`).catch(() => {});
    await persistLeadsToGitHub(`Reply: ${lead.company}`);
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
    if (["hard_bounce", "invalid_email", "blocked"].includes(event)) {
      lead.status = "bounced";
      changed = true;
    }
    if (["unsubscribed", "spam"].includes(event)) {
      lead.status = "unsubscribed";
      changed = true;
    }
  }
  if (changed) {
    saveLeads(leads);
    await persistLeadsToGitHub("Bounce/Unsub update");
  }
}

export function startReplyServer() {
  const server = http.createServer(async (req, res) => {
    try {
      // Redirect root to dashboard
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

      // ==================== POLISHED DASHBOARD ====================
      if (req.method === "GET" && req.url === "/dashboard") {
        const stats = getPipelineStats();
        const hot = getHotWindowBreakdown();

        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CoverReach • Dashboard</title>
<style>
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; line-height: 1.5; }
  .container { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  .subtitle { color: #64748b; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; margin-bottom: 40px; }
  .card { background: #1e2937; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
  .metric { font-size: 34px; font-weight: 700; margin: 8px 0 4px; }
  .label { font-size: 13px; color: #94a3b8; }
  .section { margin-bottom: 40px; }
  .section h2 { font-size: 18px; margin-bottom: 16px; color: #cbd5e1; }
  .nav { display: flex; gap: 12px; margin-bottom: 24px; }
  .nav a { background: #1e40af; color: white; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 14px; }
  .highlight { color: #f59e0b; }
</style>
</head>
<body>
<div class="container">
  <div style="display:flex; justify-content:space-between; align-items:flex-start;">
    <div>
      <h1>CoverReach</h1>
      <div class="subtitle">Automated Renewal Outreach Dashboard</div>
    </div>
    <div class="nav">
      <a href="/replies">View Replies</a>
      <a href="/health">Health Check</a>
    </div>
  </div>

  <div class="section">
    <h2>Pipeline Overview</h2>
    <div class="grid">
      <div class="card">
        <div class="label">In Hot Window (30-60 days)</div>
        <div class="metric highlight">${stats.inWindowNow}</div>
      </div>
      <div class="card">
        <div class="label">Cancellations (Priority)</div>
        <div class="metric" style="color:#ef4444">${stats.cancellationsInWindow}</div>
      </div>
      <div class="card">
        <div class="label">Total Active Pipeline</div>
        <div class="metric">${stats.totalPipeline}</div>
      </div>
      <div class="card">
        <div class="label">Replied</div>
        <div class="metric" style="color:#22c55e">${stats.replied}</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Hot Window Breakdown</h2>
    <div class="grid">
      <div class="card">
        <div class="label">Total in Window</div>
        <div class="metric">${hot.total}</div>
      </div>
      <div class="card">
        <div class="label">Cancellations</div>
        <div class="metric">${hot.cancellations}</div>
      </div>
      <div class="card">
        <div class="label">Dual Pitch (WC + Trucking)</div>
        <div class="metric">${hot.dualPitch}</div>
      </div>
      <div class="card">
        <div class="label">Trucking Only</div>
        <div class="metric">${hot.trucking}</div>
      </div>
    </div>
  </div>

  <div style="margin-top: 40px; color: #64748b; font-size: 13px;">
    Last updated: ${new Date().toLocaleString()}<br>
    CoverReach • AI-Powered Renewal Outreach
  </div>
</div>
</body>
</html>`;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      // ==================== REPLIES PAGE ====================
      if (req.method === "GET" && req.url === "/replies") {
        const replies = getReplies().slice().reverse();
        const cards = replies.map(r => `
          <div style="background:#1e2937;border:1px solid #334155;border-radius:10px;padding:16px;margin-bottom:12px">
            <div style="display:flex;justify-content:space-between">
              <div><strong>${r.company || "Unknown"}</strong> ${r.cancellation ? "<span style='color:#ef4444'>⚠️ CANCELLATION</span>" : ""}</div>
              <div style="color:#64748b;font-size:12px">${(r.ts || "").slice(0,16).replace("T"," ")}</div>
            </div>
            <div style="margin:8px 0;color:#94a3b8;font-size:13px">${r.name || ""} • Renewal: ${r.renewalDate || "n/a"}</div>
            <div style="margin:10px 0"><a href="mailto:${r.email}" style="color:#60a5fa">${r.email}</a></div>
            <div style="background:#0f172a;padding:12px;border-radius:6px;font-size:14px">${(r.reply || "(no message)").replace(/</g,"<")}</div>
          </div>`).join("");

        const html = `<!DOCTYPE html><html><head><title>Replies • CoverReach</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:24px;max-width:900px;margin:auto} h1{margin-bottom:20px}</style></head><body><h1>🔥 Recent Replies</h1>${cards || "<p>No replies yet.</p>"}<p style="margin-top:40px"><a href="/dashboard" style="color:#60a5fa">← Back to Dashboard</a></p></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      if (req.method === "POST" && req.url === "/webhook/inbound") {
        const body = await readBody(req);
        res.writeHead(200); res.end("ok");
        handleInboundReply(JSON.parse(body)).catch(console.error);
        return;
      }

      if (req.method === "POST" && req.url === "/webhook/brevo") {
        const body = await readBody(req);
        res.writeHead(200); res.end("ok");
        handleBrevoEvent(JSON.parse(body)).catch(console.error);
        return;
      }

      res.writeHead(404); res.end("Not found");
    } catch (e) {
      res.writeHead(500); res.end("Error");
    }
  });

  server.listen(PORT, () => log.success(`Reply server running on port ${PORT}`));
}
