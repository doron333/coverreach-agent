import http from "http";
import { getPipelineStats, getHotWindowBreakdown, getRecentActivity, getKeyInsights } from "./analytics.js";
import { getBrevoStats } from "./brevoStats.js";
import { getReplies } from "./crm.js";
import { log } from "./logger.js";

const PORT = process.env.PORT || 8080;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
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

      // ==================== SOPHISTICATED DASHBOARD WITH BREVO ====================
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
        const html = `<!DOCTYPE html><html><head><title>Replies • CoverReach</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:24px;max-width:900px;margin:auto}</style></head><body><h1>Recent Replies</h1>${replies.length ? replies.map(r => `<div style="background:#1e2937;padding:16px;margin-bottom:12px;border-radius:8px"><strong>${r.company}</strong><br>${r.reply || ''}</div>`).join('') : '<p>No replies yet.</p>'}<p><a href="/dashboard" style="color:#60a5fa">← Back to Dashboard</a></p></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      res.writeHead(404); res.end("Not found");
    } catch (e) {
      res.writeHead(500); res.end("Error");
    }
  });

  server.listen(PORT, () => log.success(`Server running on port ${PORT}`));
}
