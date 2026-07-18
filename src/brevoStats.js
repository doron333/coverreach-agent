import fetch from "node-fetch";

const BREVO_API_KEY = process.env.BREVO_API_KEY;

/**
 * Brevo Statistics Helper
 * Fetches basic aggregated stats from Brevo
 */

export async function getBrevoStats() {
  if (!BREVO_API_KEY) {
    return {
      connected: false,
      message: "BREVO_API_KEY not set"
    };
  }

  try {
    // Get aggregated stats for the last 30 days
    const res = await fetch("https://api.brevo.com/v3/statistics/aggregatedReport", {
      method: "GET",
      headers: {
        "accept": "application/json",
        "api-key": BREVO_API_KEY
      }
    });

    if (!res.ok) {
      return {
        connected: false,
        message: `Brevo API error: ${res.status}`
      };
    }

    const data = await res.json();

    return {
      connected: true,
      sent: data.requests || 0,
      delivered: data.delivered || 0,
      opens: data.uniqueClicks || 0,           // Note: Brevo uses different naming
      clicks: data.clicks || 0,
      bounces: data.hardBounces || 0,
      unsubscribes: data.unsubscriptions || 0,
      openRate: data.uniqueClicks && data.requests 
        ? ((data.uniqueClicks / data.requests) * 100).toFixed(1) + "%" 
        : "0%",
      clickRate: data.clicks && data.requests 
        ? ((data.clicks / data.requests) * 100).toFixed(1) + "%" 
        : "0%"
    };

  } catch (err) {
    return {
      connected: false,
      message: err.message
    };
  }
}
