import { ImapFlow } from "imapflow";
import { log } from "./logger.js";

/**
 * DELIVERABILITY SELF-TEST
 * =========================
 * Answers the one question the Brevo dashboard cannot: did the email land
 * in the INBOX or the SPAM folder, and what did the receiving provider
 * think of our authentication?
 *
 * "Delivered" in any ESP only means the receiving server accepted the
 * message. It says nothing about where the message was filed. This test
 * gets ground truth by sending a real email through the exact production
 * path and then reading it back over IMAP — including the
 * Authentication-Results header that Gmail stamps on every message, which
 * states plainly whether SPF, DKIM and DMARC passed.
 *
 * Re-run this after authenticating a sending domain to confirm the fix.
 */

function imapConfig() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return { host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false };
}

async function sendProbe(subject) {
  const apiKey = process.env.BREVO_API_KEY;
  // Must mirror gmail.js exactly, or this tests a path we don't actually use.
  const fromEmail = process.env.OUTREACH_FROM_EMAIL || "rich@outreach.centraljerseyins.com";
  const fromName = process.env.SENDER_NAME || "Rich Doron";
  const replyTo = process.env.GMAIL_USER || process.env.YOUR_EMAIL;
  const to = process.env.GMAIL_USER;

  // Deliberately mirrors a real outreach email — same sender, same plain-text
  // shape, same unsubscribe footer. Testing anything else tests nothing.
  const body =
    "Marion,\n\n" +
    "Your renewal with Ohio Casualty is coming up in August. I've been placing " +
    "truck coverage in Jersey for a long time.\n\n" +
    "Worth me taking a quick look before it renews?\n\n" +
    "Rich Doron\n(609) 757-2221\n\n" +
    "---\nTo unsubscribe reply with STOP or REMOVE.";

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: fromName, email: fromEmail },
      replyTo: { email: replyTo, name: fromName },
      to: [{ email: to }],
      subject,
      textContent: body,
    }),
  });
  if (!res.ok) throw new Error(`Brevo send failed ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).messageId;
}

function parseAuth(headerText) {
  const out = { spf: null, dkim: null, dmarc: null, raw: null };
  if (!headerText) return out;

  // Authentication-Results is almost always FOLDED across several lines with
  // leading whitespace. Unfold the whole header block first, otherwise we only
  // capture the first fragment and wrongly report spf/dmarc as missing.
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");

  // Gmail can stamp more than one Authentication-Results header. Take them all
  // and use whichever actually carries the verdicts.
  const lines = [];
  const re = /^authentication-results:\s*(.+)$/gim;
  let m;
  while ((m = re.exec(unfolded)) !== null) lines.push(m[1].trim());

  const best = lines.sort((a, b) =>
    (/dmarc=/.test(b) ? 2 : 0) + (/spf=/.test(b) ? 1 : 0) -
    ((/dmarc=/.test(a) ? 2 : 0) + (/spf=/.test(a) ? 1 : 0))
  )[0];

  if (!best) return out;
  out.raw = best.slice(0, 500);
  const grab = (k) => {
    const r = new RegExp(`\\b${k}=(\\w+)`, "i").exec(best);
    return r ? r[1].toLowerCase() : null;
  };
  out.spf = grab("spf");
  out.dkim = grab("dkim");
  out.dmarc = grab("dmarc");
  return out;
}

/**
 * Sends a probe and reports where it landed plus the auth verdict.
 * waitMs: how long to let delivery settle before looking (default 40s).
 */
export async function runDeliverabilityTest({ waitMs = 40000 } = {}) {
  const cfg = imapConfig();
  if (!cfg) throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  if (!process.env.BREVO_API_KEY) throw new Error("BREVO_API_KEY not set");

  const stamp = Date.now().toString(36);
  const subject = `deliverability probe ${stamp}`;

  log.info(`Deliverability test: sending probe "${subject}"`);
  const messageId = await sendProbe(subject);

  await new Promise((r) => setTimeout(r, waitMs));

  const client = new ImapFlow(cfg);
  await client.connect();

  const result = {
    subject,
    messageId,
    sentAs: process.env.OUTREACH_FROM_EMAIL || "rich@outreach.centraljerseyins.com",
    placement: "not_found",
    auth: { spf: null, dkim: null, dmarc: null, raw: null },
    checkedAt: new Date().toISOString(),
  };

  try {
    for (const folder of ["INBOX", "[Gmail]/Spam"]) {
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch {
        continue; // folder may not exist on this account
      }
      try {
        const uids = await client.search({ header: { subject } });
        if (uids && uids.length) {
          result.placement = folder === "INBOX" ? "INBOX" : "SPAM";
          const msg = await client.fetchOne(String(uids[uids.length - 1]), { headers: true });
          const headerText = msg?.headers?.toString() || "";
          result.auth = parseAuth(headerText);
          result.rawAuthHeaders = (headerText.match(/authentication-results:[\s\S]*?(?=\r?\n\S)/gi) || []).map(s => s.replace(/\s+/g, " ").slice(0, 400));
          break;
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  const a = result.auth;
  const passed = a.spf === "pass" && a.dkim === "pass" && a.dmarc === "pass";
  result.verdict =
    result.placement === "not_found"
      ? "Probe not found yet — it may still be in transit, or was rejected outright."
      : result.placement === "SPAM"
      ? "Landed in SPAM. Prospects are almost certainly not seeing these emails."
      : passed
      ? "Landed in INBOX with full authentication. Sending setup is healthy."
      : "Landed in INBOX, but authentication is incomplete — placement at other providers will be worse. Note that mail sent to your own address gets preferential treatment, so this is not proof of inbox placement for strangers.";

  log.info(`Deliverability test → ${result.placement} | spf=${a.spf} dkim=${a.dkim} dmarc=${a.dmarc}`);
  return result;
}
