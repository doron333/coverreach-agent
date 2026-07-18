import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPLIES_PATH = path.join(__dirname, "../data/replies.json");

/**
 * CRM REPLY LOGGING
 * ==================
 * When a customer replies, two things happen:
 *
 * 1. BREVO CRM — the contact is created/updated in Brevo with:
 *      - COMPANY, REPLIED_AT, LAST_REPLY (excerpt), RENEWAL_DATE
 *      - added to the "Replied Leads" list (auto-created on first use)
 *    → In Brevo: Contacts → filter by list "Replied Leads" = your live
 *      pipeline of everyone who has responded.
 *
 * 2. REPLIES LOG — data/replies.json gets a permanent entry
 *    (persisted to GitHub with the rest of the state).
 *    → Viewable anytime at:  https://<railway-url>/replies
 */

let cachedListId = null;

async function brevoApi(pathname, method = "GET", body = null) {
  const res = await fetch(`https://api.brevo.com/v3${pathname}`, {
    method,
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  return { ok: res.ok, status: res.status, data };
}

/** Find or create the "Replied Leads" contact list */
async function getRepliedListId() {
  if (cachedListId) return cachedListId;

  const { ok, data } = await brevoApi("/contacts/lists?limit=50");
  if (ok && data.lists) {
    const existing = data.lists.find((l) => l.name === "Replied Leads");
    if (existing) {
      cachedListId = existing.id;
      return cachedListId;
    }
  }

  // Need a folder id to create a list — grab the first folder
  const folders = await brevoApi("/contacts/folders?limit=10");
  const folderId = folders.data?.folders?.[0]?.id || 1;

  const created = await brevoApi("/contacts/lists", "POST", {
    name: "Replied Leads",
    folderId,
  });
  if (created.ok) {
    cachedListId = created.data.id;
    log.success(`Created Brevo list "Replied Leads" (id ${cachedListId})`);
    return cachedListId;
  }

  log.warn(`Could not create Brevo list: ${JSON.stringify(created.data).slice(0, 120)}`);
  return null;
}

/** Log a reply into Brevo CRM: upsert contact + attributes + list membership */
export async function logReplyToCRM(lead, replyText, subject) {
  try {
    const listId = await getRepliedListId();

    const attributes = {
      COMPANY: (lead.company || "").slice(0, 200),
      REPLIED_AT: new Date().toISOString().slice(0, 10),
      LAST_REPLY: (replyText || "").slice(0, 500),
      RENEWAL_DATE: lead.renewalDate || "",
    };

    // Upsert the contact
    const create = await brevoApi("/contacts", "POST", {
      email: lead.email,
      attributes,
      listIds: listId ? [listId] : undefined,
      updateEnabled: true,
    });

    if (create.ok || create.status === 204) {
      log.success(`CRM: logged reply for ${lead.company} → Brevo contact updated + "Replied Leads" list`);
      return true;
    }
    log.warn(`CRM upsert issue for ${lead.email}: ${JSON.stringify(create.data).slice(0, 120)}`);
    return false;
  } catch (err) {
    log.error(`CRM logging failed: ${err.message}`);
    return false;
  }
}

/** Append to the permanent local replies log (persisted to GitHub) */
export function logReplyLocally(lead, replyText, subject) {
  try {
    let replies = [];
    if (fs.existsSync(REPLIES_PATH)) {
      try { replies = JSON.parse(fs.readFileSync(REPLIES_PATH, "utf8")); } catch {}
    }
    replies.push({
      ts: new Date().toISOString(),
      campaign: lead.currentCampaign || "unknown",
      email: lead.email,
      company: lead.company,
      name: lead.name || "",
      phone: lead.phone || "",
      renewalDate: lead.renewalDate || null,
      cancellation: lead.cancellation || null,
      subject,
      reply: (replyText || "").slice(0, 2000),
    });
    fs.writeFileSync(REPLIES_PATH, JSON.stringify(replies, null, 2));
  } catch (err) {
    log.error(`Local reply log failed: ${err.message}`);
  }
}

export function getReplies() {
  try {
    if (fs.existsSync(REPLIES_PATH)) {
      return JSON.parse(fs.readFileSync(REPLIES_PATH, "utf8"));
    }
  } catch {}
  return [];
}
