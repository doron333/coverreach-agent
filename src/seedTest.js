import { getLeads } from "./leads.js";
import { generateEmail } from "./claude.js";
import { sendEmail } from "./gmail.js";
import { log } from "./logger.js";

/**
 * SEED INBOX MONITORING
 * ======================
 * Nothing on the sending side can tell you whether a message landed in the
 * inbox or the spam folder. "Delivered" only means the receiving server
 * accepted it — Gmail accepts a message and then decides where to file it,
 * and that decision is invisible to the sender. Open rate is a lagging,
 * noisy proxy that needs a week of volume to read.
 *
 * The direct answer is to send yourself the same mail the prospects get and
 * look at where it lands. That is what this does: after each cold batch it
 * generates a real email for a real in-window lead and sends it to a small
 * set of monitored addresses, one per major provider.
 *
 * CRITICAL: the seed message must be IDENTICAL to production mail — same
 * generation path, same sender, same footer, no test markers. A message that
 * differs from what prospects receive tests nothing.
 *
 * Setup: create fresh mailboxes with no history (a Gmail, an Outlook, a
 * Yahoo) and set SEED_EMAILS in Railway, comma separated. Fresh accounts
 * matter — a mailbox that has already flagged this content will keep doing
 * so and tell you about its own learning rather than about placement.
 */

function seedAddresses() {
  return (process.env.SEED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
}

/** Picks leads that genuinely represent what is going out today. */
function representativeLeads(count) {
  const leads = getLeads();
  const inPlay = leads.filter((l) => l.status === "new" && l.email && l.renewalDate);
  if (!inPlay.length) return [];

  // Prefer variety: a cancellation, a plain renewal, an out-of-state lead.
  const cancellation = inPlay.find((l) => l.cancellation);
  const plain = inPlay.find((l) => !l.cancellation);
  const outOfState = inPlay.find((l) => l.state && l.state.toUpperCase() !== "NJ");

  const picked = [];
  for (const l of [cancellation, plain, outOfState]) {
    if (l && !picked.includes(l)) picked.push(l);
  }
  // Top up from the general pool if any of those came back empty.
  for (const l of inPlay) {
    if (picked.length >= count) break;
    if (!picked.includes(l)) picked.push(l);
  }
  return picked.slice(0, count);
}

/**
 * Sends one real, unmodified outreach email to each seed address.
 * Returns a summary; check the mailboxes by hand to see placement.
 */
export async function runSeedTest() {
  const seeds = seedAddresses();
  if (!seeds.length) {
    log.info("Seed test skipped — SEED_EMAILS not set");
    return { sent: 0, seeds: [] };
  }

  const samples = representativeLeads(seeds.length);
  if (!samples.length) {
    log.warn("Seed test skipped — no in-window leads to model a message on");
    return { sent: 0, seeds };
  }

  const results = [];
  for (let i = 0; i < seeds.length; i++) {
    const lead = samples[i % samples.length];
    try {
      const email = await generateEmail(lead, "cold", { isHotWindow: true });
      // sendEmail applies the same sender, opt-out rotation and postal
      // address as a production send, so this is a true like-for-like test.
      await sendEmail(seeds[i], email.subject, email.body);
      results.push({
        seed: seeds[i],
        subject: email.subject,
        modeledOn: lead.company,
        cancellation: !!lead.cancellation,
        state: lead.state || null,
      });
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      log.error(`Seed test to ${seeds[i]} failed: ${err.message}`);
      results.push({ seed: seeds[i], error: err.message });
    }
  }

  log.success(`Seed test sent to ${results.filter((r) => !r.error).length}/${seeds.length} monitored inboxes`);
  return { sent: results.filter((r) => !r.error).length, results };
}
