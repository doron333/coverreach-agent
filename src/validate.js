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

  if (/[;,/|\s]/.test(e)) {
    const parts = e.split(/[;,/|\s]+/).filter(Boolean);
    const withAt = parts.filter(p => p.includes("@"));

    if (withAt.length <= 1) {
      // Only one fragment has an "@", so the separators are typos INSIDE a
      // single address ("tap transport llc@x.com", "name@gmail. com").
      // Join everything — picking one fragment would invent a wrong address.
      const joined = e.replace(/[\s/|]+/g, "");
      e = SYNTAX.test(joined) ? joined : joined.replace(/,/g, ".");
    } else {
      // Genuinely multiple addresses in one cell — take the FIRST complete one.
      const firstComplete = parts.find(p => SYNTAX.test(p.replace(/[.,;]+$/, "")));
      e = firstComplete ? firstComplete.replace(/[.,;]+$/, "") : withAt[0];
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

  // Returns: true = deliverable, false = definitively dead, null = unknown.
  // IMPORTANT: a DNS timeout is NOT proof a domain is dead. An audit on 7/22
  // found 152 of 175 "dead" domains were just slow lookups — permanently
  // suppressing those would have destroyed valid prospects. Only NXDOMAIN
  // (the domain does not exist) is treated as fatal.
  let result = null;
  for (const rec of ["MX", "A"]) {
    try {
      const ans = await dns.resolve(domain, rec);
      if (Array.isArray(ans) && ans.length > 0) { result = true; break; }
    } catch (err) {
      if (err && err.code === "ENOTFOUND") { result = false; break; }  // NXDOMAIN
      // ETIMEOUT / ESERVFAIL / ENODATA → inconclusive, try next record type
    }
  }
  if (result !== null) mxCache.set(domain, result);
  return result;
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
  if (live === false) return { ok: false, email, reason: "no_mail_server" };
  // live === null means the lookup was inconclusive (timeout). Send anyway —
  // a soft bounce is far cheaper than permanently deleting a real prospect.
  return { ok: true, email, reason: live === null ? "unverified_dns" : "valid" };
}

export function validationStats() {
  return { domainsChecked: mxCache.size };
}
