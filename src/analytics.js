import { getLeads } from "./leads.js";

/**
 * ANALYTICS MODULE - Sophisticated Dashboard Support
 */

export function getPipelineStats() {
  const leads = getLeads();

  const inWindow = (l) => {
    if (!l.renewalDate) return false;
    try {
      const [m, d, y] = l.renewalDate.split("/").map(Number);
      const renewal = new Date(y, m - 1, d);
      const days = Math.floor((renewal - Date.now()) / 86400000);
      if (l.cancellation) return days >= 0 && days <= 75;
      return days >= 30 && days <= 60;
    } catch {
      return false;
    }
  };

  return {
    totalLeads: leads.length,
    totalPipeline: leads.filter(l => l.status === "new" && l.email && l.email !== "null").length,
    inWindowNow: leads.filter(l => l.status === "new" && l.email && inWindow(l)).length,
    cancellationsInWindow: leads.filter(l => l.status === "new" && l.cancellation && inWindow(l)).length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
    bounced: leads.filter(l => l.status === "bounced").length,
    unsubscribed: leads.filter(l => l.status === "unsubscribed").length,
    noEmail: leads.filter(l => !l.email || l.email === "null" || l.status === "no_email").length,
    dualPitch: leads.filter(l => l.source === "njcrib_dot").length,
  };
}

export function getHotWindowBreakdown() {
  const leads = getLeads();
  const inWindow = (l) => {
    if (!l.renewalDate) return false;
    try {
      const [m, d, y] = l.renewalDate.split("/").map(Number);
      const renewal = new Date(y, m - 1, d);
      const days = Math.floor((renewal - Date.now()) / 86400000);
      if (l.cancellation) return days >= 0 && days <= 75;
      return days >= 30 && days <= 60;
    } catch {
      return false;
    }
  };

  const hotLeads = leads.filter(l => l.status === "new" && l.email && inWindow(l));

  return {
    total: hotLeads.length,
    cancellations: hotLeads.filter(l => l.cancellation).length,
    dualPitch: hotLeads.filter(l => l.source === "njcrib_dot").length,
    trucking: hotLeads.filter(l => !l.source || l.source === "dot").length,
    workersComp: hotLeads.filter(l => l.source === "njcrib").length,
  };
}

export function getRecentActivity(limit = 8) {
  const leads = getLeads();

  return leads
    .filter(l => l.lastContacted || l.repliedAt)
    .map(l => ({
      company: l.company,
      name: l.name,
      email: l.email,
      renewalDate: l.renewalDate,
      cancellation: l.cancellation,
      lastActivity: l.repliedAt || l.lastContacted,
      activityType: l.repliedAt ? "replied" : "contacted",
      source: l.source || "dot"
    }))
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
    .slice(0, limit);
}

export function getKeyInsights(stats, hot) {
  const insights = [];

  if (hot.cancellations > 10) {
    insights.push(`⚠️ High cancellation volume (${hot.cancellations} in window) — prioritize these leads.`);
  }
  if (stats.replied > 0 && stats.contacted > 0) {
    const rate = ((stats.replied / stats.contacted) * 100).toFixed(1);
    insights.push(`Reply rate so far: ${rate}% (${stats.replied} replies from ${stats.contacted} contacted).`);
  }
  if (hot.dualPitch > 5) {
    insights.push(`Strong dual-pitch opportunity: ${hot.dualPitch} leads need both WC + Trucking.`);
  }
  if (stats.inWindowNow === 0) {
    insights.push(`No leads currently in the 30-60 day window. Consider running nurture campaigns.`);
  }

  return insights.length > 0 ? insights : ["Pipeline looks healthy. Keep the momentum going."];
}