# Deploying to Railway (long-running worker)

The ORB bot is a **long-running service**, not a cron job. It needs to stay up during US market hours so it can react to breakouts as they happen.

## Setup

1. Install the Railway CLI:
   ```bash
   npm install -g @railway/cli
   ```

2. Log in:
   ```bash
   railway login
   ```

3. Initialize the project (first time only):
   ```bash
   railway init
   ```

4. Set environment variables in Railway:
   ```bash
   railway variables --set "ORB_SYMBOLS=SPY,QQQ,IWM"
   railway variables --set "PORTFOLIO_VALUE_USD=2500"
   railway variables --set "MAX_TRADE_SIZE_USD=800"
   railway variables --set "ORB_TARGET_R=2"
   railway variables --set "MAX_LOSSES=2"
   railway variables --set "TICK_SECONDS=30"
   ```

5. Deploy:
   ```bash
   railway up
   ```

`railway.json` tells Railway to run `node bot-orb.js` and restart it on failure. The bot will run continuously; during market closure it ticks once per `TICK_SECONDS`, prints a "CLOSED" line, and goes back to sleep — minimal cost.

## Cost notes

- Long-running services on Railway are billed by time × resources. The bot does almost nothing when the market is closed, so it should sit close to idle most of the time.
- Yahoo Finance fetches are free. No Questrade calls are made in paper mode.
- If you want to be really cost-conscious, set up Railway cron triggers to start/stop the worker at market hours instead of running 24/7. That's a follow-up — not required for paper mode.

## Logs and state

The bot writes to:
- `safety-check-log.json` — JSON log of every closed paper trade (entry, exit, OR levels, P&L)
- `trades.csv` — CSV row per closed trade for spreadsheet/tax review
- `.orb-state.json` — current per-day state (OR levels, position status). Reset automatically on a new trading day.

These are local files. On Railway they live in the container's ephemeral filesystem and **will not persist across redeploys**. For real persistence you'd hook up a Railway volume or push logs to an external store. Paper mode → fine to lose history if you redeploy.
