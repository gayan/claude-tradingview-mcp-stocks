# claude-tradingview-mcp-stocks

Automated stock trading bot. TradingView MCP for charting, Claude as the orchestrator, Questrade as the broker (eventually). Two strategies live in this repo:

| Strategy | File | Cadence | Mode | Status |
|---|---|---|---|---|
| **Golden Cross** (SMA50/SMA200) on SPY | `bot.js` + `rules.json` | Daily, runs once after close | Paper or live (Questrade) | Live-capable |
| **Opening Range Breakout (5m)** on SPY/QQQ/IWM | `bot-orb.js` + `rules-orb.json` | Long-running intraday service | **Paper only** (live deliberately blocked) | Paper-only |

This is a fork-in-spirit of [`claude-tradingview-mcp-trading`](https://github.com/jackson-video-resources/claude-tradingview-mcp-trading) (crypto / BitGet) — same bones, different broker and asset class.

---

## Why two strategies

**Golden Cross** is for buy-and-hold-ish swing trading. ~1–2 entry signals per year on SPY, daily bars, fits cleanly in a TFSA.

**ORB** is for active intraday trading. Up to 3 setups per day across SPY/QQQ/IWM, 5-minute opening range, fixed 2R targets, 2-loss daily circuit breaker. **Paper mode only** for now — see the reality check below.

---

## Reality check on intraday live trading

The ORB strategy is intentionally paper-only because of three blockers:

1. **TFSA + day trading = CRA risk.** Active intraday trading in a TFSA gets reclassified as "business income" — fully taxable, defeats the account. For live ORB you need a non-registered margin account.
2. **Commissions on a small account are crushing.** Questrade's $4.95-each-side commission means $9.90 round-trip × 3 trades/day × 252 days = **$7,484/year**. On a $10K account that's a 75% annual hurdle. ORB only makes sense live with either (a) a much larger account, or (b) a $0-commission broker like Interactive Brokers Lite.
3. **Cash settlement T+2.** A TFSA is a cash account — each dollar can only fund one trade per 2 days. Day trading would constantly free-ride.

Until those are addressed, `bot-orb.js` hardcodes paper mode and refuses to place real orders. You can deploy it to Railway, watch it generate signals all day every day, and learn what the strategy actually does with your money — with zero risk.

---

## Quick start — Golden Cross (live-capable)

```bash
git clone <this-repo>
cd claude-tradingview-mcp-stocks
npm install
cp .env.example .env
```

Follow `docs/brokers/questrade.md` to generate a Questrade refresh token, then:

```bash
node bot.js
```

For a guided setup, paste `prompts/02-one-shot-trade.md` into Claude Code.

---

## Quick start — ORB (paper-only)

```bash
npm install
node bot-orb.js --once   # one tick, then exit (smoke test)
node bot-orb.js          # long-running service
```

To deploy to Railway as a long-running worker: see `docs/deploy-railway.md`.

The ORB Pine Script for visual confirmation on TradingView lives at `pine/orb.pine`. Open the Pine Editor, paste, click Add to Chart. SPY/QQQ/IWM 1m–5m timeframe.

---

## What each bot does

### Golden Cross (`bot.js`)
1. Refreshes Questrade access token (rotating refresh, persisted to `.questrade-token.json`)
2. Looks up SPY's symbolId
3. Pulls 260 daily candles
4. Computes SMA(50) and SMA(200) for today and yesterday
5. Checks open position
6. Verifies US market hours
7. Long entry on a fresh Golden Cross
8. Logs to `safety-check-log.json` and appends a row to `trades.csv`

### ORB (`bot-orb.js`)
1. Long-running service, ticks every `TICK_SECONDS` (default 30s)
2. Waits until 9:35 ET (5 minutes after open)
3. For each symbol: pulls 1m bars from Yahoo Finance (free, no auth), computes the 9:30–9:35 OR (high/low)
4. While armed: enters long when price breaks above OR high
5. Manages position: stops at OR low, targets at OR high + 2R, force-closes at 15:45 ET
6. Tracks daily loss count → stops new entries after 2 losses
7. Logs every closed trade to `safety-check-log.json` + `trades.csv`

---

## Files

- `bot.js` — Golden Cross bot
- `rules.json` — Golden Cross strategy spec
- `bot-orb.js` — ORB bot
- `rules-orb.json` — ORB strategy spec
- `pine/golden-cross.pine` — TradingView visual for Golden Cross
- `pine/orb.pine` — TradingView visual for ORB
- `docs/brokers/questrade.md` — Questrade refresh-token bootstrap
- `docs/deploy-railway.md` — Railway long-running worker setup
- `prompts/02-one-shot-trade.md` — Claude-Code-guided setup
- `railway.json` / `Procfile` — Railway worker config
- `trades.csv` — full audit trail of every paper or live trade
- `safety-check-log.json` — JSON log with full indicator/condition data

---

## Tax records

Every run appends to `trades.csv`. For a quick summary:

```bash
node bot.js --tax-summary
```

For ORB paper trades, the same CSV gets rows tagged `Mode=PAPER` so you can review without worrying about taxes (paper trades are not taxable events).

---

## Disclaimer

This is software for personal automation, not financial advice. Both strategies have published track records but both have also lost money over multi-year stretches. You're responsible for what your bot does with your money. Start in paper / practice mode. Don't enable live trading until you've watched at least one full signal cycle and understand exactly what the bot will do.
