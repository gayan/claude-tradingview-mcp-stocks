/**
 * ORB strategy backtest — long-only 5-minute Opening Range Breakout.
 *
 * Pulls 60 days of 5-minute bars from Yahoo Finance and simulates the same
 * strategy the live bot runs: first 5-minute bar defines the OR, long entry
 * on break above OR high, stop at OR low, target at OR high + 2R, time
 * stop at 15:45 ET, max 2 losses/day circuit breaker.
 *
 * Usage:
 *   node orb-backtest.js                  # defaults: SPY QQQ IWM TSLA NVDA
 *   node orb-backtest.js TSLA NVDA        # specific symbols
 */

const args = process.argv.slice(2);
const commissionFlag = args.find((a) => a.startsWith("--commission="));
const targetFlag = args.find((a) => a.startsWith("--target="));
const COMMISSION = commissionFlag
  ? parseFloat(commissionFlag.split("=")[1])
  : 4.95;
const TARGET_R = targetFlag ? parseFloat(targetFlag.split("=")[1]) : 2;
const symbolArgs = args.filter((a) => !a.startsWith("--"));
const SYMBOLS =
  symbolArgs.length > 0
    ? symbolArgs
    : ["SPY", "QQQ", "IWM", "TSLA", "NVDA"];

const PORTFOLIO = 2500;
const MAX_TRADE_USD = 800;

