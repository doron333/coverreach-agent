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
import { recordOutcome, getFunnel, getRevenueStats, getNeedsAction, getOpenPipeline, getRecentlyClosed } from "./outcomes.js";
import { runDeliverabilityTest } from "./deliverability.js";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { runSeedTest } from "./seedTest.js";
import { handleUnsubscribe, unsubscribePage } from "./unsubscribe.js";
import { listRecent } from "./inbox.js";
import { getTouchlog } from "./touchlog.js";
import { getHotWindowLeads } from "./leads.js";
import { getHotList, backfillHotList } from "./hotlist.js";
import { getReputationSummary, postmasterConfigured } from "./postmaster.js";
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


/**
 * Shared chrome for every screen. Rendered server-side so each page is a real
 * page — no iframes, which iOS Safari scrolls badly and which broke the
 * back button and momentum scrolling on the home-screen app.
 */

// These pages are live operational data — a phone showing yesterday's numbers
// is worse than useless. Home-screen web apps cache aggressively by default,
// so every response explicitly refuses to be stored.
const HTML_HEADERS = {
  "Content-Type": "text/html",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

function pageHead(title, active) {
  const tabs = [
    ["/activity", "Activity"],
    ["/daily", "Daily"],
    ["/hot", "Hot List"],
    ["/missed", "Missed"],
    ["/reputation", "Reputation"],
    ["/revenue", "Revenue"],
    ["/replies", "Replies"],
    ["/dashboard", "Pipeline"],
    ["/status", "Status"],
  ];
  return `<!DOCTYPE html><html><head>
<title>${title} &bull; CoverReach</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="CoverReach">
<meta name="theme-color" content="#0f172a">
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{font-family:system-ui,-apple-system,Arial,sans-serif;background:#0f172a;color:#e2e8f0;
     margin:0;padding:0 14px 40px;max-width:980px;margin:0 auto;
     padding-top:calc(env(safe-area-inset-top) + 8px);-webkit-text-size-adjust:100%}
.brand{font-size:15px;font-weight:700;letter-spacing:.4px;margin:4px 0 9px}
.brand i{color:#f87171;font-style:normal}
.nav{display:flex;gap:6px;overflow-x:auto;padding-bottom:12px;margin-bottom:4px;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.nav a{flex:0 0 auto;background:#1e2937;color:#94a3b8;padding:8px 15px;border-radius:16px;
       font-size:13px;font-weight:600;text-decoration:none}
.nav a.on{background:#2563eb;color:#fff}
h1{font-size:19px;margin:2px 0}
.stamp{color:#64748b;font-size:10.5px;margin:-4px 0 10px}
.stamp a{color:#60a5fa;text-decoration:none}
</style></head><body>
<div class="brand">COVER<i>REACH</i></div>
<div class="nav">${tabs.map(([href, label]) =>
  `<a href="${href}"${href === active ? ' class="on"' : ""}>${label}</a>`).join("")}</div>
<div class="stamp">updated ${new Date().toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET &middot; <a href="${active}">refresh</a></div>`;
}

export function startReplyServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        res.writeHead(302, { Location: "/activity" });
        res.end();
        return;
      }

      // Human-readable status page (the /health JSON stays for tooling).
      if (req.method === "GET" && req.url === "/status") {
        const s = getPipelineStats();
        const card = (n, l, cls) =>
          `<div class="st"><div class="n ${cls || ""}">${typeof n === "number" ? n.toLocaleString() : n}</div><div class="l">${l}</div></div>`;
        const html = pageHead("Status", "/status") + `
<style>.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:9px;margin-top:8px}
.st{background:#1e2937;border-radius:9px;padding:12px 14px}
.st .n{font-size:22px;font-weight:bold}.st .n.g{color:#4ade80}.st .n.b{color:#60a5fa}.st .n.r{color:#f87171}
.st .l{color:#94a3b8;font-size:10.5px;margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
.ok{margin-top:16px;background:#14532d;color:#4ade80;border-radius:9px;padding:11px 14px;font-size:13px;font-weight:600}</style>
<h1>Status</h1>
<div class="ok">&#9679; Agent running &mdash; next batch 9:46 AM ET daily</div>
<div class="grid">
${card(s.inWindowNow ?? 0, "In send window", "b")}
${card(s.cancellationsInWindow ?? 0, "Cancellations", "r")}
${card(s.totalPipeline ?? 0, "Leads remaining")}
${card(s.contacted ?? 0, "Contacted")}
${card(s.replied ?? 0, "Replied", "g")}
${card(s.bounced ?? 0, "Bounced")}
${card(s.unsubscribed ?? 0, "Unsubscribed")}
${card(s.totalLeads ?? 0, "Total leads")}
</div>
<p style="color:#64748b;font-size:11.5px;margin-top:16px">Updated ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET</p>
</body></html>`;
        res.writeHead(200, HTML_HEADERS);
        res.end(html);
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        const stats = getPipelineStats();
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ status: "alive", time: new Date().toISOString(), ...stats }));
        return;
      }

      // Test Brevo connection
      if (req.method === "GET" && req.url === "/test-brevo") {
        const brevoStats = await getBrevoStats();
        res.writeHead(200, JSON_HEADERS);
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

        res.writeHead(200, HTML_HEADERS);
        res.end(html);
        return;
      }

      if (req.method === "GET" && (req.url === "/revenue" || req.url.startsWith("/revenue?"))) {
        const funnel = getFunnel();
        const rev = getRevenueStats();
        const revQ = (new URL(req.url, "http://x").searchParams.get("q") || "").trim().toLowerCase();
        const needs = getNeedsAction();

        // Lookup across the whole book. Deals close by phone as often as by
        // email, so an outcome must be loggable for any prospect — not only
        // the ones who happened to reply to a message.
        const searchHits = revQ
          ? getLeads()
              .filter((l) => {
                const hay = [l.company, l.email, l.name, l.city, l.carrier, l.phone]
                  .filter(Boolean).join(" ").toLowerCase();
                return hay.includes(revQ);
              })
              .slice(0, 25)
              .map((l) => ({
                id: l.id,
                company: l.company || "\u2014",
                name: l.name || "",
                email: l.email || "",
                phone: l.phone || "",
                city: l.city || "",
                state: l.state || "",
                units: l.units || "",
                carrier: l.carrier || "",
                renewalDate: l.renewalDate || "",
                cancellation: l.cancellation || null,
                status: l.status || "",
                stage: l.outcome?.stage || null,
                premium: l.outcome?.boundPremium || l.outcome?.quotedPremium || null,
              }))
          : [];
        const open = getOpenPipeline();
        const closed = getRecentlyClosed();
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
              <button class="b meet" data-lead="${l.id}" data-stage="meeting">Meeting</button>
              <button class="b quote" data-lead="${l.id}" data-stage="quoted">Quoted $</button>
              <button class="b bind" data-lead="${l.id}" data-stage="bound">Bound $</button>
              <button class="b lost" data-lead="${l.id}" data-stage="lost">Lost</button>
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
              ${l.stage === "meeting" ? `<button class="b quote" data-lead="${l.id}" data-stage="quoted">Quoted $</button>` : ""}
              <button class="b bind" data-lead="${l.id}" data-stage="bound">Bound $</button>
              <button class="b lost" data-lead="${l.id}" data-stage="lost">Lost</button>
            </div>
          </div>`).join("")
          : '<p class="empty">No meetings or quotes in flight.</p>';

        const winRows = rev.wins.length ? rev.wins.map((w) => `
          <div class="card">
            <div class="ch"><strong>${w.company}</strong><span class="wp" style="float:right">${money(w.partnerCut)} to you</span></div>
            <div class="meta">${money(w.premium)} premium &middot; ${Math.round(w.rate * 100)}% ${w.rateAssumed ? "(assumed)" : ""} &rarr; ${money(w.commission)} agency</div>
            <div class="meta">${[w.carrier, w.lines, w.effectiveDate ? "eff. " + w.effectiveDate : null].filter(Boolean).join(" &middot; ") || "&mdash;"}</div>
          </div>`).join("")
          : '<p class="empty">No policies bound yet.</p>';

        const html = pageHead("Revenue", "/revenue") + `
<style>
h2{font-size:13.5px;margin:22px 0 9px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:9px}
.stat{background:#1e2937;border-radius:10px;padding:13px 15px}
.stat .n{font-size:24px;font-weight:bold;color:#4ade80}
.stat .n.blue{color:#60a5fa}.stat .n.amber{color:#fbbf24}
.stat .l{color:#94a3b8;font-size:10.5px;margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
.note{color:#64748b;font-size:11px;margin-top:9px;font-style:italic;line-height:1.5}
.fr{margin-bottom:11px}.fl{display:flex;justify-content:space-between;align-items:baseline}
.fname{font-size:13px}.fnum{font-weight:bold;font-size:15px}
.bar{background:#1e2937;height:8px;border-radius:4px;overflow:hidden;margin:4px 0 3px}
.fill{background:linear-gradient(90deg,#60a5fa,#4ade80);height:100%}
.fsub{color:#64748b;font-size:11px}
.card{background:#1e2937;border-radius:10px;padding:12px 14px;margin-bottom:9px}
.card .ch strong{font-size:14.5px}
.urg{color:#ef4444;font-size:9.5px;font-weight:bold;margin-left:6px}
.meta{color:#94a3b8;font-size:11.5px;margin-top:3px;word-break:break-word}
.stage{font-size:9.5px;font-weight:bold;margin-left:8px;padding:2px 7px;border-radius:10px}
.stage.meeting{background:#1e3a5f;color:#93c5fd}.stage.quoted{background:#3f2d0f;color:#fbbf24}
.btns{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.b{border:0;border-radius:7px;padding:9px 13px;font-size:12.5px;font-weight:bold;color:#fff;font-family:inherit}
.b.meet{background:#2563eb}.b.quote{background:#b45309}.b.bind{background:#15803d}.b.lost{background:#475569}
.b:active{opacity:.7}
.win{display:flex;justify-content:space-between;background:#1e2937;border-radius:8px;padding:10px 14px;margin-bottom:7px;font-size:13px}
.wp{color:#4ade80;font-weight:bold}
.empty{color:#64748b;font-size:13px}
.lookup{margin-bottom:12px}
.lookup input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#1e2937;color:#e2e8f0;font-size:16px;font-family:inherit}
.dealform{margin-top:11px;border-top:1px solid #334155;padding-top:11px}
.fld{margin-bottom:8px}
.fld label{display:block;color:#94a3b8;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.fld input{width:100%;padding:9px 11px;border-radius:7px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:16px;font-family:inherit}
.fbtns{display:flex;gap:7px;margin-top:10px}
.wp{color:#4ade80;font-weight:bold}
</style>
<h1>Revenue</h1>
<div class="note" style="margin-bottom:14px">What the outreach actually produced</div>

<div class="hero">
  <div class="stat"><div class="n">${money(rev.partnerEarnings)}</div><div class="l">${rev.partnerName} &middot; ${Math.round(rev.partnerShare * 100)}% of commission</div></div>
  <div class="stat"><div class="n amber">${money(rev.agencyCommission)}</div><div class="l">AGENCY COMMISSION</div></div>
  <div class="stat"><div class="n blue">${money(rev.boundPremium)}</div><div class="l">PREMIUM BOUND &middot; ${rev.boundCount} ${rev.boundCount === 1 ? "policy" : "policies"}</div></div>
  <div class="stat"><div class="n blue">${money(rev.quotedPipeline)}</div><div class="l">QUOTED PIPELINE &middot; ${rev.quotedCount} open</div></div>
</div>
<div class="note">Your share is calculated at ${Math.round(rev.partnerShare * 100)}% of agency commission &mdash; set PARTNER_SHARE once the arrangement is agreed.${
  rev.estimatedPortion > 0
    ? ` ${money(rev.estimatedPortion)} of the commission above uses the default ${Math.round(rev.defaultRate * 100)}% rate because no rate was entered on those policies.`
    : ""
} Bound policies renew, so this book is worth about ${money(rev.recurringNextYear)} to you again next year if retained.</div>

<h2>Funnel</h2>
${funnelRows}
<div class="note">Contacted &rarr; bound: ${funnel.rates.contactToBind}%</div>

<h2>Find a company</h2>
<form method="get" action="/revenue" class="lookup">
  <input name="q" placeholder="Company, email, carrier, city or phone&hellip;" value="${revQ.replace(/"/g, "&quot;")}">
</form>
${revQ ? (searchHits.length ? searchHits.map((s) => `
  <div class="card" id="lead-${s.id}">
    <div class="ch">
      <strong>${s.company}</strong>
      ${s.stage ? `<span class="stage ${s.stage === "quoted" ? "quoted" : "meeting"}">${s.stage.toUpperCase()}${s.premium ? " &middot; " + money(s.premium) : ""}</span>` : ""}
      ${s.cancellation ? '<span class="urg">CANCELLATION</span>' : ""}
      <div class="meta">${s.name ? s.name + " &middot; " : ""}${s.email}${s.phone ? " &middot; " + s.phone : ""}</div>
      <div class="meta">${[s.city, s.state].filter(Boolean).join(", ")}${s.units ? " &middot; " + s.units + " units" : ""}${s.carrier ? " &middot; " + s.carrier : ""} &middot; renews ${s.renewalDate || "n/a"} &middot; ${s.status}</div>
    </div>
    <div class="btns">
      <button class="b meet" data-lead="${s.id}" data-stage="meeting">Meeting</button>
      <button class="b quote" data-lead="${s.id}" data-stage="quoted">Quoted $</button>
      <button class="b bind" data-lead="${s.id}" data-stage="bound">Bound $</button>
      <button class="b lost" data-lead="${s.id}" data-stage="lost">Lost</button>
      ${s.stage ? `<button class="b lost" data-lead="${s.id}" data-stage="reopen">Reopen</button>` : ""}
    </div>
  </div>`).join("") : '<p class="empty">No match for that search.</p>') : '<p class="empty">Search any prospect to log an outcome &mdash; useful when a deal closes by phone rather than by email reply.</p>'}

<h2>Needs action &mdash; ${needs.length}</h2>
${actionCards}

<h2>Open pipeline &mdash; ${open.length}</h2>
${openRows}

<h2>Bound policies</h2>
${winRows}

<h2>Recently closed &mdash; ${closed.length}</h2>
${closed.length ? closed.map((c2) => `
  <div class="card" id="lead-${c2.id}">
    <div class="ch"><strong>${c2.company}</strong>
      <span class="stage ${c2.stage === "bound" ? "quoted" : "meeting"}">${c2.stage.toUpperCase()}${c2.premium ? " &middot; " + money(c2.premium) : ""}</span></div>
    <div class="meta">${c2.email}${c2.lostReason ? " &middot; " + c2.lostReason : ""} &middot; ${(c2.ts || "").slice(0, 10)}</div>
    <div class="btns"><button class="b lost" data-lead="${c2.id}" data-stage="reopen">Undo &mdash; reopen</button></div>
  </div>`).join("") : '<p class="empty">Nothing closed in the last two weeks.</p>'}

<script src="/revenue.js"></script>
</body></html>`;
        res.writeHead(200, HTML_HEADERS);
        res.end(html);
        return;
      }

      if (req.method === "GET" && req.url === "/revenue.js") {
        // Served as a separate file rather than inlined. Building this inside a
        // template literal required escaping quotes through two layers, and a
        // single bad escape produced a syntax error that disabled every button.
        try {
          const js = fs.readFileSync(path.join(__dirname2, "revenue.js"), "utf8");
          res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
          res.end(js);
        } catch {
          res.writeHead(404); res.end("// not found");
        }
        return;
      }

      if (req.method === "POST" && req.url === "/outcome") {
        try {
          const body = await readBody(req);
          const { leadId, stage, premium, notes, commissionRate, carrier, effectiveDate, lines } = JSON.parse(body || "{}");
          if (!leadId || !stage) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "leadId and stage are required" }));
            return;
          }
          const lead = await recordOutcome(leadId, { stage, premium, notes, commissionRate, carrier, effectiveDate, lines });
          if (!lead) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "lead not found" }));
            return;
          }
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify({ ok: true, company: lead.company, stage, outcome: lead.outcome }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/reputation/connect")) {
        // Browser-based OAuth so this can be done from a phone rather than by
        // running a CLI script. Google is handed this server's own callback
        // URL, so the code comes straight back here and gets exchanged for a
        // refresh token without any copy-pasting of intermediate values.
        const base = process.env.PUBLIC_URL || "https://coverreach-agent-production.up.railway.app";
        const redirect = `${base}/reputation/callback`;
        const uc = new URL(req.url, "http://x");
        const cid = uc.searchParams.get("client_id");
        const secret = uc.searchParams.get("client_secret");

        if (!cid || !secret) {
          const html = pageHead("Connect Google", "/reputation") + `
<style>
.step{background:#1e2937;border-radius:9px;padding:13px 15px;margin-bottom:9px;font-size:13px;line-height:1.6}
.step b{color:#e2e8f0}
.step ol{margin:8px 0 0 18px;padding:0;color:#cbd5e1}
.step li{margin-bottom:5px}
code{background:#0f172a;padding:2px 6px;border-radius:4px;font-size:11.5px;word-break:break-all}
.fld{margin-bottom:9px}
.fld label{display:block;color:#94a3b8;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.fld input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:16px;font-family:inherit}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-size:14px;font-weight:bold;font-family:inherit;width:100%}
a{color:#60a5fa}
</style>
<h1>Connect Google Postmaster</h1>
<div class="step"><b>1. Create the credentials</b>
<ol>
<li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank">console.cloud.google.com</a> and create a project (any name)</li>
<li>Go to <b>APIs &amp; Services &rarr; Library</b>, search <b>Gmail Postmaster Tools API</b>, click <b>Enable</b></li>
<li>Go to <b>APIs &amp; Services &rarr; Credentials &rarr; Create Credentials &rarr; OAuth client ID</b></li>
<li>If prompted for a consent screen: choose <b>External</b>, fill the required fields, and add your own email as a test user</li>
<li>Application type: <b>Web application</b></li>
<li>Under <b>Authorised redirect URIs</b> add exactly:<br><code>${redirect}</code></li>
<li>Create it, then copy the Client ID and Client Secret</li>
</ol></div>
<div class="step"><b>2. Paste them here</b>
<form method="get" action="/reputation/connect" style="margin-top:10px">
  <div class="fld"><label>Client ID</label><input name="client_id" placeholder="....apps.googleusercontent.com" required></div>
  <div class="fld"><label>Client Secret</label><input name="client_secret" placeholder="GOCSPX-..." required></div>
  <button type="submit">Continue to Google</button>
</form></div>
<div class="step" style="color:#94a3b8">Sign in with the same Google account that verified <b>outreach.centraljerseyins.com</b> in Postmaster Tools, or it will not see the domain.</div>
</body></html>`;
          res.writeHead(200, HTML_HEADERS);
          res.end(html);
          return;
        }

        const authUrl =
          "https://accounts.google.com/o/oauth2/v2/auth?" +
          new URLSearchParams({
            client_id: cid,
            redirect_uri: redirect,
            response_type: "code",
            scope: "https://www.googleapis.com/auth/postmaster.readonly",
            access_type: "offline",
            prompt: "consent",
            state: Buffer.from(JSON.stringify({ cid, secret })).toString("base64url"),
          });
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/reputation/callback")) {
        const uc = new URL(req.url, "http://x");
        const code = uc.searchParams.get("code");
        const state = uc.searchParams.get("state");
        const err = uc.searchParams.get("error");
        const base = process.env.PUBLIC_URL || "https://coverreach-agent-production.up.railway.app";

        const shell = (inner) =>
          pageHead("Connect Google", "/reputation") + `
<style>
.box{background:#1e2937;border-radius:9px;padding:14px 16px;font-size:13px;line-height:1.6}
.box.bad{border-left:3px solid #f87171}
.box.good{border-left:3px solid #4ade80}
code{background:#0f172a;padding:8px 10px;border-radius:6px;font-size:11.5px;display:block;margin:6px 0;word-break:break-all;color:#4ade80}
a{color:#60a5fa}
</style>` + inner + `</body></html>`;

        if (err || !code || !state) {
          res.writeHead(400, HTML_HEADERS);
          res.end(shell(`<h1>Not connected</h1><div class="box bad">Google returned: ${(err || "no code").replace(/</g, "&lt;")}<br><br><a href="/reputation/connect">Try again</a></div>`));
          return;
        }

        try {
          const { cid, secret } = JSON.parse(Buffer.from(state, "base64url").toString());
          const tokRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              code,
              client_id: cid,
              client_secret: secret,
              redirect_uri: `${base}/reputation/callback`,
              grant_type: "authorization_code",
            }),
          });
          const tok = await tokRes.json();

          if (!tokRes.ok || !tok.refresh_token) {
            res.writeHead(400, HTML_HEADERS);
            res.end(shell(`<h1>Not connected</h1><div class="box bad">Google did not return a refresh token.<br><br>${JSON.stringify(tok).slice(0, 300).replace(/</g, "&lt;")}<br><br>If you have approved this before, revoke it at <a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a> and try again.</div>`));
            return;
          }

          // Deliberately NOT written to disk or the repo — refresh tokens are
          // long-lived credentials and belong in Railway's encrypted variables,
          // not in a git history.
          res.writeHead(200, HTML_HEADERS);
          res.end(shell(`<h1>Almost there</h1>
<div class="box good">Google approved it. Add these three to <b>Railway &rarr; Variables</b>, then reopen the Reputation tab.</div>
<div class="box" style="margin-top:9px">
<b>PM_CLIENT_ID</b><code>${cid}</code>
<b>PM_CLIENT_SECRET</b><code>${secret}</code>
<b>PM_REFRESH_TOKEN</b><code>${tok.refresh_token}</code>
</div>
<div class="box" style="margin-top:9px;color:#94a3b8">These are credentials &mdash; they are shown once here and not stored anywhere by the app. Paste them straight into Railway.</div>`));
        } catch (e) {
          res.writeHead(500, HTML_HEADERS);
          res.end(shell(`<h1>Error</h1><div class="box bad">${String(e.message).replace(/</g, "&lt;")}</div>`));
        }
        return;
      }

      if (req.method === "GET" && req.url === "/reputation") {
        let s;
        try {
          s = await getReputationSummary();
        } catch (err) {
          s = { configured: postmasterConfigured(), error: err.message };
        }
        const pct = (v) => (v == null ? "&mdash;" : Math.round(v * 1000) / 10 + "%");
        const grade = s.latest?.domainReputation || null;
        const gradeClass =
          grade === "HIGH" ? "g" : grade === "MEDIUM" ? "a" : grade === "LOW" || grade === "BAD" ? "r" : "";

        const body = !s.configured
          ? `<div class="warn">Not connected yet. <a href="/reputation/connect" style="color:#60a5fa;font-weight:bold">Connect Google &rarr;</a><br><br>Takes about five minutes and can be done entirely in the browser.</div>`
          : s.error
          ? `<div class="warn">Could not reach Postmaster: ${String(s.error).replace(/</g, "&lt;").slice(0, 300)}</div>`
          : !s.hasData
          ? `<div class="warn">${s.message}</div>`
          : `
        <div class="grid">
          <div class="st"><div class="n ${gradeClass}">${grade || "&mdash;"}</div><div class="l">Domain reputation</div></div>
          <div class="st"><div class="n ${s.latest.spamRate > 0.003 ? "r" : "g"}">${pct(s.latest.spamRate)}</div><div class="l">Spam complaints</div></div>
          <div class="st"><div class="n">${pct(s.latest.dmarcSuccess)}</div><div class="l">DMARC pass</div></div>
          <div class="st"><div class="n">${pct(s.latest.dkimSuccess)}</div><div class="l">DKIM pass</div></div>
        </div>
        <div class="verdict">${s.verdict}</div>
        <p class="note">Google flags a spam complaint rate above 0.3% as a problem. Data lags about a day and skips days with low volume.</p>
        <h2>History</h2>
        <table><tr><th>Date</th><th>Reputation</th><th>Spam</th><th>DMARC</th></tr>
        ${s.history.map((h) => `<tr><td>${h.date}</td><td>${h.domainReputation || "&mdash;"}</td><td>${pct(h.spamRate)}</td><td>${pct(h.dmarcSuccess)}</td></tr>`).join("")}
        </table>`;

        const html = pageHead("Reputation", "/reputation") + `
<style>
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:9px;margin-bottom:12px}
.st{background:#1e2937;border-radius:9px;padding:13px 15px}
.st .n{font-size:21px;font-weight:bold}
.st .n.g{color:#4ade80}.st .n.a{color:#fbbf24}.st .n.r{color:#f87171}
.st .l{color:#94a3b8;font-size:10.5px;margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
.verdict{background:#1e2937;border-radius:9px;padding:12px 15px;font-size:13.5px;line-height:1.5}
.warn{background:#1e2937;border-left:3px solid #fbbf24;border-radius:9px;padding:13px 15px;font-size:13px;line-height:1.6;color:#cbd5e1}
.note{color:#64748b;font-size:11.5px;line-height:1.5;margin-top:10px}
h2{font-size:13.5px;margin:20px 0 8px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:#94a3b8;font-size:10.5px;text-transform:uppercase;padding:6px 8px}
td{padding:8px;border-top:1px solid #1e2937}
code{background:#0f172a;padding:2px 6px;border-radius:4px;font-size:12px}
</style>
<h1>Gmail reputation</h1>
<p class="note" style="margin-bottom:14px">What Google itself reports about mail from ${process.env.PM_DOMAIN || "outreach.centraljerseyins.com"}.</p>
${body}
</body></html>`;
        res.writeHead(200, HTML_HEADERS);
        res.end(html);
        return;
      }

      if (req.method === "GET" && (req.url === "/missed" || req.url.startsWith("/missed?"))) {
        const u3 = new URL(req.url, "http://x");
        const view = u3.searchParams.get("v") || "all";
        const q3 = (u3.searchParams.get("q") || "").toLowerCase();

        const parseDate = (s) => {
          if (!s) return null;
          const m = String(s).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
        };
        const now = Date.now();

        // A renewal date recurs. Someone who renewed 7/15/2026 renews again
        // 7/15/2027, so every one of these is a dated prospect for next
        // year's campaign rather than a dead record.
        const nextYear = (s) => {
          const d = parseDate(s);
          if (!d) return null;
          return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear() + 1}`;
        };

        let rows = getLeads()
          .filter((l) => {
            const d = parseDate(l.renewalDate);
            if (!d || d.getTime() >= now) return false;        // still ahead
            if (l.outcome?.stage === "bound") return false;      // we won it
            if (l.status === "unsubscribed") return false;       // asked us to stop
            return true;
          })
          .map((l) => {
            const touched = !!(l.lastContacted || (l.history || []).some((h) => h.type === "cold" || h.type === "followup"));
            const preAuth = l.archivedReason === "pre_auth_send_and_renewal_passed" || l.priorAttempt === "pre_auth_spam_folder";
            return {
              id: l.id,
              company: l.company || "—",
              email: l.email,
              phone: l.phone,
              city: l.city,
              state: l.state,
              units: l.units,
              carrier: l.carrier,
              renewalDate: l.renewalDate,
              nextRenewal: nextYear(l.renewalDate),
              bounced: l.status === "bounced",
              everReplied: !!l.everReplied,
              lost: l.outcome?.stage === "lost",
              touched,
              preAuth,
              category: !touched ? "never" : preAuth ? "spam" : "noreply",
            };
          });

        if (view === "never") rows = rows.filter((r) => r.category === "never");
        if (view === "spam") rows = rows.filter((r) => r.category === "spam");
        if (view === "noreply") rows = rows.filter((r) => r.category === "noreply");
        if (q3) {
          rows = rows.filter((r) =>
            (r.company + " " + r.email + " " + (r.carrier || "") + " " + (r.city || "")).toLowerCase().includes(q3)
          );
        }

        rows.sort((a, b) => {
          const da = parseDate(a.renewalDate)?.getTime() || 0;
          const db = parseDate(b.renewalDate)?.getTime() || 0;
          return db - da;
        });

        const all = getLeads();
        const counts = { never: 0, spam: 0, noreply: 0 };
        for (const l of all) {
          const d = parseDate(l.renewalDate);
          if (!d || d.getTime() >= now) continue;
          if (l.outcome?.stage === "bound" || l.status === "unsubscribed") continue;
          const touched = !!(l.lastContacted || (l.history || []).some((h) => h.type === "cold" || h.type === "followup"));
          const preAuth = l.archivedReason === "pre_auth_send_and_renewal_passed" || l.priorAttempt === "pre_auth_spam_folder";
          if (!touched) counts.never++;
          else if (preAuth) counts.spam++;
          else counts.noreply++;
        }
        const total = counts.never + counts.spam + counts.noreply;

        const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
        const shown = rows.slice(0, 300);

        const tab = (k, label, n) =>
          `<a class="tab${view === k ? " on" : ""}" href="/missed?v=${k}${q3 ? "&q=" + encodeURIComponent(q3) : ""}">${label}${
            n !== undefined ? ` <b>${n}</b>` : ""
          }</a>`;

        const cards = shown.length
          ? shown
              .map((r) => {
                const badge =
                  r.category === "never"
                    ? '<span class="tg nv">NEVER CONTACTED</span>'
                    : r.category === "spam"
                    ? '<span class="tg sp">LANDED IN SPAM</span>'
                    : '<span class="tg nr">NO REPLY</span>';
                return `<div class="mc">
          <div class="top">
            <div><div class="co">${esc(r.company)}${badge}${r.everReplied ? '<span class="tg rp">REPLIED</span>' : ""}${
                  r.bounced ? '<span class="tg bo">BAD ADDRESS</span>' : ""
                }</div>
            <div class="who">${[r.city, r.state].filter(Boolean).map(esc).join(", ")}${
                  r.units ? " &middot; " + esc(r.units) + " units" : ""
                }${r.carrier ? " &middot; " + esc(r.carrier) : ""}</div></div>
            <div class="dt">was ${esc(r.renewalDate)}<div class="nx">next ${esc(r.nextRenewal || "?")}</div></div>
          </div>
          <div class="ct">${esc(r.email || "")}${r.phone ? " &middot; " + esc(r.phone) : ""}</div>
        </div>`;
              })
              .join("")
          : '<p class="empty">Nothing here.</p>';

        const html =
          pageHead("Missed", "/missed") +
          `
<style>
.lede{color:#94a3b8;font-size:12px;line-height:1.55;margin-bottom:12px}
.tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.tab{background:#1e2937;color:#94a3b8;padding:6px 12px;border-radius:14px;font-size:12px;text-decoration:none}
.tab.on{background:#334155;color:#e2e8f0}
.tab b{color:#e2e8f0}
form{margin-bottom:12px}
input[name=q]{width:100%;padding:9px 12px;border-radius:8px;border:1px solid #334155;background:#1e2937;color:#e2e8f0;font-size:16px}
.mc{background:#1e2937;border-radius:9px;padding:11px 13px;margin-bottom:8px}
.top{display:flex;justify-content:space-between;gap:10px}
.co{font-weight:bold;font-size:14px}
.who{color:#94a3b8;font-size:11px;margin-top:3px}
.ct{color:#94a3b8;font-size:11px;margin-top:5px;word-break:break-word}
.dt{color:#64748b;font-size:10.5px;text-align:right;white-space:nowrap}
.nx{color:#4ade80;font-size:10.5px;margin-top:2px}
.tg{font-size:8.5px;font-weight:bold;margin-left:5px;padding:2px 6px;border-radius:9px;white-space:nowrap}
.tg.nv{background:#3f2d0f;color:#fbbf24}
.tg.sp{background:#450a0a;color:#f87171}
.tg.nr{background:#1e293b;color:#94a3b8}
.tg.rp{background:#14532d;color:#4ade80}
.tg.bo{background:#334155;color:#cbd5e1}
.empty{color:#64748b;font-size:13px}
</style>
<h1>Missed &mdash; ${total.toLocaleString()}</h1>
<div class="lede">Renewals that came and went without a sale. Every one of these renews again next year on the same date, so this is next year's pipeline &mdash; already dated, already qualified.</div>
<div class="tabs">${tab("all", "All", total)}${tab("never", "Never contacted", counts.never)}${tab(
            "spam",
            "Landed in spam",
            counts.spam
          )}${tab("noreply", "No reply", counts.noreply)}</div>
<form method="get" action="/missed">
  <input type="hidden" name="v" value="${esc(view)}">
  <input name="q" placeholder="Search company, carrier, city&hellip;" value="${esc(q3)}">
</form>
${cards}
${rows.length > 300 ? `<p class="empty">Showing 300 of ${rows.length.toLocaleString()}. Use search to narrow.</p>` : ""}
</body></html>`;
        res.writeHead(200, HTML_HEADERS);
        res.end(html);
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/hot")) {
        if (req.url.includes("backfill=true")) {
          const r = await backfillHotList();
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(r));
          return;
        }

        const hot = getHotList();
        const esc = (s) => String(s).replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]));
        const money = (n) => "$" + (n || 0).toLocaleString();

        const cards = hot.length
          ? hot
              .map(
                (h) => `
        <div class="hc">
          <div class="top">
            <div>
              <div class="co">${esc(h.company || "—")}${
                  h.outcome === "bound" ? '<span class="tg won">WON</span>' : ""
                }${h.replyCount > 1 ? `<span class="tg mult">${h.replyCount} replies</span>` : ""}</div>
              <div class="who">${h.name ? esc(h.name) + " &middot; " : ""}${[h.city, h.state]
                  .filter(Boolean)
                  .map(esc)
                  .join(", ")}${h.units ? " &middot; " + esc(h.units) + " units" : ""}</div>
            </div>
            <div class="dt">${(h.lastReplied || "").slice(0, 10)}</div>
          </div>
          <div class="ct"><a href="mailto:${esc(h.email)}">${esc(h.email)}</a>${
                  h.phone ? ` &middot; <a href="tel:${esc(h.phone)}">${esc(h.phone)}</a>` : ""
                }</div>
          ${h.lastSubject ? `<div class="sj">replied to "${esc(h.lastSubject)}"</div>` : ""}
          ${h.lastExcerpt ? `<div class="ex">${esc(h.lastExcerpt).slice(0, 220)}</div>` : ""}
          <div class="ft">${h.carrier ? esc(h.carrier) + " &middot; " : ""}renews ${esc(h.renewalDate || "n/a")}${
                  h.boundPremium ? " &middot; bound " + money(h.boundPremium) : ""
                }${h.campaigns.length ? " &middot; " + h.campaigns.map(esc).join(", ") : ""}</div>
        </div>`
              )
              .join("")
          : `<p class="empty">Nobody has replied yet. When someone does, they land here permanently.</p>`;

        const html =
          pageHead("Hot List", "/hot") +
          `
<style>
.lede{color:#94a3b8;font-size:12px;line-height:1.55;margin-bottom:14px}
.hc{background:#1e2937;border-radius:10px;padding:13px 15px;margin-bottom:10px;border-left:3px solid #f59e0b}
.top{display:flex;justify-content:space-between;gap:10px}
.co{font-weight:bold;font-size:15px}
.tg{font-size:9px;font-weight:bold;margin-left:6px;padding:2px 7px;border-radius:9px}
.tg.won{background:#14532d;color:#4ade80}
.tg.mult{background:#3f2d0f;color:#fbbf24}
.who{color:#94a3b8;font-size:11.5px;margin-top:3px}
.dt{color:#64748b;font-size:10.5px;white-space:nowrap}
.ct{margin-top:8px;font-size:12.5px}
.ct a{color:#60a5fa;text-decoration:none}
.sj{color:#cbd5e1;font-size:12px;font-style:italic;margin-top:6px}
.ex{background:#0f172a;border-radius:7px;padding:9px 11px;margin-top:6px;font-size:12px;line-height:1.5;color:#cbd5e1}
.ft{color:#64748b;font-size:10.5px;margin-top:7px}
.empty{color:#64748b;font-size:13px}
</style>
<h1>Hot list &mdash; ${hot.length}</h1>
<div class="lede">Everyone who has ever replied. This list is permanent &mdash; it survives the annual campaign reset, so next year these prospects get worked first and the email can open with "we spoke last year" instead of a cold introduction.</div>
${cards}
</body></html>`;
        res.writeHead(200, HTML_HEADERS);
        res.end(html);
        return;
      }

      if (req.method === "GET" && (req.url === "/daily" || req.url.startsWith("/daily?"))) {
        const u2 = new URL(req.url, "http://x");
        const openDay = u2.searchParams.get("d");

        const SENDER_CUTOVER = process.env.SENDER_CUTOVER || "2026-08-07T00:00:00Z";
        const leads = getLeads();
        const byEmail = new Map();
        for (const l of leads) byEmail.set((l.email || "").toLowerCase(), l);

        const repliedSet = new Set();
        for (const r of getReplies()) repliedSet.add((r.email || "").toLowerCase());
        for (const l of leads) {
          if (l.status === "replied" || l.repliedAt) repliedSet.add((l.email || "").toLowerCase());
        }

        // Group every send by the calendar day it went out, in Eastern time —
        // batches fire at 9:46 AM ET, so grouping by UTC would split a single
        // morning's run across two dates.
        const days = new Map();
        for (const t of getTouchlog()) {
          if (!t.ts) continue;
          const et = new Date(new Date(t.ts).toLocaleString("en-US", { timeZone: "America/New_York" }));
          const key = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
          if (!days.has(key)) days.set(key, []);
          days.get(key).push(t);
        }

        const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
        const keys = [...days.keys()].sort().reverse();

        const blocks = keys.map((key) => {
          const sends = days.get(key).slice().sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
          const authenticated = key >= SENDER_CUTOVER.slice(0, 10);
          const cancels = sends.filter((s) => s.cancellation).length;
          const followups = sends.filter((s) => s.touchType && s.touchType !== "cold").length;
          const replied = sends.filter((s) => repliedSet.has((s.email || "").toLowerCase())).length;

          const d = new Date(key + "T12:00:00");
          const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
          const isOpen = openDay === key;

          const detail = isOpen
            ? `<div class="detail">${sends
                .map((s) => {
                  const lead = byEmail.get((s.email || "").toLowerCase()) || {};
                  const rep = repliedSet.has((s.email || "").toLowerCase());
                  return `<div class="line${rep ? " rep" : ""}">
                    <div class="l1"><b>${esc(s.company || "—")}</b>${rep ? '<span class="tg rep">REPLIED</span>' : ""}${
                    s.cancellation ? '<span class="tg can">CANCEL</span>' : ""
                  }${s.touchType && s.touchType !== "cold" ? `<span class="tg fu">${esc(s.touchType)}</span>` : ""}</div>
                    <div class="l2">"${esc(s.subject || "")}"</div>
                    <div class="l3">${esc(s.email || "")}${lead.phone ? " &middot; " + esc(lead.phone) : ""}${
                    lead.state ? " &middot; " + esc(lead.state) : ""
                  }${s.renewalDate ? " &middot; renews " + esc(s.renewalDate) : ""} <span class="tm">${(s.ts || "").slice(11, 16)} UTC</span></div>
                  </div>`;
                })
                .join("")}</div>`
            : "";

          return `<div class="day">
            <a class="dh" href="/daily${isOpen ? "" : "?d=" + key}">
              <div class="dl">${label}${authenticated ? "" : '<span class="tg pre">pre-auth</span>'}</div>
              <div class="dn">
                <span class="big">${sends.length}</span> sent
                ${cancels ? `<span class="chip can">${cancels} cancel</span>` : ""}
                ${followups ? `<span class="chip fu">${followups} follow-up</span>` : ""}
                ${replied ? `<span class="chip rep">${replied} replied</span>` : ""}
                <span class="car">${isOpen ? "&#9662;" : "&#9656;"}</span>
              </div>
            </a>
            ${detail}
          </div>`;
        });

        const totalSends = [...days.values()].reduce((n, v) => n + v.length, 0);
        const activeDays = keys.length;

        const html =
          pageHead("Daily", "/daily") +
          `
<style>
.hint{color:#64748b;font-size:11.5px;margin-bottom:12px}
.tot{display:flex;gap:8px;margin-bottom:14px}
.tot div{background:#1e2937;border-radius:9px;padding:10px 13px;flex:1}
.tot .n{font-size:20px;font-weight:bold;color:#60a5fa}
.tot .l{color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.day{margin-bottom:8px}
.dh{display:block;background:#1e2937;border-radius:9px;padding:11px 13px;text-decoration:none;color:#e2e8f0}
.dl{font-weight:700;font-size:14.5px}
.dn{color:#94a3b8;font-size:12px;margin-top:4px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.big{color:#e2e8f0;font-weight:bold;font-size:15px}
.chip{font-size:10px;font-weight:bold;padding:2px 7px;border-radius:9px}
.chip.can{background:#450a0a;color:#f87171}
.chip.fu{background:#1e3a5f;color:#93c5fd}
.chip.rep{background:#14532d;color:#4ade80}
.car{margin-left:auto;color:#64748b}
.detail{margin-top:6px;padding-left:8px;border-left:2px solid #334155}
.line{background:#161f2e;border-radius:7px;padding:9px 11px;margin-bottom:5px}
.line.rep{border-left:3px solid #4ade80}
.l1{font-size:13.5px}
.l2{color:#cbd5e1;font-size:12px;font-style:italic;margin-top:2px}
.l3{color:#94a3b8;font-size:10.5px;margin-top:3px;word-break:break-word}
.tm{color:#64748b}
.tg{font-size:9px;font-weight:bold;margin-left:6px;padding:2px 6px;border-radius:9px}
.tg.rep{background:#14532d;color:#4ade80}
.tg.can{background:#450a0a;color:#f87171}
.tg.fu{background:#1e3a5f;color:#93c5fd}
.tg.pre{background:#3f2d0f;color:#fbbf24;font-weight:600}
</style>
<h1>Daily sends</h1>
<div class="hint">Tap a day to see every email that went out</div>
<div class="tot">
  <div><div class="n">${totalSends.toLocaleString()}</div><div class="l">Total sent</div></div>
  <div><div class="n">${activeDays}</div><div class="l">Sending days</div></div>
  <div><div class="n">${repliedSet.size}</div><div class="l">Replies</div></div>
</div>
${blocks.join("")}
</body></html>`;
        res.writeHead(200, HTML_HEADERS);
        res.end(html);
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

        const html = pageHead("Activity", "/activity") + `
<style>
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px;margin-bottom:14px}
.stat{background:#1e2937;border-radius:9px;padding:11px 13px}
.stat .n{font-size:21px;font-weight:bold}
.stat .n.g{color:#4ade80}.stat .n.b{color:#60a5fa}.stat .n.r{color:#f87171}
.stat .l{color:#94a3b8;font-size:10.5px;margin-top:2px;text-transform:uppercase;letter-spacing:.5px}
.sub0{color:#64748b;font-size:11.5px;margin-bottom:12px}
.tabs{display:flex;gap:7px;margin-bottom:12px;flex-wrap:wrap}
.tab{background:#1e2937;color:#94a3b8;padding:6px 12px;border-radius:14px;font-size:12px;text-decoration:none}
.tab.on{background:#334155;color:#e2e8f0}
form{margin-bottom:12px}
input[name=q]{width:100%;padding:9px 12px;border-radius:8px;border:1px solid #334155;background:#1e2937;color:#e2e8f0;font-size:16px}
.row{background:#1e2937;border-radius:9px;padding:11px 13px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px}
.row.replied{border-left:3px solid #4ade80}
.co{font-weight:bold;font-size:14.5px}
.tag{font-size:9px;font-weight:bold;margin-left:6px;padding:2px 6px;border-radius:9px;vertical-align:middle;white-space:nowrap}
.tag.rep{background:#14532d;color:#4ade80}.tag.can{background:#450a0a;color:#f87171}.tag.out{background:#1e3a5f;color:#93c5fd}
.sub{color:#cbd5e1;font-size:12.5px;margin-top:3px;font-style:italic}
.meta{color:#94a3b8;font-size:11px;margin-top:2px;word-break:break-word}
.side{text-align:right;white-space:nowrap;flex:0 0 auto}
.when{color:#64748b;font-size:10.5px}.ren{color:#94a3b8;font-size:10.5px;margin-top:2px}
.btn{display:inline-block;margin-top:6px;background:#15803d;color:#fff;padding:5px 11px;border-radius:6px;font-size:11.5px;text-decoration:none}
.empty{color:#64748b;font-size:13px}
.lookup{margin-bottom:12px}
.lookup input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#1e2937;color:#e2e8f0;font-size:16px;font-family:inherit}
.dealform{margin-top:11px;border-top:1px solid #334155;padding-top:11px}
.fld{margin-bottom:8px}
.fld label{display:block;color:#94a3b8;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.fld input{width:100%;padding:9px 11px;border-radius:7px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:16px;font-family:inherit}
.fbtns{display:flex;gap:7px;margin-top:10px}
.wp{color:#4ade80;font-weight:bold}
</style>
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

</body></html>`;
        res.writeHead(200, HTML_HEADERS);
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
        const html = pageHead("Replies", "/replies") +
          `<h1>Replies (${replies.length})</h1>` +
          `<p style="color:#64748b;font-size:11.5px;margin:4px 0 14px">Newest first &middot; tap an address to reply</p>` +
          cards + `</body></html>`;
        res.writeHead(200, HTML_HEADERS);
        res.end(html);
        return;
      }

      if (req.method === "GET" && (req.url === "/demo" || req.url === "/demo/")) {
        try {
          const html = fs.readFileSync(path.join(__dirname2, "demo.html"), "utf8");
          res.writeHead(200, HTML_HEADERS);
          res.end(html);
        } catch { res.writeHead(404); res.end("demo not found"); }
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/check-replies")) {
        const u = new URL(req.url, "http://x");
        const days = Math.min(parseInt(u.searchParams.get("days") || "2"), 30);
        const result = await checkGmailReplies(days);
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/audit")) {
        // /audit            -> preview only, changes nothing
        // /audit?apply=true -> repair + suppress + persist
        const u = new URL(req.url, "http://x");
        const apply = u.searchParams.get("apply") === "true";
        const report = await auditLeads({ apply });
        res.writeHead(200, JSON_HEADERS);
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
          res.writeHead(200, JSON_HEADERS);
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
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ started: true, limit, note: "check /health and Brevo in ~1 min" }));
        runColdBatch({ maxSends: limit }).catch((e) => log.error(`Manual cold batch: ${e.message}`));
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/opens")) {
        // Open + deliverability numbers straight from Brevo, per day. The
        // dashboard tracks sends and replies locally, but opens only exist
        // Brevo-side — and the old getBrevoStats() read totals off what is
        // actually a per-day array, so it always returned zeros. Reads the
        // account's own BREVO_API_KEY from env; never exposes the key.
        try {
          const u = new URL(req.url, "http://x");
          const days = Math.min(parseInt(u.searchParams.get("days") || "14"), 30);
          const end = new Date().toISOString().slice(0, 10);
          const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
          const rr = await fetch(
            `https://api.brevo.com/v3/statistics/reports?startDate=${start}&endDate=${end}&type=transactional`,
            { headers: { accept: "application/json", "api-key": process.env.BREVO_API_KEY } }
          );
          const j = await rr.json();
          const rows = (j.reports || []).sort((a, b) => (a.date < b.date ? 1 : -1));
          const tot = rows.reduce((t, d) => {
            for (const k of ["requests", "delivered", "uniqueOpens", "opens", "hardBounces", "softBounces", "unsubscribed", "spamReports"]) {
              t[k] = (t[k] || 0) + (d[k] || 0);
            }
            return t;
          }, {});
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify({
            window: `${start} → ${end}`,
            totals: {
              ...tot,
              deliveryRate: tot.requests ? ((tot.delivered / tot.requests) * 100).toFixed(1) + "%" : "n/a",
              uniqueOpenRate: tot.delivered ? (((tot.uniqueOpens || tot.opens || 0) / tot.delivered) * 100).toFixed(1) + "%" : "n/a",
            },
            byDay: rows,
          }, null, 2));
        } catch (e) {
          res.writeHead(500, JSON_HEADERS);
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (req.method === "GET" && req.url === "/seedtest") {
        // Fire the seed emails on demand, then check those inboxes by hand.
        try {
          const r = await runSeedTest();
          res.writeHead(200, JSON_HEADERS);
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
          res.writeHead(r.ok ? 200 : 400, HTML_HEADERS);
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
          res.writeHead(200, JSON_HEADERS);
          res.end(JSON.stringify(r, null, 2));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.method === "GET" && req.url === "/debug-selection") {
        // Shows exactly who the RUNNING code would send cold email to, so a
        // selection bug can be confirmed without sending anything.
        const all = getLeads();
        const hot = getHotWindowLeads(all);
        const byStatus = {};
        for (const l of hot) byStatus[l.status || "(none)"] = (byStatus[l.status || "(none)"] || 0) + 1;
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({
          totalLeads: all.length,
          eligibleForCold: hot.length,
          eligibleByStatus: byStatus,
          shouldOnlyBe: "new",
          bugPresent: Object.keys(byStatus).some((s) => s !== "new"),
          firstFive: hot.slice(0, 5).map((l) => ({ company: l.company, status: l.status, lastContacted: l.lastContacted })),
        }, null, 2));
        return;
      }

      if (req.method === "GET" && req.url === "/test-persist") {
        const ok = await persistLeadsToGitHub("Persistence test from /test-persist");
        res.writeHead(200, JSON_HEADERS);
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
