import fetch from "node-fetch";

const BREVO_API_KEY = process.env.BREVO_API_KEY;

/**
 * Get Brevo aggregated statistics for the last 30 days
 */
export async function getBrevoStats() {
  if (!BREVO_API_KEY) {
    return {
      connected: false,
      message: "BREVO_API_KEY not set in environment"
    };
  }

  try {
    // Calculate date range (last 30 days)
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const url = `https://api.brevo.com/v3/statistics/aggregatedReport?startDate=${startDate}&endDate=${endDate}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "api-key": BREVO_API_KEY
      }
    });

    if (!res.ok) {
      const errorText = await res.text();
      return {
        connected: false,
        message: `Brevo API error: ${res.status} - ${errorText}`
      };
    }

    const data = await res.json();

    return {
      connected: true,
      sent: data.requests || 0,
      delivered: data.delivered || 0,
      opens: data.uniqueOpens || data.opens || 0,
      clicks: data.clicks || 0,
      bounces: data.hardBounces || data.softBounces || 0,
      unsubscribes: data.unsubscriptions || 0,
      openRate: data.requests 
        ? (((data.uniqueOpens || data.opens || 0) / data.requests) * 100).toFixed(1) + "%" 
        : "0%",
      clickRate: data.requests 
        ? ((data.clicks || 0) / data.requests * 100).toFixed(1) + "%" 
        : "0%"
    };

  } catch (err) {
    return {
      connected: false,
      message: err.message
    };
  }
}
