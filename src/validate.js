import dns from "dns/promises";
import { log } from "./logger.js";

/**
 * PRE-SEND EMAIL VALIDATION
 * ==========================
 * Hard bounces are the single biggest threat to inbox placement. Mailbox
 * providers treat a bounce rate above ~2% as a spam signal; ours hit 13.5%
 * on 7/19, and open rates fell from 4.6% to 1.6% as reputation degraded.
 *
 * This gate runs before every send and catches the garbage that purchased
 * DOT lists are full of:
 *   - malformed addresses ("gmai.", "rockrun.c", "x@y.com (not dispatch)")
 *   - common domain typos (gmial.com, yaho.com)
 *   - domains with NO mail server (guaranteed hard bounce)
 *
 * It cannot detect a valid domain with a dead mailbox — that needs a paid
 * verification service. This is the free 80%.
 */

const SYNTAX = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

// Typos seen in the actual lead data
const TYPOS = {
  "gmai.com": "gmail.com", "gmial.com": "gmail.com", "gmail.co": "gmail.com",
  "gmaill.com": "gmail.com", "gnail.com": "gmail.com", "gamil.com": "gmail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.co": "yahoo.com",
  "hotmai.com": "hotmail.com", "hotmial.com": "hotmail.com",
  "outlook.co": "outlook.com", "aol.co": "aol.com", "comcast.ne": "comcast.net",
};

// Big providers we never need to look up
const KNOWN_GOOD = new Set([
  "gmail.com","yahoo.com","aol.com","hotmail.com","outlook.com","icloud.com",
  "comcast.net","verizon.net","msn.com","live.com","me.com","sbcglobal.net",
  "att.net","optonline.net","ymail.com","mail.com","protonmail.com","gmx.com",
]);

const mxCache = new Map();

/**
 * Clean up the mess that lives in purchased spreadsheets and return a single
 * sendable address. Handles: trailing notes, multiple addresses in one cell,
 * stray spaces, comma-for-dot typos, and common domain misspellings.
 */
export function normalizeEmail(email) {
  if (!email) return "";
  let e = String(email).trim().toLowerCase();

  // "info@x.com (not dispatch)" -> "info@x.com"
  e = e.replace(/\s*\(.*?\)\s*$/, "");
  // "www.example.com" with no @ is a website, not an address
  if (!e.includes("@")) return e;

  // Multiple addresses in one cell: take the first that looks complete
  if (/[;,\s]/.test(e)) {
    const parts = e.split(/[;,\s]+/).filter(Boolean);
    const firstComplete = parts.find(p => SYNTAX.test(p));
    if (firstComplete) {
      e = firstComplete;
    } else if (parts.length > 1 && parts.every(p => !p.includes("@")) === false) {
      // Likely a comma standing in for a dot: "user@yahoo,com"
      const rejoined = e.replace(/\s+/g, "").replace(/,/g, ".");
      e = SYNTAX.test(rejoined) ? rejoined : parts[0];
    } else {
      e = parts[0];
    }
  }

  e = e.replace(/\s+/g, "").replace(/[.,;]+$/, "");

  const at = e.lastIndexOf("@");
  if (at === -1) return e;
  const local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (TYPOS[domain]) domain = TYPOS[domain];
  return `${local}@${domain}`;
}

async function hasMailServer(domain) {
  if (KNOWN_GOOD.has(domain)) return true;
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok = false;
  try {
    const mx = await dns.resolveMx(domain);
    ok = Array.isArray(mx) && mx.length > 0;
  } catch {
    // No MX? Some tiny domains accept mail on the A record. Check that too.
    try {
      const a = await dns.resolve4(domain);
      ok = Array.isArray(a) && a.length > 0;
    } catch { ok = false; }
  }
  mxCache.set(domain, ok);
  return ok;
}

/**
 * Returns { ok, email, reason }.
 * `email` is the normalized address to actually send to.
 */
export async function validateEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, email, reason: "empty" };
  if (!SYNTAX.test(email)) return { ok: false, email, reason: "malformed" };

  const domain = email.split("@")[1];
  if (!domain || domain.endsWith(".") || domain.split(".").pop().length < 2) {
    return { ok: false, email, reason: "bad_domain" };
  }
  const live = await hasMailServer(domain);
  if (!live) return { ok: false, email, reason: "no_mail_server" };
  return { ok: true, email, reason: "valid" };
}

export function validationStats() {
  return { domainsChecked: mxCache.size };
}
