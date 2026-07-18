import fetch from "node-fetch";

const BREVO_API_KEY = process.env.BREVO_API_KEY;

/**
 * Fetch Brevo statistics using the reports endpoint (more reliable)
 */
export async function getBrevoStats() {
  if (!BREVO_API_KEY) {
    return {
      connected: false,
      message: "BREVO_API_KEY not set"
    };
  }

  try {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    // Using the reports endpoint which is more stable for many accounts
    const url = `https://api.brevo.com/v3/statistics/reports?startDate=${startDate}&endDate=${endDate}&type=transactional`;

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

    // Brevo reports structure can vary, so we handle it flexibly
    const sent = data?.requests || data?.total || 0;
    const delivered = data?.delivered || 0;
    const opens = data?.uniqueOpens || data?.opens || 0;
    const clicks = data?.clicks || 0;
    const bounces = data?.hardBounces || data?.bounces || 0;

    return {
      connected: true,
      sent,
      delivered,
      opens,
      clicks,
      bounces,
      unsubscribes: data?.unsubscriptions || 0,
      openRate: sent ? ((opens / sent) * 100).toFixed(1) + "%" : "0%",
      clickRate: sent ? ((clicks / sent) * 100).toFixed(1) + "%" : "0%"
    };

  } catch (err) {
    return {
      connected: false,
      message: err.message
    };
  }
}