async function fetchFiveMinBars(symbol) {
  // range=60d, interval=5m → roughly 60 calendar days of 5-minute bars,
  // regular hours only (includePrePost=false).
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
    `?interval=5m&range=60d&includePrePost=false`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${symbol}: ${res.status}`);
  const j = await res.json();
  const r = j.chart.result?.[0];
  if (!r) throw new Error(`Yahoo ${symbol}: no result`);
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  return ts
    .map((t, i) => ({
      time: t,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
    }))
    .filter((b) => b.close != null);
}

function etHM(unix) {
  const d = new Date(unix * 1000);
  const m = d.getUTCMonth();
  const inDST = m >= 2 && m < 10;
  const etH = (d.getUTCHours() - (inDST ? 4 : 5) + 24) % 24;
  return etH * 60 + d.getUTCMinutes();
}
function etDate(unix) {
  const d = new Date(unix * 1000);
  const m = d.getUTCMonth();
  const inDST = m >= 2 && m < 10;
  const shifted = new Date(unix * 1000 - (inDST ? 4 : 5) * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function sizePosition(price, stop) {
  const risk = price - stop;
  if (risk <= 0) return 0;
  const byRisk = Math.floor((PORTFOLIO * 0.01) / risk);
  const byCap = Math.floor(MAX_TRADE_USD / price);
  const byBalance = Math.floor(PORTFOLIO / price);
  return Math.max(0, Math.min(byRisk, byCap, byBalance));
}

function backtestOne(symbol, bars) {
  // Group bars by ET trading day
  const days = {};
  for (const b of bars) {
    const d = etDate(b.time);
    (days[d] ||= []).push(b);
  }

  const trades = [];
  let dailyLosses = 0;
  let prevDate = null;

  for (const [date, dayBars] of Object.entries(days).sort()) {
    if (date !== prevDate) {
      dailyLosses = 0;
      prevDate = date;
    }
    dayBars.sort((a, b) => a.time - b.time);

    // Find the 9:30–9:35 bar (exactly one 5-minute bar)
    const orBar = dayBars.find((b) => etHM(b.time) === 9 * 60 + 30);
    if (!orBar) continue;

    const orHigh = orBar.high;
    const orLow = orBar.low;
    const orRange = orHigh - orLow;
    if (orRange <= 0) continue;

    let position = null;
    let enteredToday = false;

    for (const b of dayBars) {
      const m = etHM(b.time);
      if (m <= 9 * 60 + 30) continue; // skip the OR bar itself

      if (!position && !enteredToday && !circuitTrippedFor(dailyLosses)) {
        // Long entry on break above OR high
        if (m >= 15 * 60 + 30) continue; // no new entries after 15:30
        if (b.high > orHigh) {
          const entryPrice = Math.max(b.open, orHigh); // conservative: fill at the break or open, whichever is higher
          const shares = sizePosition(entryPrice, orLow);
          if (shares < 1) continue;
          const stop = orLow;
          const target = orHigh + TARGET_R * orRange;
          position = {
            date,
            symbol,
            entry: entryPrice,
            stop,
            target,
            shares,
            entryTime: b.time,
          };
          enteredToday = true;
        }
      } else if (position) {
        let exitPrice = null;
        let reason = null;
        // Intrabar: conservative ordering — assume stop fills first if bar
        // touches both stop and target (happens on wide-range bars).
        if (b.low <= position.stop) {
          exitPrice = position.stop;
          reason = "STOP";
        } else if (b.high >= position.target) {
          exitPrice = position.target;
          reason = "TARGET";
        } else if (m >= 15 * 60 + 45) {
          exitPrice = b.close;
          reason = "TIME";
        }
        if (reason) {
          const gross = (exitPrice - position.entry) * position.shares;
          const pnl = gross - 2 * COMMISSION;
          trades.push({ ...position, exit: exitPrice, reason, pnl, gross });
          if (pnl < 0) dailyLosses++;
          position = null;
        }
      }
    }
    // If still open at end of day bars (shouldn't happen — time stop covers it)
    if (position) {
      const last = dayBars[dayBars.length - 1];
      const gross = (last.close - position.entry) * position.shares;
      const pnl = gross - 2 * COMMISSION;
      trades.push({
        ...position,
        exit: last.close,
        reason: "EOD_UNCLOSED",
        pnl,
        gross,
      });
    }
  }

  return { trades, dayCount: Object.keys(days).length };
}

function circuitTrippedFor(losses) {
  return losses >= 2;
}

function summarize(symbol, result) {
  const { trades, dayCount } = result;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalNet = trades.reduce((s, t) => s + t.pnl, 0);
  const totalGross = trades.reduce((s, t) => s + t.gross, 0);
  const totalComm = trades.length * 2 * COMMISSION;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;

  const stopExits = trades.filter((t) => t.reason === "STOP").length;
  const targetExits = trades.filter((t) => t.reason === "TARGET").length;
  const timeExits = trades.filter((t) => t.reason === "TIME").length;

  console.log(`\n── ${symbol} — 60d backtest (${dayCount} trading days) ──────`);
  console.log(`  Trades:     ${trades.length}  (${(trades.length / dayCount).toFixed(2)}/day)`);
  console.log(`  Wins:       ${wins.length}  |  Losses: ${losses.length}`);
  console.log(`  Win rate:   ${winRate.toFixed(1)}%`);
  console.log(`  Exits:      target=${targetExits}  stop=${stopExits}  time=${timeExits}`);
  console.log(`  Gross P&L:  ${totalGross >= 0 ? "+" : ""}$${totalGross.toFixed(2)}`);
  console.log(`  Commissions -$${totalComm.toFixed(2)}`);
  console.log(`  Net P&L:    ${totalNet >= 0 ? "+" : ""}$${totalNet.toFixed(2)}`);
  console.log(`  Avg win:    +$${avgWin.toFixed(2)}  |  Avg loss: $${avgLoss.toFixed(2)}`);
  const pct = (totalNet / PORTFOLIO) * 100;
  console.log(`  Return on $${PORTFOLIO}: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`);
  return { symbol, trades, net: totalNet, winRate, pct };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ORB 60-day backtest — ${SYMBOLS.join(", ")}`);
  console.log(`  Portfolio $${PORTFOLIO}  |  Max trade $${MAX_TRADE_USD}  |  ${TARGET_R}R target`);
  console.log("═══════════════════════════════════════════════════════════");

  const results = [];
  for (const sym of SYMBOLS) {
    try {
      const bars = await fetchFiveMinBars(sym);
      const r = backtestOne(sym, bars);
      results.push(summarize(sym, r));
    } catch (err) {
      console.error(`\n[${sym}] ERROR: ${err.message}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Leaderboard (net P&L, 60 days)");
  console.log("═══════════════════════════════════════════════════════════");
  results.sort((a, b) => b.net - a.net);
  for (const r of results) {
    const marker = r.net > 0 ? "✅" : "🚫";
    console.log(`  ${marker} ${r.symbol.padEnd(5)}  net ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(2).padStart(8)}  win rate ${r.winRate.toFixed(1)}%  ${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
