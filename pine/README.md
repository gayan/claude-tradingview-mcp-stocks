# Pine Scripts

This is the visual companion to the bot. The Pine Script in `golden-cross.pine` implements the **same strategy** that `bot.js` executes — so what you see on the TradingView chart matches what the bot will trade.

## How to load it in TradingView

1. Open TradingView Desktop or web with SPY (or any broad ETF) on the daily timeframe.
2. Open the **Pine Editor** (bottom panel).
3. Paste the contents of `golden-cross.pine`.
4. Click **Add to chart**.

You'll see:
- Orange line = SMA(50)
- Blue line = SMA(200)
- Green/red shaded fill between the two MAs
- Light green background over bullish-regime periods
- Up triangles + "Golden Cross" labels on cross-ups
- Down triangles + "Death Cross" labels on cross-downs
- Open the **Strategy Tester** panel for backtest stats (return, drawdown, win rate, etc.)

## Keeping it in sync with bot.js

Both implementations key off the same two facts:

- `goldenCross = ta.crossover(SMA(50), SMA(200))` (Pine) ↔ `sma50Today > sma200Today AND sma50Yest <= sma200Yest` (bot.js)
- `deathCross = ta.crossunder(SMA(50), SMA(200))` (Pine) ↔ inverse in bot.js

If you change one, change the other. The bot is the source of truth for what actually trades; the Pine Script is the visual proof.
