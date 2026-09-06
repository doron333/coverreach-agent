import "dotenv/config";
import cron from "node-cron";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkGmailReplies } from "./imapWatcher.js";
import { startReplyServer } from "./replyServer.js";
import { log } from "./logger.js";
import { getLeads, deduplicateLeads, prioritizeByRenewal } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { auditLeads } from "./leadAudit.js";
import { runSeedTest } from "./seedTest.js";

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "BREVO_API_KEY", "YOUR_EMAIL"];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// Keep the process alive even if something goes wrong
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  log.error(`Uncaught Exception: ${err.message}`);
});

async function main() {
  validateEnv();

  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Removed ${dupes} duplicate leads`);
  prioritizeByRenewal();

  const leads = getLeads();
  const inWindow = (l) => {
    if (!l.renewalDate) return false;
    const [m, d, y] = l.renewalDate.split("/").map(Number);
    const days = Math.floor((new Date(y, m - 1, d) - Date.now()) / 86400000);
    if (l.cancellation) return days >= 0 && days <= 75;
    return days >= parseInt(process.env.MIN_RUNWAY_DAYS || "10") && days <= 60;
  };

  const counts = {
    new: leads.filter(l => l.status === "new" && l.email && inWindow(l)).length,
    pipeline: leads.filter(l => l.status === "new" && l.email).length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
    noEmail: leads.filter(l => !l.email || l.email === "null" || l.status === "no_email").length,
    dual: 0,
    cancellations: leads.filter(l => l.status === "new" && l.cancellation && inWindow(l)).length,
  };

  const dailyLimit = parseInt(process.env.DAILY_LIMIT || "200");
  // SEND TIME — 5:30 AM ET (09:30 UTC)
  //
  // Measured from the first 38 opens on the authenticated domain: 24 of them
  // happened before 8am ET, peaking between 3am and 7am, with almost nothing
  // after 2pm. Truckers and dispatchers check their phones before the day's
  // runs start, not mid-morning at a desk. Sending at 9:46am was landing
  // after that window had already passed.
  //
  // Deliberately NOT reading COLD_CRON: that variable still holds the old
  // 9:46am value in Railway and an env var would override this. Set
  // SEND_CRON if the time ever needs changing again.
  // 7:00 AM Eastern. Opens in the first week clustered 3-7am, so the batch
  // lands just as this audience is checking phones before the day's runs.
  //
  // Expressed in EASTERN time and pinned with an explicit timezone below.
  // Without the timezone option node-cron uses the container's local zone,
  // which is not UTC here — a "30 9" schedule fired at 1:30 AM ET on 8/13.
  // Stating the zone removes the guesswork and survives DST.
  const coldCron = process.env.SEND_CRON || "0 7 * * *";
  const CRON_TZ = process.env.CRON_TZ || "America/New_York";
  const followupCron = process.env.FOLLOWUP_CRON || "30 19 * * *";
  const replyCheckCron = process.env.REPLY_CHECK_CRON || "*/30 * * * *";

  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║     All Commercial Insurance — NJ Market     ║
╚══════════════════════════════════════════════╝
`);

  log.info(`ROLLING RENEWALS — In window now: ${counts.new} | Total pipeline: ${counts.pipeline} | Contacted: ${counts.contacted} | Replied: ${counts.replied}`);
  log.info(`🔴 Cancellations (priority): ${counts.cancellations}`);
  log.info(`Sender: Richard Doron <${process.env.YOUR_EMAIL}>`);
  log.info(`Daily run: ${process.env.SEND_HOUR_ET || "7"}:00 Eastern (cold + follow-ups together)`);
  log.info(`At ${dailyLimit}/day — ${counts.new} July leads = ~${Math.ceil(counts.new/dailyLimit)} days`);

  sendNotification(
    "✅ CoverReach Agent Started — Rolling Renewal Mode",
    `ROLLING RENEWAL OUTREACH (NJ · PA · MD · DE)
${"=".repeat(40)}
In send window now (30-60 days to renewal): ${counts.new}
🔴 Cancellations (sent first): ${counts.cancellations}
Total future pipeline: ${counts.pipeline}
Contacted so far: ${counts.contacted}
Replied: ${counts.replied}

Daily limit: ${dailyLimit}
Each lead is contacted 30-60 days before THEIR renewal —
enough time to quote and close before rates lock.

Richard Doron | (609) 757-2221`
  ).catch(() => {});

  // Cold outreach and follow-ups run in ONE trigger, back to back.
  //
  // They deliberately run sequentially rather than in parallel: both read and
  // write data/leads.json, and concurrent runs would race — the second write
  // would silently discard the first batch's status updates.
  //
  // Cold goes first so fresh prospects get the day's best send window, then
  // follow-ups use the remainder of the daily budget.
  // Runs HOURLY and fires only when it is actually the target hour in Eastern.
  //
  // node-cron's timezone option depends on the OS having timezone data, and
  // this container does not ship it — so "0 7 * * *" with timezone
  // America/New_York silently ran at 07:00 UTC (3 AM ET) on 8/14. Intl
  // carries its own tz data in Node 22 and resolves Eastern correctly with
  // no OS support, so the hour check is the reliable path. It also handles
  // the DST change in November without any edit.
  // Eastern time computed with plain arithmetic — no Intl, no OS timezone data.
  //
  // Two earlier attempts failed silently: node-cron's timezone option needs OS
  // tzdata this container lacks, and Intl.DateTimeFormat with a timeZone falls
  // back to UTC on Node builds without full ICU. Both made the batch fire at
  // 3 AM ET. This does the offset by hand so nothing can silently fall back.
  //
  // US Eastern: EDT (UTC-4) from the 2nd Sunday of March to the 1st Sunday of
  // November, EST (UTC-5) otherwise.
  const isEasternDST = (d) => {
    const y = d.getUTCFullYear();
    const firstOfMarch = new Date(Date.UTC(y, 2, 1)).getUTCDay();
    const secondSundayMarch = 1 + ((7 - firstOfMarch) % 7) + 7;
    const dstStart = Date.UTC(y, 2, secondSundayMarch, 7);   // 2 AM EST
    const firstOfNov = new Date(Date.UTC(y, 10, 1)).getUTCDay();
    const firstSundayNov = 1 + ((7 - firstOfNov) % 7);
    const dstEnd = Date.UTC(y, 10, firstSundayNov, 6);       // 2 AM EDT
    const t = d.getTime();
    return t >= dstStart && t < dstEnd;
  };

  const etParts = (now = new Date()) => {
    const offset = isEasternDST(now) ? 4 : 5;
    const et = new Date(now.getTime() - offset * 3600000);
    return {
      hour: et.getUTCHours(),
      date: `${et.getUTCFullYear()}-${String(et.getUTCMonth() + 1).padStart(2, "0")}-${String(et.getUTCDate()).padStart(2, "0")}`,
      zone: offset === 4 ? "EDT" : "EST",
    };
  };

  // Log the resolved Eastern time at startup so a wrong clock is never silent
  // again — two timezone bugs shipped unnoticed because nothing printed it.
  {
    const p = etParts();
    log.info(`Clock check — now ${p.hour}:xx ${p.zone} (${p.date}); UTC hour ${new Date().getUTCHours()}`);
  }

  const TARGET_HOUR = Number((process.env.SEND_HOUR_ET || "7").trim());
  let lastRunDate = null;   // guards against firing twice in one day

  if (process.env.COLD_ENABLED === "false") {
    log.info("⏸️  NOTE: outbound batches are PAUSED (COLD_ENABLED=false). Remove the variable or set true to resume.");
  } else {
    log.info(`▶️  Outbound batches ACTIVE — next window ${TARGET_HOUR}:00 ET (sender verified: SPF/DKIM/DMARC aligned on outreach subdomain).`);
  }

  cron.schedule("0 * * * *", async () => {
    const { hour, date } = etParts();
    if (hour !== TARGET_HOUR) return;

    // Default: RUNNING. The 8/16 pause was based on a stale finding (gmail.com
    // From) — live DNS verification the same evening confirmed the outreach
    // subdomain has SPF, DKIM, and DMARC fully aligned, so the pause protected
    // nothing while Aug–Oct renewal leads aged out (Mon 8/17 and Tue 8/18
    // batches were lost to it). Resume must not depend on a manual Railway
    // change again. To pause deliberately, set COLD_ENABLED=false.
    if (process.env.COLD_ENABLED === "false") {
      log.info("⏸️  Outbound batches PAUSED (COLD_ENABLED=false). Remove the variable or set true to resume.");
      return;
    }

    // Optional weekend pause. Off by default — ~30% of cold volume has gone
    // out on Sat/Sun and trucking owners do read on weekends, so this is a
    // test toggle, not a rule. Set SKIP_WEEKENDS=true in Railway to try it.
    if (process.env.SKIP_WEEKENDS === "true") {
      const dow = new Date().toLocaleDateString("en-US", { weekday: "short", timeZone: CRON_TZ });
      if (dow === "Sat" || dow === "Sun") {
        log.info(`⏸️  Weekend — outbound skipped (SKIP_WEEKENDS=true). Reply checks continue.`);
        return;
      }
    }

    if (lastRunDate === date) return;
    lastRunDate = date;

    log.cron(`Triggered: daily outreach at ${hour}:00 ${CRON_TZ} (cold, then follow-ups)`);
    try {
      await runColdBatch();
    } catch (err) {
      log.error(`Cold batch crashed: ${err.message}`);
    }
    try {
      await runFollowupBatch();
    } catch (err) {
      log.error(`Follow-up batch crashed: ${err.message}`);
    }
    // Seed monitoring: send the same mail to a few watched inboxes so we can
    // see actual folder placement, which no sending-side metric reveals.
    try {
      await runSeedTest();
    } catch (err) {
      log.error(`Seed test crashed: ${err.message}`);
    }

    log.cron("Daily outreach complete");
  });

  cron.schedule(replyCheckCron, async () => {
    log.cron("Triggered: Gmail reply check");
    try {
      await checkGmailReplies();
    } catch (err) {
      log.error(`Reply check crashed: ${err.message}`);
    }
  });

  // Weekly lead hygiene sweep — Sundays 6:00 AM ET (10:00 UTC).
  // Repairs broken addresses and suppresses confirmed-undeliverable ones so
  // list quality never silently degrades as new data is added.
  cron.schedule(process.env.AUDIT_CRON || "0 10 * * 0", async () => {
    log.cron("Triggered: weekly lead hygiene audit");
    try {
      const r = await auditLeads({ apply: true });
      if (r.repaired.length || r.suppressed.length) {
        await sendNotification(
          `\uD83E\uDDF9 Weekly lead audit — ${r.repaired.length} repaired, ${r.suppressed.length} suppressed`,
          `${r.summary}\n\n` +
          `Repaired addresses:\n` +
          r.repaired.slice(0, 20).map(x => `  ${x.from} -> ${x.to}`).join("\n") +
          `\n\nSuppressed (undeliverable):\n` +
          r.suppressed.slice(0, 20).map(x => `  ${x.email} (${x.reason})`).join("\n")
        ).catch(() => {});
      }
    } catch (err) { log.error(`Audit cron failed: ${err.message}`); }
  }, { timezone: CRON_TZ });

  log.success("All schedules active. Agent running 24/7.");

  startReplyServer();

  setInterval(() => {
    try {
      const currentLeads = getLeads();
      log.info(`Heartbeat — ${currentLeads.filter(l => l.status === "new" && l.email && l.email !== "null").length} ready | ${currentLeads.filter(l => l.status === "contacted").length} contacted | ${currentLeads.filter(l => l.status === "replied").length} replies`);
    } catch (e) {
      log.error(`Heartbeat error: ${e.message}`);
    }
  }, 60 * 60 * 1000);

  setInterval(() => {}, 1000 * 60 * 60 * 24);
}

main().catch(err => {
  log.error(`Fatal error in main: ${err.message}`);
});