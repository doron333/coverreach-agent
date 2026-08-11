import { log } from "./logger.js";

/**
 * GOOGLE POSTMASTER TOOLS
 * =======================
 * Gmail is ~70% of the lead list and opens at roughly 1%, while every other
 * provider opens at 8-14%. That gap is the whole deliverability problem, and
 * until now we have only been able to infer it from a handful of opens.
 *
 * Postmaster Tools is Google reporting on us directly: domain reputation,
 * spam complaint rate, authentication pass rates, delivery errors. This
 * module reads that API so the numbers land in the dashboard instead of
 * living in a separate browser tab.
 *
 * SETUP (one time, in Google Cloud Console with the account that verified
 * the domain at postmaster.google.com):
 *   1. Create a project
 *   2. Enable "Gmail Postmaster Tools API"
 *   3. Create an OAuth 2.0 Client ID, application type "Desktop app"
 *   4. Run: node scripts/postmaster-auth.js   and follow the prompts
 *   5. Put the three values it prints into Railway:
 *        PM_CLIENT_ID, PM_CLIENT_SECRET, PM_REFRESH_TOKEN
 *
 * Note: Google suppresses this data below meaningful daily volume to the
 * same provider. At 40/day the dashboard will look empty; expect real
 * numbers once the warm-up ramp reaches 150-250/day.
 */

const API = "https://gmailpostmastertools.googleapis.com/v1";
const DOMAIN = process.env.PM_DOMAIN || "outreach.centraljerseyins.com";

let cachedToken = null;
let cachedUntil = 0;

export function postmasterConfigured() {
  return !!(process.env.PM_CLIENT_ID && process.env.PM_CLIENT_SECRET && process.env.PM_REFRESH_TOKEN);
}

/** Exchanges the long-lived refresh token for a short-lived access token. */
async function accessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  if (!postmasterConfigured()) throw new Error("PM_CLIENT_ID / PM_CLIENT_SECRET / PM_REFRESH_TOKEN not set");

  const body = new URLSearchParams({
    client_id: process.env.PM_CLIENT_ID,
    client_secret: process.env.PM_CLIENT_SECRET,
    refresh_token: process.env.PM_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const json = await res.json();
  cachedToken = json.access_token;
  // Refresh a minute early so a request never races the expiry.
  cachedUntil = Date.now() + (json.expires_in || 3600) * 1000 - 60000;
  return cachedToken;
}

async function apiGet(path) {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;             // no data for that day yet
  if (!res.ok) throw new Error(`Postmaster ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Domains registered under this account. */
export async function listDomains() {
  const r = await apiGet("/domains");
  return (r && r.domains) || [];
}

/**
 * Traffic stats for the last N days. Google publishes with roughly a day of
 * lag and skips days with insufficient volume, so gaps are expected and are
 * reported rather than hidden.
 */
export async function getTrafficStats(days = 14) {
  const out = [];
  const domainKey = encodeURIComponent(DOMAIN);

  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    try {
      const r = await apiGet(`/domains/${domainKey}/trafficStats/${key}`);
      if (!r) continue;
      out.push({
        date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
        domainReputation: r.domainReputation || null,
        ipReputations: r.ipReputations || [],
        // Google reports rates as fractions.
        spamRate: r.userReportedSpamRatio != null ? r.userReportedSpamRatio : null,
        spfSuccess: r.spfSuccessRatio != null ? r.spfSuccessRatio : null,
        dkimSuccess: r.dkimSuccessRatio != null ? r.dkimSuccessRatio : null,
        dmarcSuccess: r.dmarcSuccessRatio != null ? r.dmarcSuccessRatio : null,
        inboundEncryption: r.inboundEncryptionRatio != null ? r.inboundEncryptionRatio : null,
        deliveryErrors: r.deliveryErrors || [],
      });
    } catch (err) {
      log.error(`Postmaster ${key}: ${err.message}`);
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Most recent day with data, plus a plain-language read of it. */
export async function getReputationSummary() {
  if (!postmasterConfigured()) {
    return { configured: false, message: "Postmaster credentials not set in Railway" };
  }

  const stats = await getTrafficStats(14);
  if (!stats.length) {
    return {
      configured: true,
      hasData: false,
      message:
        "Verified, but Google has not published data yet. It suppresses reporting below meaningful daily volume — expect numbers once the ramp reaches 150-250/day.",
    };
  }

  const latest = stats[0];
  const rep = latest.domainReputation;
  const verdict =
    rep === "HIGH"
      ? "Strong. Mail should be reaching inboxes."
      : rep === "MEDIUM"
      ? "Acceptable, but not yet trusted. Keep volume steady and complaints low."
      : rep === "LOW"
      ? "Weak. A meaningful share is likely going to spam."
      : rep === "BAD"
      ? "Poor. Most mail is being filtered. Reduce volume and review list quality."
      : "Not yet graded.";

  return { configured: true, hasData: true, domain: DOMAIN, latest, history: stats, verdict };
}
