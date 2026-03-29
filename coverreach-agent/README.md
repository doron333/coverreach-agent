# CoverReach — 24/7 AI Insurance Outreach Agent

Autonomous email agent that sends personalized cold outreach, runs weekly follow-ups, and notifies you the moment a lead replies — all without you touching it.

---

## What It Does

| When | Action |
|---|---|
| Every Monday 9am | Sends AI-generated cold emails to all **New** leads |
| Every Thursday 10am | Sends AI-generated follow-ups to **Contacted** leads (7+ days, no reply) |
| Every 30 minutes | Scans Gmail inbox for replies from leads |
| Reply detected | Sends you an instant notification email with lead details |

---

## Setup (one time, ~15 minutes)

### Step 1 — Install dependencies
```bash
npm install
```

### Step 2 — Set up your .env
```bash
cp .env.example .env
```
Open `.env` and fill in:
- `ANTHROPIC_API_KEY` — get from https://console.anthropic.com
- `YOUR_EMAIL` — your Gmail address
- `SENDER_NAME` and `SENDER_TITLE` — your name and title for email sign-offs

### Step 3 — Get your Gmail OAuth2 credentials

1. Go to https://console.cloud.google.com
2. Create a new project (or use an existing one)
3. Search "Gmail API" → Enable it
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Download and note your **Client ID** and **Client Secret**
7. Add them to your `.env` file

### Step 4 — Get your Gmail refresh token (automated)
```bash
npm run setup
```
This walks you through the OAuth flow and saves your refresh token automatically.

### Step 5 — Add your leads

**Option A** — Edit `data/leads.json` directly (see the sample format)

**Option B** — Import from a CSV file:
```bash
node scripts/import-leads.js path/to/your-leads.csv
```
Your CSV just needs columns for Name, Email, and Company (any column order, flexible header names).

### Step 6 — Test it locally
```bash
npm start
```
You should see the agent start, print a lead summary, and run an initial reply check.

---

## Deploy to Railway (runs 24/7, free tier available)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create a new project
railway init

# Set your environment variables in Railway dashboard
# OR use the CLI:
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set GMAIL_CLIENT_ID=...
railway variables set GMAIL_CLIENT_SECRET=...
railway variables set GMAIL_REFRESH_TOKEN=...
railway variables set YOUR_EMAIL=you@gmail.com
railway variables set SENDER_NAME="Alex Rivera"
railway variables set SENDER_TITLE="Insurance Solutions Specialist"

# Deploy
railway up
```

Your agent is now running 24/7 in the cloud. Railway restarts it automatically if it crashes.

---

## CLI Tools

```bash
# Check agent status and lead pipeline
node scripts/status.js

# Import leads from CSV
node scripts/import-leads.js leads.csv

# Re-run Gmail OAuth setup
npm run setup
```

---

## Lead Statuses

| Status | Meaning |
|---|---|
| `new` | Not yet contacted — will get cold email on Monday |
| `contacted` | Cold email sent, no reply yet — will get follow-up on Thursday |
| `replied` | They responded! Agent notified you. Follow up manually. |
| `cold` | Max follow-ups (3) reached with no reply. Done. |

---

## Customizing the Schedule

Edit your `.env`:
```env
COLD_CRON=0 9 * * 1        # Monday 9am
FOLLOWUP_CRON=0 10 * * 4   # Thursday 10am
REPLY_CHECK_CRON=*/30 * * * *  # Every 30 minutes
FOLLOWUP_AFTER_DAYS=7      # Days before follow-up
MAX_FOLLOWUPS=3            # Max follow-ups per lead
SEND_DELAY_MS=5000         # 5s delay between sends
```

Cron syntax: `minute hour day-of-month month day-of-week`

---

## File Structure

```
coverreach-agent/
├── src/
│   ├── index.js          ← Scheduler + entry point
│   ├── emailAgent.js     ← Cold + follow-up batch logic
│   ├── replyWatcher.js   ← Gmail reply detection
│   ├── claude.js         ← AI email generation
│   ├── gmail.js          ← Gmail API (send + read)
│   ├── leads.js          ← Lead database management
│   └── logger.js         ← Colored console output
├── scripts/
│   ├── setup-oauth.js    ← Gmail OAuth2 setup wizard
│   ├── import-leads.js   ← CSV lead importer
│   └── status.js         ← CLI status dashboard
├── data/
│   └── leads.json        ← Your lead database
├── .env.example
├── railway.toml
└── package.json
```
