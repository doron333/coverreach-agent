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
import { auditLeads } from "./leadAudit.js";
import { recordOutcome, getFunnel, getRevenueStats, getNeedsAction, getOpenPipeline } from "./outcomes.js";
import { runDeliverabilityTest } from "./deliverability.js";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { runSeedTest } from "./seedTest.js";
import { handleUnsubscribe, unsubscribePage } from "./unsubscribe.js";
import { listRecent } from "./inbox.js";
import { getTouchlog } from "./touchlog.js";
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
      await sendNotification("\uD83D\uDCE8 Reply from unknown sender \u2014 " + fromEmail,
        "Subject: " + subject + "\n\n" + replyText).catch(() => {});
      continue;
    }
    if (isStop) {
      lead.status = "unsubscribed"; lead.campaignEligible = false; lead.currentCampaign = null;
      saveLeads(leads);
      await persistLeadsToGitHub("Unsubscribe via reply: " + lead.company);
      continue;
    }
    lead.status = "replied"; lead.repliedAt = new Date().toISOString();
    if (!lead.history) lead.history = [];
    lead.history.push({ type: "reply_received", subject, ts: lead.repliedAt });
    saveLeads(leads);
    logReplyLocally(lead, replyText, subject);
    await logReplyToCRM(lead, replyText, subject);
    await sendNotification("\uD83D\uDD25 HOT LEAD REPLIED \u2014 " + lead.company,
      lead.company + " (" + lead.email + ")\nRenewal: " + (lead.renewalDate || "n/a") + "\n\n\"" + replyText + "\"\n\n\u2192 Sequences stopped. Reply while they're warm!").catch(() => {});
    await persistLeadsToGitHub("Reply received: " + lead.company);
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
      // One home page that holds everything, so there is a single link to put
      // on a phone home screen. Each section loads inside this shell instead
      // of navigating away.
      if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        const html = `<!DOCTYPE html><html><head>
<title>CoverReach</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="CoverReach">
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,Arial,sans-serif}
body{display:flex;flex-direction:column;padding-top:env(safe-area-inset-top)}
header{padding:10px 14px 0;flex:0 0 auto}
h1{font-size:17px;margin:0 0 8px;letter-spacing:.3px}
h1 span{color:#f87171}
nav{display:flex;gap:6px;overflow-x:auto;padding-bottom:10px;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav button{flex:0 0 auto;background:#1e2937;color:#94a3b8;border:0;padding:8px 15px;border-radius:16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
nav button.on{background:#2563eb;color:#fff}
#frame{flex:1 1 auto;width:100%;border:0;background:#0f172a}
#load{position:fixed;top:50%;left:0;right:0;text-align:center;color:#64748b;font-size:13px;pointer-events:none;opacity:0;transition:opacity .15s}
#load.on{opacity:1}
</style></head><body>
<header>
  <h1>COVER<span>REACH</span></h1>
  <nav>
    <button class="on" data-src="/activity">Activity</button>
    <button data-src="/revenue">Revenue</button>
    <button data-src="/replies">Replies</button>
    <button data-src="/dashboard">Pipeline</button>
    <button data-src="/health">Status</button>
  </nav>
</header>
<div id="load">loading&hellip;</div>
<iframe id="frame" src="/activity"></iframe>
<script>
  var frame = document.getElementById('frame');
  var load = document.getElementById('load');
  frame.addEventListener('load', function () { load.classList.remove('on'); });
  document.querySelectorAll('nav button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('nav button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      load.classList.add('on');
      frame.src = b.dataset.src;
    });
  });
</script>
</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
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

      if (req.method === "GET" && req.url === "/revenue") {
        const funnel = getFunnel();
        const rev = getRevenueStats();
        const needs = getNeedsAction();
        const open = getOpenPipeline();
        const money = (n) => "$" + (n || 0).toLocaleString();

        const funnelRows = [
          ["Contacted", funnel.counts.contacted, null, "emails delivered to prospects"],
          ["Replied", funnel.counts.replied, funnel.rates.replyRate, "of contacted"],
          ["Meeting", funnel.counts.meeting, funnel.rates.meetingRate, "of replies"],
          ["Quoted", funnel.counts.quoted, funnel.rates.quoteRate, "of meetings"],
          ["Bound", funnel.counts.bound, funnel.rates.bindRate, "of quotes"],
        ].map(([label, n, rate, sub]) => {
          const width = funnel.counts.contacted > 0
            ? Math.max((n / funnel.counts.contacted) * 100, n > 0 ? 2 : 0) : 0;
          return `<div class="fr">
            <div class="fl"><span class="fname">${label}</span><span class="fnum">${n.toLocaleString()}</span></div>
            <div class="bar"><div class="fill" style="width:${width}%"></div></div>
            <div class="fsub">${rate !== null ? rate + "% " + sub : sub}</div>
          </div>`;
        }).join("");

        const actionCards = needs.length ? needs.map((l) => `
          <div class="card" id="lead-${l.id}">
            <div class="ch">
              <div>
                <strong>${l.company || "Unknown"}</strong>
                ${l.cancellation ? '<span class="urg">CANCELLATION</span>' : ""}
                <div class="meta">${l.name ? l.name + " &middot; " : ""}${l.email}${l.phone ? " &middot; " + l.phone : ""}</div>
                <div class="meta">Renewal: ${l.renewalDate || "n/a"} &middot; replied ${(l.repliedAt || "").slice(0, 10)}</div>
              </div>
            </div>
            <div class="btns">
              <button class="b meet" onclick="rec('${l.id}','meeting')">Meeting</button>
              <button class="b quote" onclick="recAmt('${l.id}','quoted')">Quoted $</button>
              <button class="b bind" onclick="recAmt('${l.id}','bound')">Bound $</button>
              <button class="b lost" onclick="rec('${l.id}','lost')">Lost</button>
            </div>
          </div>`).join("")
          : '<p class="empty">Nothing waiting. Every reply has an outcome logged.</p>';

        const openRows = open.length ? open.map((l) => `
          <div class="card" id="lead-${l.id}">
            <div class="ch">
              <div>
                <strong>${l.company}</strong>
                <span class="stage ${l.stage}">${l.stage.toUpperCase()}${l.premium ? " &middot; " + money(l.premium) : ""}</span>
                <div class="meta">${l.email}${l.phone ? " &middot; " + l.phone : ""} &middot; renewal ${l.renewalDate || "n/a"}</div>
              </div>
            </div>
            <div class="btns">
              ${l.stage === "meeting" ? `<button class="b quote" onclick="recAmt('${l.id}','quoted')">Quoted $</button>` : ""}
              <button class="b bind" onclick="recAmt('${l.id}','bound')">Bound $</button>
              <button class="b lost" onclick="rec('${l.id}','lost')">Lost</button>
            </div>
          </div>`).join("")
          : '<p class="empty">No meetings or quotes in flight.</p>';

        const winRows = rev.wins.length ? rev.wins.map((w) => `
          <div class="win"><span>${w.company}</span><span class="wp">${money(w.premium)}</span></div>`).join("")
          : '<p class="empty">No policies bound yet.</p>';

        const html = `<!DOCTYPE html><html><head>
