import { log } from "./logger.js";
import { markUnsubscribed, markBounced } from "./leads.js";
import { listUnsubHeaders, unsubscribeUrl } from "./unsubscribe.js";

// ── Multi-sender rotation (redundancy) ────────────────────────────────────────
// One mailbox on one domain is a single point of failure — a reputation event
// takes the whole operation down (see: Resend termination, 8/16 audit). When
// more verified senders exist, set SENDERS in Railway as JSON, e.g.
//   SENDERS=[{"email":"rich@outreach.centraljerseyins.com","name":"Rich Doron","cap":40},
//            {"email":"rich@quotes.centraljerseyins.com","name":"Rich Doron","cap":40}]
// Every address MUST be a verified sender on an authenticated domain in this
// Brevo account, or Brevo rejects the send. Until SENDERS is set, behavior is
// identical to before: single sender from OUTREACH_FROM_EMAIL.
//
// Assignment is deterministic per prospect (same seed trick as the unsub
// variants) so a given prospect's entire sequence comes from ONE identity —
// switching senders mid-sequence breaks threading and looks like spoofing.
// If a prospect's assigned sender has hit its daily cap, the next sender with
// capacity takes the send.
let SENDER_POOL = null;
function senderPool() {
  if (SENDER_POOL) return SENDER_POOL;
  try {
    const raw = process.env.SENDERS;
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length && arr.every(s => s && s.email)) {
        SENDER_POOL = arr.map(s => ({
          email: s.email,
          name: s.name || process.env.SENDER_NAME || "Rich Doron",
          cap: parseInt(s.cap) > 0 ? parseInt(s.cap) : 40,
        }));
        log.info(`Sender pool: ${SENDER_POOL.length} senders (${SENDER_POOL.map(s => s.email).join(", ")})`);
        return SENDER_POOL;
      }
    }
  } catch (e) {
    log.error(`SENDERS env is not valid JSON — falling back to single sender: ${e.message}`);
  }
  SENDER_POOL = [{
    email: process.env.OUTREACH_FROM_EMAIL || "rich@outreach.centraljerseyins.com",
    name: process.env.SENDER_NAME || "Rich Doron",
    cap: Infinity,
  }];
  return SENDER_POOL;
}

const senderCounts = new Map(); // "YYYY-MM-DD|email" -> sends today
function etDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function pickSender(to) {
  const pool = senderPool();
  const day = etDateStr();
  const seed = String(to).split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
  for (let i = 0; i < pool.length; i++) {
    const s = pool[(seed + i) % pool.length];
    if ((senderCounts.get(`${day}|${s.email}`) || 0) < s.cap) return s;
  }
  // All senders at cap — the warm-up budget is the real volume limiter, so
  // fall back to the prospect's home sender rather than dropping the send.
  return pool[seed % pool.length];
}
function noteSend(s) {
  const key = `${etDateStr()}|${s.email}`;
  senderCounts.set(key, (senderCounts.get(key) || 0) + 1);
}

