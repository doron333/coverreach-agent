import crypto from "crypto";
import { getLeads, saveLeads } from "./leads.js";
import { persistLeadsToGitHub } from "./persist.js";
import { log } from "./logger.js";

/**
 * ONE-CLICK UNSUBSCRIBE
 * ======================
 * Since February 2024 Gmail and Yahoo require bulk senders to support
 * one-click unsubscribe via the List-Unsubscribe and List-Unsubscribe-Post
 * headers. Without them a sender is treated as not following bulk-sender
 * rules, which costs inbox placement — and a plain "reply STOP" line in the
 * body does not satisfy the requirement.
 *
 * With the headers present, Gmail shows a native Unsubscribe control next to
 * the sender name. That is worth more than it looks: it gives an uninterested
 * recipient a one-tap exit instead of the spam button, and a spam complaint
 * hurts far more than an unsubscribe.
 *
 * Links are signed so the endpoint cannot be used to unsubscribe arbitrary
 * addresses by guessing URLs.
 */

function secret() {
  // Falls back to another server-side secret so this still works if a
  // dedicated key was never set. Never derived from anything public.
  return process.env.UNSUB_SECRET || process.env.BREVO_API_KEY || "coverreach-fallback";
}

export function unsubToken(email) {
  return crypto
    .createHmac("sha256", secret())
    .update(String(email).trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

export function unsubscribeUrl(email) {
  const base = process.env.PUBLIC_URL || "https://coverreach-agent-production.up.railway.app";
  const e = Buffer.from(String(email).trim().toLowerCase()).toString("base64url");
  return `${base}/unsubscribe?e=${e}&t=${unsubToken(email)}`;
}

/** Headers that make us a compliant bulk sender. */
export function listUnsubHeaders(email) {
  const mailto = process.env.UNSUB_MAILTO || "unsubscribe@outreach.centraljerseyins.com";
  return {
    "List-Unsubscribe": `<${unsubscribeUrl(email)}>, <mailto:${mailto}?subject=unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Handles both the one-click POST from a mail client and a plain GET from a
 * browser. Returns a short HTML confirmation either way.
 */
export async function handleUnsubscribe(url) {
  const u = new URL(url, "http://x");
  const e = u.searchParams.get("e");
  const t = u.searchParams.get("t");
  if (!e || !t) return { ok: false, reason: "missing parameters" };

  let email;
  try {
    email = Buffer.from(e, "base64url").toString("utf8").trim().toLowerCase();
  } catch {
    return { ok: false, reason: "bad address" };
  }

  if (t !== unsubToken(email)) return { ok: false, reason: "invalid signature" };

  const leads = getLeads();
  const lead = leads.find((l) => (l.email || "").toLowerCase() === email);

  if (lead) {
    lead.status = "unsubscribed";
    lead.campaignEligible = false;
    lead.currentCampaign = null;
    lead.unsubscribedAt = new Date().toISOString();
    if (!lead.history) lead.history = [];
    lead.history.push({ type: "unsubscribed", via: "one_click", ts: lead.unsubscribedAt });
    saveLeads(leads);
    await persistLeadsToGitHub(`One-click unsubscribe: ${lead.company || email}`).catch(() => {});
    log.info(`Unsubscribed via one-click: ${email}`);
  } else {
    // Honour it regardless — the address may have been seeded or forwarded.
    log.info(`One-click unsubscribe for unknown address: ${email}`);
  }

  return { ok: true, email };
}

export function unsubscribePage(ok, email) {
  const msg = ok
    ? `<h2>You're unsubscribed</h2><p>${email} won't receive any more email from us.</p>`
    : `<h2>Link not valid</h2><p>This unsubscribe link couldn't be verified. Reply STOP to any message and we'll remove you.</p>`;
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe</title><style>body{font-family:system-ui,Arial,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#1f2328;line-height:1.6}
h2{font-size:20px}p{color:#57606a}</style></head><body>${msg}
<p style="margin-top:28px;font-size:13px;color:#8b949e">Central Jersey Insurance Associates<br>205 Tuckerton Rd., Suite 206, Medford, NJ 08055</p>
</body></html>`;
}
