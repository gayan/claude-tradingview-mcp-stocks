# claude-tradingview-mcp-stocks

Automated **stock** trading bot. TradingView MCP for charting, Claude as the orchestrator, **Questrade** as the broker. Designed for Canadian TFSA holders trading US ETFs.

Defaults: **SPY** on the daily timeframe, **Golden Cross** strategy (SMA(50) crosses above SMA(200)), long-only, whole shares, regular hours only.

This is a fork-in-spirit of [`claude-tradingview-mcp-trading`](https://github.com/jackson-video-resources/claude-tradingview-mcp-trading) (crypto / BitGet) — same bones, completely different broker and asset class.

---

## Why this design

- **Golden Cross on a broad index ETF** is one of the most studied, simplest, longest-track-record technical strategies. Two moving averages, one signal. Decades of academic backing for trend-following on broad indices.
- **Daily bars** — the bot runs once a day after market close. No intraday noise, no slippage worries, no babysitting.
- **TFSA-safe** — long-only, no margin, whole shares, regular hours only. The bot won't even attempt anything a TFSA can't legally do.
- **Practice environment first** — Questrade has a real API sandbox with fake money. Default config points there.

Expect ~1–2 entry signals per year on SPY. This is by design; the strategy lags slightly in steady bull markets and outperforms during bear markets. If you want something more active, you'll need to design a different strategy (and edit `rules.json`).

---

## Quick start

```bash
git clone <this-repo>
cd claude-tradingview-mcp-stocks
npm install
cp .env.example .env
```

Then follow `docs/brokers/questrade.md` to:
1. Generate a refresh token at https://apphub.questrade.com
2. Find your 8-digit account number
3. (TFSA) set USD settlement preference
4. Fill in `.env`

Run:

```bash
node bot.js
```

For the full guided walkthrough, paste `prompts/02-one-shot-trade.md` into Claude Code and it'll talk you through every step.

---

## What the bot does each run

1. Refreshes the Questrade access token (rotating refresh token, persisted to `.questrade-token.json`)
2. Looks up the symbol (`SYMBOL` env var, default SPY) → gets `symbolId`
3. Pulls 260 daily candles from Questrade
4. Calculates SMA(50) and SMA(200) for today and yesterday
5. Checks open position via Questrade's positions endpoint
6. Verifies US market hours (9:30–16:00 ET, weekdays)
7. Runs the safety check: are all entry conditions true?
8. If yes and `PAPER_TRADING=false`: places a Market Buy order for whole shares
9. Logs everything to `safety-check-log.json` and appends a row to `trades.csv`

---

## Files

- `bot.js` — the bot.
- `rules.json` — the strategy. Edit this to change what counts as an entry signal.
- `.env.example` — template for credentials and config.
- `docs/brokers/questrade.md` — refresh-token bootstrap walkthrough.
- `prompts/02-one-shot-trade.md` — paste into Claude Code for a fully guided setup.
- `trades.csv` — full audit trail of every decision (created on first run).
- `safety-check-log.json` — JSON log with all indicator values and condition results.

---

## Going live

1. Generate a refresh token from the **live** apphub (logged in with your live Questrade credentials, not practice).
2. In `.env`:
   - Replace `QUESTRADE_REFRESH_TOKEN` with the live token.
   - Change `QUESTRADE_LOGIN_URL` to `https://login.questrade.com`.
   - Update `QUESTRADE_ACCOUNT_ID` if your live account number differs.
3. Delete `.questrade-token.json` (cached practice token).
4. Set `PAPER_TRADING=false`.
5. Run `node bot.js` — the next signal will be real.

---

## Tax records

Every run appends to `trades.csv`: date, symbol, side, quantity, price, total, estimated Questrade commission ($0.01/share, $4.95–$9.95 cap), order ID, paper/live, notes (incl. which safety conditions failed if blocked).

Quick summary:
```bash
node bot.js --tax-summary
```

---

## Disclaimer

This is software for personal automation, not financial advice. The Golden Cross is a real strategy with a long track record but it has lost money over multi-year stretches. You are responsible for what your bot does with your money. Start in paper / practice mode, watch it for at least one signal cycle, and never run it with money you can't afford to lose.