async function brevoSend(to, subject, body) {
  // Prospect mail goes from the AUTHENTICATED domain (SPF + DKIM + DMARC all
  // aligned as of 8/7). Sending as @gmail.com through Brevo failed
  // authentication and landed in spam — that was the cause of ~0% opens and
  // zero replies across the first 1,100+ sends. Do not point this back at a
  // free mailbox. Internal notifications still go to YOUR_EMAIL.
  const chosen = pickSender(to);
  const fromEmail = chosen.email;
  const fromName  = chosen.name;

  // Replies must still reach Rich's inbox, which is where the IMAP watcher looks.
  // 9/6 audit: From is @outreach.centraljerseyins.com but Reply-To is a
  // @gmail.com address — a domain mismatch some filters score against. Once a
  // mailbox like rich@outreach.centraljerseyins.com exists and FORWARDS to the
  // watched Gmail inbox, set REPLY_TO_EMAIL to it and the mismatch goes away
  // without breaking reply capture. Do not set it before forwarding works.
  const replyTo = process.env.REPLY_TO_EMAIL || process.env.GMAIL_USER || process.env.YOUR_EMAIL;

  // Gmail fingerprints message bodies. An identical opt-out line on every send
  // is the single strongest match anchor we control — roughly 1,150 messages
  // carrying this exact string were spam-filed before the domain was
  // authenticated, and that learned pattern followed the content to the new
  // domain. Rotating the wording breaks the fingerprint while keeping a clear,
  // CAN-SPAM compliant opt-out on every message.
  const UNSUB_VARIANTS = [
    "\n\nIf you'd rather not hear from me, just reply STOP.",
    "\n\nNot interested? Reply STOP and I won't follow up.",
    "\n\nReply STOP if you'd like me to take you off my list.",
    "\n\nIf this isn't useful, reply STOP and I'll leave you alone.",
    "\n\nDon't want these? Just reply STOP.",
    "\n\nReply STOP any time and I'll stop reaching out.",
  ];
  // Deterministic per recipient, so a given prospect always sees the same
  // wording across their sequence, but a batch is varied.
  const seed = String(to).split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const unsubLine = UNSUB_VARIANTS[seed % UNSUB_VARIANTS.length];

  // CAN-SPAM requires a valid physical postal address on commercial email.
  // It also helps deliverability — filters treat a real address as a
  // legitimacy signal, and we had none until now.
  // NOTE: centraljerseyins.com lists two different Medford addresses across
  // its own pages (205 Tuckerton Rd Suite 206 on /contact, 180 Tuckerton Rd
  // Unit 8 elsewhere). Confirm with Rich and correct POSTAL_ADDRESS if needed.
  const POSTAL_ADDRESS = process.env.POSTAL_ADDRESS ||
    "Central Jersey Insurance Associates, 205 Tuckerton Rd., Suite 206, Medford, NJ 08055";
  // Vary the presentation so the footer itself does not become a fingerprint.
  const ADDR_FORMATS = [
    `\n${POSTAL_ADDRESS}`,
    `\n\n${POSTAL_ADDRESS}`,
    `\n--\n${POSTAL_ADDRESS}`,
  ];
  const addrLine = ADDR_FORMATS[seed % ADDR_FORMATS.length];

  const payload = {
    sender: { name: fromName, email: fromEmail },
    replyTo: { email: replyTo, name: fromName },
    to: [{ email: to }],
    // BCC removed 7/18: was doubling Brevo credit burn (every prospect email
    // also sent a copy to Richard). Visibility now comes from the touch log,
    // /replies dashboard, daily summary, and hot-lead alerts instead.
    subject,
    textContent: body + unsubLine + addrLine,
    // Gmail and Yahoo have required one-click unsubscribe headers from bulk
    // senders since Feb 2024. Without them we are treated as not following
    // bulk-sender rules, which costs inbox placement. This also gives Gmail's
    // native Unsubscribe control, so an uninterested recipient taps that
    // instead of the spam button — a far cheaper outcome for us.
    headers: listUnsubHeaders(to),
  };

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // Brevo returns JSON on success and on most errors, but a 5xx or a quota
  // block can come back as a plain-text page. 9/6 audit: one send failed with
  // "Unexpected token I in JSON at position 0" — that was res.json() choking
  // on "Internal Server Error", which hid the real cause. Read text first.
  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { message: raw.slice(0, 200) || `HTTP ${res.status}` }; }

  if (!res.ok) {
    if (data.message && /blocked/i.test(data.message)) {
      markBounced(to);
      throw new Error(`Blocked/bounced: ${to}`);
    }
    throw new Error(`Brevo ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  noteSend(chosen);
  return data;
}

export async function sendEmail(to, subject, body) {
  try {
    const result = await brevoSend(to, subject, body);
    log.send(`✉  Sent → ${to} | "${subject}"`);
    return result;
  } catch (err) {
    log.error(`Brevo failed → ${to}: ${err.message}`);
    throw err;
  }
}

export async function checkForReply(fromEmail) {
  return null;
}

export async function sendNotification(subject, body) {
  try {
    const fromName = process.env.SENDER_NAME || "Richard Doron";
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "CoverReach Agent", email: process.env.YOUR_EMAIL },
        to: [{ email: process.env.YOUR_EMAIL }],
        subject,
        textContent: body,
      }),
    });
    const data = await res.json();
    if (!res.ok) log.error(`Notification failed: ${data.message}`);
  } catch (err) {
    log.error(`Notification error: ${err.message}`);
  }
}
