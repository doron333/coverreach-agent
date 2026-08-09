import { ImapFlow } from "imapflow";
import { log } from "./logger.js";

/**
 * READ-ONLY INBOX INSPECTION
 * ==========================
 * Lists recent messages in the watched mailbox. Purely diagnostic — used to
 * confirm that mail routed through Exchange transport rules, forwarders or
 * connectors is actually arriving, and to see what the sender address looks
 * like after any rewriting along the way.
 *
 * Opens the mailbox read-only so it cannot mark anything seen, which would
 * otherwise hide messages from the reply watcher.
 */
export async function listRecent({ limit = 25, folder = "INBOX", search = null } = {}) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD not set");

  const client = new ImapFlow({
    host: "imap.gmail.com", port: 993, secure: true,
    auth: { user, pass }, logger: false,
  });

  const out = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const criteria = search ? { header: { subject: search } } : { since };
      let uids = await client.search(criteria);
      if (!uids || !uids.length) return { folder, count: 0, messages: [] };
      uids = uids.slice(-limit);

      for await (const msg of client.fetch(uids, { envelope: true, flags: true })) {
        const env = msg.envelope || {};
        const from = (env.from && env.from[0]) || {};
        const to = (env.to || []).map((a) => a.address).join(", ");
        out.push({
          subject: env.subject || "(no subject)",
          from: from.address || "(unknown)",
          fromName: from.name || "",
          to,
          date: env.date ? new Date(env.date).toISOString() : null,
          seen: msg.flags ? msg.flags.has("\\Seen") : null,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  log.info(`Inbox inspection: ${out.length} message(s) in ${folder}`);
  return { folder, count: out.length, messages: out };
}
