import "dotenv/config";
import cron from "node-cron";
import { runColdBatch, runFollowupBatch } from "./emailAgent.js";
import { checkReplies } from "./replyWatcher.js";
import { log } from "./logger.js";
import { getLeads, deduplicateLeads, prioritizeByRenewal } from "./leads.js";
import { sendNotification } from "./gmail.js";
import { pullApolloLeads } from "./apollo.js";
import { loadNJCRIBLeads } from "./njcrib.js";

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "BREVO_API_KEY", "YOUR_EMAIL"];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    log.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function runWeeklyLeadPull() {
  log.cron("Triggered: weekly lead pipeline");

  let totalAdded = 0;

  // 1. Pull from Apollo
  try {
    const apolloAdded = await pullApolloLeads(200);
    totalAdded += apolloAdded;
    log.success(`Apollo: ${apolloAdded} new leads`);
  } catch (err) {
    log.error(`Apollo pull failed: ${err.message}`);
  }

  // 2. Scrape NJCRIB WC leads
  try {
    const njcribAdded = await loadNJCRIBLeads();
    totalAdded += njcribAdded;
    log.success(`NJCRIB: ${njcribAdded} new WC leads`);
  } catch (err) {
    log.error(`NJCRIB scrape failed: ${err.message}`);
  }

  // 3. Deduplicate and prioritize
  const dupes = deduplicateLeads();
  prioritizeByRenewal();

  const leads = getLeads();
  const counts = {
    new: leads.filter(l => l.status === "new").length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
  };

  log.success(`Weekly pipeline complete — ${totalAdded} new leads added | ${counts.new} total in queue`);

  await sendNotification(
    `📊 Weekly Lead Pipeline — ${totalAdded} new leads added`,
    `Weekly lead pipeline complete!\n\nNew leads added: ${totalAdded}\nDuplicates removed: ${dupes}\n\nCurrent pipeline:\nNew: ${counts.new}\nContacted: ${counts.contacted}\nReplied: ${counts.replied}\n\nNext cold batch fires today at 3pm.\n\nRichard Doron | (609) 757-2221`
  );
}

async function main() {
  validateEnv();

  const dupes = deduplicateLeads();
  if (dupes > 0) log.info(`Startup: removed ${dupes} duplicate leads`);
  prioritizeByRenewal();

  const leads = getLeads();
  const counts = {
    new: leads.filter(l => l.status === "new").length,
    contacted: leads.filter(l => l.status === "contacted").length,
    replied: leads.filter(l => l.status === "replied").length,
    apollo: leads.filter(l => l.source === "apollo").length,
    njcrib: leads.filter(l => l.source === "njcrib").length,
    dot: leads.filter(l => !l.source || l.source === "dot").length,
  };

  const dailyLimit = parseInt(process.env.DAILY_LIMIT || "100");
  const coldCron = process.env.COLD_CRON || "0 19 * * *";
  const followupCron = process.env.FOLLOWUP_CRON || "30 19 * * *";
  const replyCheckCron = process.env.REPLY_CHECK_CRON || "*/30 * * * *";
  const weeklyCron = process.env.WEEKLY_CRON || "0 6 * * 1";

  console.log(`
╔══════════════════════════════════════════════╗
║         COVERREACH AI OUTREACH AGENT         ║
║     All Commercial Insurance — NJ & Beyond   ║
╚══════════════════════════════════════════════╝
`);
  log.info(`Total leads: ${leads.length} | New: ${counts.new} | Contacted: ${counts.contacted} | Replied: ${counts.replied}`);
  log.info(`Sources: DOT: ${counts.dot} | Apollo: ${counts.apollo} | NJCRIB WC: ${counts.njcrib}`);
  log.info(`Sender:      Richard Doron <${process.env.YOUR_EMAIL}>`);
  log.info(`Daily limit: ${dailyLimit} emails/day`);
  log.info(`Cold send:   ${coldCron} (3pm ET)`);
  log.info(`Follow-up:   ${followupCron} (3:30pm ET)`);
  log.info(`Weekly pull: ${weeklyCron} (Monday 6am — Apollo + NJCRIB)`);
  log.info(`Apollo API:  ${process.env.APOLLO_API_KEY ? "✅ Connected" : "⚠️  Not configured — add APOLLO_API_KEY"}`);
  log.info(`At ${dailyLimit}/day — ${counts.new} new leads = ~${Math.ceil(counts.new/dailyLimit)} days`);

  sendNotification(
    "CoverReach Started",
    `Leads: ${counts.new} new | ${counts.contacted} contacted | ${counts.replied} replied\nApollo: ${process.env.APOLLO_API_KEY ? "Connected" : "Not configured"}\nNJCRIB: Active\nNext weekly pull: Monday 6am`
  ).catch(() => {});

  // Daily cold emails
  cron.schedule(coldCron, async () => {
    log.cron("Triggered: daily cold outreach");
    try { await runColdBatch(); }
    catch (err) { log.error(`Cold batch crashed: ${err.message}`); }
  });

  // Daily follow-ups
  cron.schedule(followupCron, async () => {
    log.cron("Triggered: daily follow-ups");
    try { await runFollowupBatch(); }
    catch (err) { log.error(`Follow-up batch crashed: ${err.message}`); }
  });

  // Reply check every 30 min
  cron.schedule(replyCheckCron, async () => {
    try { await checkReplies(); }
    catch (err) { log.error(`Reply check crashed: ${err.message}`); }
  });

  // Weekly Monday 6am — Apollo + NJCRIB pipeline
  cron.schedule(weeklyCron, async () => {
    log.cron("Triggered: weekly lead pipeline (Apollo + NJCRIB)");
    try { await runWeeklyLeadPull(); }
    catch (err) { log.error(`Weekly pipeline crashed: ${err.message}`); }
  });

  log.success("All schedules active. Agent running 24/7.");
  log.success("Weekly pipeline: every Monday 6am — Apollo pulls fresh leads, NJCRIB pulls WC expirations.");

  setInterval(() => {
    const leads = getLeads();
    log.info(`Heartbeat — ${leads.filter(l=>l.status==="new").length} new | ${leads.filter(l=>l.status==="contacted").length} contacted | ${leads.filter(l=>l.status==="replied").length} replies`);
  }, 60 * 60 * 1000);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