<title>Revenue &bull; CoverReach</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 *{box-sizing:border-box}
 body{font-family:system-ui,-apple-system,Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:16px;max-width:900px;margin:auto}
 h1{font-size:20px;margin:4px 0 2px}
 .sub{color:#64748b;font-size:12px;margin-bottom:18px}
 h2{font-size:15px;margin:26px 0 10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px}
 .hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
 .stat{background:#1e2937;border-radius:10px;padding:14px 16px}
 .stat .n{font-size:26px;font-weight:bold;color:#4ade80}
 .stat .n.blue{color:#60a5fa} .stat .n.amber{color:#fbbf24}
 .stat .l{color:#94a3b8;font-size:11px;margin-top:3px}
 .note{color:#64748b;font-size:11px;margin-top:8px;font-style:italic}
 .fr{margin-bottom:12px}
 .fl{display:flex;justify-content:space-between;align-items:baseline}
 .fname{font-size:13px} .fnum{font-weight:bold;font-size:15px}
 .bar{background:#1e2937;height:8px;border-radius:4px;overflow:hidden;margin:4px 0 3px}
 .fill{background:linear-gradient(90deg,#60a5fa,#4ade80);height:100%}
 .fsub{color:#64748b;font-size:11px}
 .card{background:#1e2937;border-radius:10px;padding:13px 15px;margin-bottom:10px}
 .card .ch strong{font-size:15px}
 .urg{color:#ef4444;font-size:10px;font-weight:bold;margin-left:6px}
 .meta{color:#94a3b8;font-size:11.5px;margin-top:3px}
 .stage{font-size:10px;font-weight:bold;margin-left:8px;padding:2px 7px;border-radius:10px}
 .stage.meeting{background:#1e3a5f;color:#93c5fd}
 .stage.quoted{background:#3f2d0f;color:#fbbf24}
 .btns{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
 .b{border:0;border-radius:7px;padding:8px 12px;font-size:12px;font-weight:bold;cursor:pointer;color:#fff}
 .b.meet{background:#2563eb} .b.quote{background:#b45309}
 .b.bind{background:#15803d} .b.lost{background:#475569}
 .b:active{opacity:.7}
 .win{display:flex;justify-content:space-between;background:#1e2937;border-radius:8px;padding:10px 14px;margin-bottom:7px;font-size:13px}
 .wp{color:#4ade80;font-weight:bold}
 .empty{color:#64748b;font-size:13px}
 a{color:#60a5fa;text-decoration:none;font-size:13px}
</style></head><body>
<h1>CoverReach &mdash; Revenue</h1>
<div class="sub">What the outreach actually produced &middot; ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET</div>

<div class="hero">
  <div class="stat"><div class="n">${money(rev.boundPremium)}</div><div class="l">PREMIUM BOUND &middot; ${rev.boundCount} ${rev.boundCount === 1 ? "policy" : "policies"}</div></div>
  <div class="stat"><div class="n amber">${money(rev.estimatedCommission)}</div><div class="l">EST. COMMISSION @ ${Math.round(rev.commissionRate * 100)}%</div></div>
  <div class="stat"><div class="n blue">${money(rev.quotedPipeline)}</div><div class="l">QUOTED PIPELINE &middot; ${rev.quotedCount} open</div></div>
  <div class="stat"><div class="n blue">${funnel.counts.contacted.toLocaleString()}</div><div class="l">PROSPECTS CONTACTED</div></div>
</div>
<div class="note">Commission is an estimate at ${Math.round(rev.commissionRate * 100)}% of bound premium, not booked revenue. Bound policies renew, so the same book is worth roughly ${money(rev.recurringNextYear)} again next year if retained.</div>

<h2>Funnel</h2>
${funnelRows}
<div class="note">Contacted &rarr; bound: ${funnel.rates.contactToBind}%</div>

<h2>Needs action &mdash; ${needs.length}</h2>
${actionCards}

<h2>Open pipeline &mdash; ${open.length}</h2>
${openRows}

<h2>Bound policies</h2>
${winRows}

<p style="margin-top:26px"><a href="/replies">Replies</a> &middot; <a href="/dashboard">Pipeline</a> &middot; <a href="/health">Status</a></p>

<script>
async function post(id, stage, premium, notes) {
  const el = document.getElementById('lead-' + id);
  if (el) { el.style.opacity = .4; }
  try {
    const r = await fetch('/outcome', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId: id, stage: stage, premium: premium, notes: notes })
    });
    if (!r.ok) throw new Error(await r.text());
    location.reload();
  } catch (e) {
    alert('Could not save: ' + e.message);
    if (el) el.style.opacity = 1;
  }
}
function rec(id, stage) {
  let notes = '';
  if (stage === 'lost') { notes = prompt('Why lost? (optional)') || ''; }
  post(id, stage, null, notes);
}
function recAmt(id, stage) {
  const p = prompt(stage === 'bound' ? 'Annual premium bound ($):' : 'Quoted annual premium ($):');
  if (p === null || p.trim() === '') return;
  post(id, stage, p, '');
}
</script>
</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      if (req.method === "POST" && req.url === "/outcome") {
        try {
          const body = await readBody(req);
          const { leadId, stage, premium, notes } = JSON.parse(body || "{}");
          if (!leadId || !stage) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "leadId and stage are required" }));
            return;
          }
          const lead = await recordOutcome(leadId, { stage, premium, notes });
          if (!lead) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "lead not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, company: lead.company, stage, outcome: lead.outcome }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.method === "GET" && (req.url === "/activity" || req.url.startsWith("/activity?"))) {
        const u = new URL(req.url, "http://x");
        const filter = u.searchParams.get("show") || "all";
        const q = (u.searchParams.get("q") || "").toLowerCase();

        // Everything before this went out as @gmail.com through Brevo, which
        // failed SPF/DKIM alignment and landed in spam. Those sends were never
        // really seen, so including them makes the reply rate meaningless.
        // Default view is the authenticated era only.
        const SENDER_CUTOVER = process.env.SENDER_CUTOVER || "2026-08-07T00:00:00Z";
        const showAll = u.searchParams.get("era") === "all";

        const leads = getLeads();
        const byEmail = new Map();
        for (const l of leads) byEmail.set((l.email || "").toLowerCase(), l);

        const allTouches = getTouchlog();
        const touches = (showAll ? allTouches : allTouches.filter((t) => (t.ts || "") >= SENDER_CUTOVER))
          .slice()
          .reverse();
        const replies = getReplies();
        const repliedSet = new Set(replies.map((r) => (r.email || "").toLowerCase()));
        for (const l of leads) {
          if (l.status === "replied" || l.repliedAt) repliedSet.add((l.email || "").toLowerCase());
        }
        const contactedInEra = new Set(touches.map((t) => (t.email || "").toLowerCase()));

        // One row per prospect, showing their most recent touch.
        const seen = new Set();
        let rows = [];
        for (const t of touches) {
          const em = (t.email || "").toLowerCase();
          if (seen.has(em)) continue;
          seen.add(em);
          const lead = byEmail.get(em) || {};
          const didReply = repliedSet.has(em);
          rows.push({
            email: em,
            company: t.company || lead.company || "—",
            name: lead.name || "",
            phone: lead.phone || "",
            city: lead.city || "",
            state: lead.state || "",
            units: lead.units || "",
            carrier: lead.carrier || "",
            subject: t.subject || "",
            touchType: t.touchType || "cold",
            ts: t.ts || "",
            renewalDate: t.renewalDate || lead.renewalDate || "",
            cancellation: t.cancellation || lead.cancellation || "",
            status: lead.status || "—",
            replied: didReply,
            outcome: lead.outcome?.stage || null,
          });
        }

        if (filter === "replied") rows = rows.filter((r) => r.replied);
        if (filter === "cancellations") rows = rows.filter((r) => r.cancellation);
        if (q) {
          rows = rows.filter((r) =>
            (r.company + " " + r.email + " " + r.subject + " " + r.carrier + " " + r.city)
              .toLowerCase()
              .includes(q)
          );
        }

        const totalSent = seen.size;
        const totalReplies = [...repliedSet].filter((e) => contactedInEra.has(e)).length;
        const replyRate = totalSent ? Math.round((totalReplies / totalSent) * 1000) / 10 : 0;
        const shown = rows.slice(0, 400);

        const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
        const when = (ts) => (ts ? ts.slice(0, 16).replace("T", " ") : "");

        const cards = shown.length
          ? shown
              .map(
                (r) => `
        <div class="row${r.replied ? " replied" : ""}">
          <div class="main">
            <div class="co">${esc(r.company)}${r.replied ? '<span class="tag rep">REPLIED</span>' : ""}${
                  r.cancellation ? '<span class="tag can">CANCELLED</span>' : ""
                }${r.outcome ? `<span class="tag out">${esc(r.outcome).toUpperCase()}</span>` : ""}</div>
            <div class="sub">"${esc(r.subject)}"</div>
            <div class="meta">${esc(r.email)}${r.phone ? " &middot; " + esc(r.phone) : ""}</div>
            <div class="meta">${[r.city, r.state].filter(Boolean).map(esc).join(", ")}${
                  r.units ? " &middot; " + esc(r.units) + " units" : ""
                }${r.carrier ? " &middot; " + esc(r.carrier) : ""}</div>
          </div>
          <div class="side">
            <div class="when">${when(r.ts)}</div>
            <div class="ren">${r.renewalDate ? "renews " + esc(r.renewalDate) : ""}</div>
            ${r.replied ? `<a class="btn" href="mailto:${esc(r.email)}">Reply</a>` : ""}
          </div>
        </div>`
              )
              .join("")
          : '<p class="empty">Nothing matches that filter.</p>';

        const tab = (key, label) =>
          `<a class="tab${filter === key ? " on" : ""}" href="/activity?show=${key}${showAll ? "&era=all" : ""}${q ? "&q=" + encodeURIComponent(q) : ""}">${label}</a>`;

        const html = `<!DOCTYPE html><html><head>
<title>Activity &bull; CoverReach</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:14px;max-width:980px;margin:auto}
h1{font-size:19px;margin:6px 0 2px}
.sub0{color:#64748b;font-size:12px;margin-bottom:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:16px}
.stat{background:#1e2937;border-radius:9px;padding:11px 13px}
.stat .n{font-size:21px;font-weight:bold}
.stat .n.g{color:#4ade80}.stat .n.b{color:#60a5fa}.stat .n.r{color:#f87171}
.stat .l{color:#94a3b8;font-size:10.5px;margin-top:2px;text-transform:uppercase;letter-spacing:.5px}
.tabs{display:flex;gap:7px;margin-bottom:12px;flex-wrap:wrap}
.tab{background:#1e2937;color:#94a3b8;padding:7px 13px;border-radius:16px;font-size:12.5px;text-decoration:none}
.tab.on{background:#2563eb;color:#fff}
form{margin-bottom:12px}
input{width:100%;padding:9px 12px;border-radius:8px;border:1px solid #334155;background:#1e2937;color:#e2e8f0;font-size:14px}
.row{background:#1e2937;border-radius:9px;padding:11px 13px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px}
.row.replied{border-left:3px solid #4ade80}
.co{font-weight:bold;font-size:14.5px}
.tag{font-size:9px;font-weight:bold;margin-left:6px;padding:2px 6px;border-radius:9px;vertical-align:middle}
.tag.rep{background:#14532d;color:#4ade80}
.tag.can{background:#450a0a;color:#f87171}
.tag.out{background:#1e3a5f;color:#93c5fd}
.sub{color:#cbd5e1;font-size:12.5px;margin-top:3px;font-style:italic}
.meta{color:#94a3b8;font-size:11px;margin-top:2px}
.side{text-align:right;white-space:nowrap}
.when{color:#64748b;font-size:10.5px}
.ren{color:#94a3b8;font-size:10.5px;margin-top:2px}
.btn{display:inline-block;margin-top:6px;background:#15803d;color:#fff;padding:5px 11px;border-radius:6px;font-size:11.5px;text-decoration:none}
.empty{color:#64748b;font-size:13px}
.foot{margin-top:22px;font-size:12.5px}
.foot a{color:#60a5fa;text-decoration:none;margin-right:14px}
</style></head><body>
<h1>CoverReach &mdash; Activity</h1>
<div class="sub0">${showAll
  ? "All sends ever, including pre-authentication mail that landed in spam"
  : "Sends from the authenticated domain (Aug 7 onward)"} &middot; newest first &middot; ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET</div>

<div class="stats">
  <div class="stat"><div class="n b">${totalSent.toLocaleString()}</div><div class="l">Contacted</div></div>
  <div class="stat"><div class="n g">${totalReplies}</div><div class="l">Replied</div></div>
  <div class="stat"><div class="n">${replyRate}%</div><div class="l">Reply rate</div></div>
  <div class="stat"><div class="n r">${rows.filter((r) => r.cancellation).length}</div><div class="l">Cancellations</div></div>
</div>

<form method="get" action="/activity">
  <input type="hidden" name="show" value="${esc(filter)}">
  ${showAll ? '<input type="hidden" name="era" value="all">' : ""}
  <input name="q" placeholder="Search company, email, carrier, city&hellip;" value="${esc(q)}">
</form>

<div class="tabs">${tab("all", "All")}${tab("replied", "Replied")}${tab("cancellations", "Cancellations")}
<a class="tab${showAll ? " on" : ""}" href="/activity?show=${filter}&era=${showAll ? "auth" : "all"}">${showAll ? "Authenticated only" : "Include pre-auth"}</a></div>

${cards}
${rows.length > 400 ? `<p class="empty">Showing first 400 of ${rows.length}. Use search to narrow.</p>` : ""}

<div class="foot">
  <a href="/revenue">Revenue</a><a href="/replies">Replies</a><a href="/health">Status</a>
</div>
</body></html>`;
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
        const html = `<!DOCTYPE html><html><head><title>Replies \u2022 CoverReach</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:24px;max-width:900px;margin:auto}</style></head><body><h1>\uD83D\uDD25 Customer Replies (${replies.length})</h1><p style="color:#64748b;font-size:13px;">Newest first \u00b7 Tap an email address to reply directly</p>${cards}<p><a href="/revenue" style="color:#60a5fa">Revenue \u2192</a> &middot; <a href="/dashboard" style="color:#60a5fa">Dashboard</a></p></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && (req.url === "/demo" || req.url === "/demo/")) {
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

      if (req.method === "GET" && req.url.startsWith("/audit")) {
        // /audit            -> preview only, changes nothing
        // /audit?apply=true -> repair + suppress + persist
        const u = new URL(req.url, "http://x");
        const apply = u.searchParams.get("apply") === "true";
        const report = await auditLeads({ apply });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          mode: apply ? "APPLIED" : "preview (add ?apply=true to fix)",
          summary: report.summary,
          scanned: report.scanned,
          repaired: report.repaired.length,
          suppressed: report.suppressed.length,
          duplicates: report.duplicates.length,
          roleAddresses: report.roleAddresses,
          unverifiedDns: report.unverifiedDns,
          durationMs: report.durationMs,
          repairSamples: report.repaired.slice(0, 15),
          suppressSamples: report.suppressed.slice(0, 15),
        }, null, 2));
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/spamtest")) {
        // Sends a real probe through the production path, then reads it back
        // over IMAP to see which folder it landed in and what the receiving
        // provider concluded about SPF/DKIM/DMARC. Takes ~45 seconds.
        try {
          const u = new URL(req.url, "http://x");
          const wait = Math.min(parseInt(u.searchParams.get("wait") || "40000"), 90000);
          const r = await runDeliverabilityTest({ waitMs: wait });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(r, null, 2));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/run-cold")) {
        // Manual trigger, mainly for verifying a change end to end.
        // ?limit=N caps this run. Anything sent here counts against the same
        // leads the scheduled batch would have taken, so the day's total stays
        // within the warm-up budget.
        const u = new URL(req.url, "http://x");
        const limit = Math.min(parseInt(u.searchParams.get("limit") || "5"), 50);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ started: true, limit, note: "check /health and Brevo in ~1 min" }));
        runColdBatch({ maxSends: limit }).catch((e) => log.error(`Manual cold batch: ${e.message}`));
        return;
      }

      if (req.method === "GET" && req.url === "/seedtest") {
        // Fire the seed emails on demand, then check those inboxes by hand.
        try {
          const r = await runSeedTest();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(r, null, 2));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.url.startsWith("/unsubscribe")) {
        // Mail clients send a POST for one-click; browsers send a GET.
        const r = await handleUnsubscribe(req.url);
        if (req.method === "POST") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(r.ok ? "unsubscribed" : "invalid");
        } else {
          res.writeHead(r.ok ? 200 : 400, { "Content-Type": "text/html" });
          res.end(unsubscribePage(r.ok, r.email));
        }
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/inbox")) {
        // Read-only diagnostic: what actually arrived in the watched mailbox.
        try {
          const u = new URL(req.url, "http://x");
          const r = await listRecent({
            limit: Math.min(parseInt(u.searchParams.get("limit") || "25"), 60),
            folder: u.searchParams.get("folder") || "INBOX",
            search: u.searchParams.get("q") || null,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(r, null, 2));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
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
        handleInboundReply(JSON.parse(body)).catch((e) => log.error("Inbound: " + e.message));
        return;
      }

      if (req.method === "POST" && req.url === "/webhook/brevo") {
        const body = await readBody(req);
        res.writeHead(200); res.end("ok");
        handleBrevoEvent(JSON.parse(body)).catch((e) => log.error("Event: " + e.message));
        return;
      }

      res.writeHead(404); res.end("Not found");
    } catch (e) {
      res.writeHead(500); res.end("Error");
    }
  });

  server.listen(PORT, () => log.success(`Server running on port ${PORT}`));
}
