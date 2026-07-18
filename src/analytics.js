import { getLeads } from "./leads.js";

/**
 * ANALYTICS MODULE
 * Provides useful stats for the dashboard and reporting.
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

  const stats = {
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

  return stats;
}

export function getRecentActivity(limit = 10) {
  const leads = getLeads();
  
  const activeLeads = leads
    .filter(l => l.lastContacted || l.repliedAt)
    .map(l => ({
      ...l,
      lastActivity: l.repliedAt || l.lastContacted,
      activityType: l.repliedAt ? "replied" : "contacted"
    }))
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
    .slice(0, limit);

  return activeLeads;
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