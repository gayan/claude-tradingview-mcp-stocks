/**
 * Claude + TradingView MCP — Opening Range Breakout (5m) — paper-mode bot
 *
 * Long-running service. During US regular market hours, watches SPY/QQQ/IWM,
 * computes each symbol's 5-minute Opening Range, and simulates a long-only
 * breakout strategy with a fixed 2R target. PAPER MODE ONLY.
 *
 * Run locally: node bot-orb.js
 * Run on Railway: deploy as a long-running worker (see railway.json).
 *
 * Modes:
 *   --once    Run a single tick and exit (for smoke testing)
 *   --replay  Replay today's bars in fast-forward to see the bot's decisions
 */

import "dotenv/config";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "fs";

// ─── Config ────────────────────────────────────────────────────────────────

const SYMBOLS = (process.env.ORB_SYMBOLS || "NVDA,SPY,QQQ")
  .split(",")
  .map((s) => s.trim().toUpperCase());
const PORTFOLIO = parseFloat(process.env.PORTFOLIO_VALUE_USD || "2500");
const MAX_TRADE_SIZE_USD = parseFloat(process.env.MAX_TRADE_SIZE_USD || "800");
const TARGET_R = parseFloat(process.env.ORB_TARGET_R || "2");
const MAX_LOSSES_PER_DAY = parseInt(process.env.MAX_LOSSES || "2");
const COMMISSION = parseFloat(process.env.COMMISSION_USD || "4.95");
const TICK_SECONDS = parseInt(process.env.TICK_SECONDS || "30");
const ORB_MINUTES = 5;

const FORCE_PAPER = true; // hardcoded — live execution is intentionally disabled

const LOG_FILE = "safety-check-log.json";
const CSV_FILE = "trades.csv";
const STATE_FILE = ".orb-state.json";

const ONCE = process.argv.includes("--once");
const REPLAY = process.argv.includes("--replay");

// ─── Time helpers (US Eastern) ─────────────────────────────────────────────

function nthSundayOfMonth(year, monthIdx, n) {
  const d = new Date(Date.UTC(year, monthIdx, 1, 7, 0, 0));
  const offset = (7 - d.getUTCDay()) % 7;
  d.setUTCDate(1 + offset + (n - 1) * 7);
  return d.getTime();
}

function etOffsetHours(now) {
  const y = now.getUTCFullYear();
  const dstStart = nthSundayOfMonth(y, 2, 2); // 2nd Sunday March
  const dstEnd = nthSundayOfMonth(y, 10, 1); // 1st Sunday November
  const inDST = now.getTime() >= dstStart && now.getTime() < dstEnd;
  return inDST ? -4 : -5;
}

function nowET(now = new Date()) {
  const offset = etOffsetHours(now);
  return new Date(now.getTime() + offset * 3600 * 1000);
}

function etHM(et) {
  return et.getUTCHours() * 60 + et.getUTCMinutes();
}

function etDateStr(et) {
  return et.toISOString().slice(0, 10);
}

function isMarketOpen(now = new Date()) {
  const et = nowET(now);
  const day = et.getUTCDay();
  if (day === 0 || day === 6) return { open: false, reason: "weekend" };
  const m = etHM(et);
  if (m < 9 * 60 + 30) return { open: false, reason: "premarket" };
  if (m >= 16 * 60) return { open: false, reason: "after_close" };
  return { open: true };
}

// ─── Market data (Yahoo Finance — free, no auth) ───────────────────────────

async function fetchMinuteBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=false`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  const json = await res.json();
  const r = json.chart.result?.[0];
  if (!r) throw new Error(`Yahoo ${symbol}: no result`);
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    bars.push({
      time: ts[i],
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume[i],
    });
  }
  return bars;
}

// ─── State management ─────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function freshDayState(date) {
  return {
    date,
    losses: 0,
    circuitBreakerAt: null,
    symbols: Object.fromEntries(
      SYMBOLS.map((s) => [
        s,
        {
          status: "pending", // pending | armed | in_position | done
          orHigh: null,
          orLow: null,
          orComputedAt: null,
          entryPrice: null,
          stop: null,
          target: null,
          shares: null,
          entryTime: null,
          exitPrice: null,
          exitTime: null,
          exitReason: null,
          pnl: null,
        },
      ]),
    ),
  };
}

// ─── Pricing / sizing ──────────────────────────────────────────────────────

function sizePosition(price, stop) {
  // Risk-based: 1% of portfolio at risk on the OR-low stop.
  const riskPerShare = price - stop;
  if (riskPerShare <= 0) return 0;
  const riskBudget = PORTFOLIO * 0.01;
  const sharesByRisk = Math.floor(riskBudget / riskPerShare);
  // Cap by max trade size USD and by what the portfolio can buy.
  const sharesByCap = Math.floor(MAX_TRADE_SIZE_USD / price);
  const sharesByPortfolio = Math.floor(PORTFOLIO / price);
  return Math.max(0, Math.min(sharesByRisk, sharesByCap, sharesByPortfolio));
}

// ─── Per-tick logic ────────────────────────────────────────────────────────

async function tickSymbol(sym, daily, et) {
  const ss = daily.symbols[sym];
  if (ss.status === "done") return;

  const bars = await fetchMinuteBars(sym);
  if (bars.length === 0) return;

  // Find the OR window: bars with ET timestamp in [9:30, 9:35).
  const orBars = bars.filter((b) => {
    const e = nowET(new Date(b.time * 1000));
    const m = etHM(e);
    return m >= 9 * 60 + 30 && m < 9 * 60 + 30 + ORB_MINUTES && etDateStr(e) === daily.date;
  });

  // Compute OR once we have all the bars in the window.
  if (ss.status === "pending") {
    if (orBars.length >= ORB_MINUTES) {
      ss.orHigh = Math.max(...orBars.map((b) => b.high));
      ss.orLow = Math.min(...orBars.map((b) => b.low));
      ss.orComputedAt = new Date().toISOString();
      ss.status = "armed";
      console.log(
        `  [${sym}] OR computed: high=${ss.orHigh.toFixed(2)} low=${ss.orLow.toFixed(2)} range=${(ss.orHigh - ss.orLow).toFixed(2)}`,
      );
    } else {
      // Not enough bars yet (we're still inside the OR window or before it)
      return;
    }
  }

  const lastBar = bars[bars.length - 1];
  const price = lastBar.close;

  // Watch for breakout if armed
  if (ss.status === "armed") {
    if (daily.circuitBreakerAt) {
      console.log(`  [${sym}] circuit breaker tripped — no new entries`);
      ss.status = "done";
      ss.exitReason = "circuit_breaker";
      return;
    }

    const m = etHM(et);
    if (m >= 15 * 60 + 30) {
      console.log(`  [${sym}] too late to enter (after 15:30 ET)`);
      ss.status = "done";
      ss.exitReason = "no_entry_window_closed";
      return;
    }

    if (price > ss.orHigh) {
      const stop = ss.orLow;
      const target = ss.orHigh + TARGET_R * (ss.orHigh - ss.orLow);
      const shares = sizePosition(price, stop);
      if (shares < 1) {
        console.log(
          `  [${sym}] breakout at ${price.toFixed(2)} but position size < 1 share — skipping`,
        );
        ss.status = "done";
        ss.exitReason = "size_too_small";
        return;
      }
      ss.entryPrice = price;
      ss.stop = stop;
      ss.target = target;
      ss.shares = shares;
      ss.entryTime = new Date().toISOString();
      ss.status = "in_position";
      console.log(
        `  [${sym}] 📋 PAPER ENTRY: long ${shares} sh @ ${price.toFixed(2)} | stop ${stop.toFixed(2)} | target ${target.toFixed(2)}`,
      );
    } else {
      console.log(
        `  [${sym}] armed — price ${price.toFixed(2)} ≤ OR high ${ss.orHigh.toFixed(2)}`,
      );
    }
    return;
  }

  // Manage open position
  if (ss.status === "in_position") {
    const m = etHM(et);
    let exitReason = null;
    let exitPrice = null;

    // Use bar high/low between last tick and now for stop/target — but to
    // keep it simple in paper mode we check current close. Real intraday
    // execution would need to walk every bar between entry and now.
    if (lastBar.low <= ss.stop) {
      exitPrice = ss.stop; // assume stop fills at stop price
      exitReason = "stop";
    } else if (lastBar.high >= ss.target) {
      exitPrice = ss.target;
      exitReason = "target";
    } else if (m >= 15 * 60 + 45) {
      exitPrice = price;
      exitReason = "time_stop";
    }

    if (exitReason) {
      const grossPnl = (exitPrice - ss.entryPrice) * ss.shares;
      const pnl = grossPnl - 2 * COMMISSION; // entry + exit
      ss.exitPrice = exitPrice;
      ss.exitTime = new Date().toISOString();
      ss.exitReason = exitReason;
      ss.pnl = pnl;
      ss.status = "done";

      const win = pnl > 0;
      console.log(
        `  [${sym}] 📋 PAPER EXIT (${exitReason}): ${ss.shares} sh @ ${exitPrice.toFixed(2)} | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} ${win ? "✅ WIN" : "🚫 LOSS"}`,
      );

      if (!win) {
        daily.losses += 1;
        if (daily.losses >= MAX_LOSSES_PER_DAY && !daily.circuitBreakerAt) {
          daily.circuitBreakerAt = new Date().toISOString();
          console.log(
            `  ⚠️  Daily circuit breaker tripped (${daily.losses} losses). No new entries today.`,
          );
        }
      }

      writeTradeCsv(sym, ss);
      appendDecisionLog(sym, ss, daily);
    }
    return;
  }
}

async function tick() {
  const now = new Date();
  const et = nowET(now);
  const date = etDateStr(et);
  const market = isMarketOpen(now);

  let daily = loadState();
  if (!daily || daily.date !== date) {
    daily = freshDayState(date);
    saveState(daily);
    console.log(`\n🌅 New trading day: ${date}`);
  }

  console.log(
    `\n[${et.toISOString().slice(11, 19)} ET] ${market.open ? "OPEN" : `CLOSED (${market.reason})`} | losses ${daily.losses}/${MAX_LOSSES_PER_DAY}${daily.circuitBreakerAt ? " 🛑" : ""}`,
  );

  if (!market.open) {
    saveState(daily);
    return;
  }

  const m = etHM(et);
  if (m < 9 * 60 + 30 + ORB_MINUTES) {
    console.log(`  Inside OR window — waiting until ${ORB_MINUTES}m after open`);
    saveState(daily);
    return;
  }

  for (const sym of SYMBOLS) {
    try {
      await tickSymbol(sym, daily, et);
    } catch (err) {
      console.error(`  [${sym}] ERROR: ${err.message}`);
    }
  }

  saveState(daily);
}

// ─── Logging ───────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Broker",
  "Symbol",
  "Side",
  "Quantity",
  "Entry Price",
  "Exit Price",
  "Total USD",
  "Fee (est.)",
  "Net P&L",
  "Mode",
  "Reason",
].join(",");

function ensureCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }
}

function writeTradeCsv(sym, ss) {
  ensureCsv();
  const t = new Date(ss.exitTime);
  const row = [
    t.toISOString().slice(0, 10),
    t.toISOString().slice(11, 19),
    "Paper (ORB)",
    sym,
    "BUY/SELL",
    ss.shares,
    ss.entryPrice.toFixed(2),
    ss.exitPrice.toFixed(2),
    (ss.shares * ss.entryPrice).toFixed(2),
    (2 * COMMISSION).toFixed(2),
    ss.pnl.toFixed(2),
    "PAPER",
    `"${ss.exitReason}"`,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

function appendDecisionLog(sym, ss, daily) {
  const log = existsSync(LOG_FILE)
    ? JSON.parse(readFileSync(LOG_FILE, "utf8"))
    : { trades: [] };
  log.trades.push({
    timestamp: ss.exitTime,
    strategy: "ORB-5m",
    symbol: sym,
    entry: { price: ss.entryPrice, time: ss.entryTime, shares: ss.shares },
    exit: { price: ss.exitPrice, reason: ss.exitReason, time: ss.exitTime },
    or: { high: ss.orHigh, low: ss.orLow, range: ss.orHigh - ss.orLow },
    target: ss.target,
    stop: ss.stop,
    pnl: ss.pnl,
    paperTrading: true,
    daily: { losses: daily.losses, circuitBreaker: daily.circuitBreakerAt },
  });
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ─── Entrypoint ────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude ORB Bot — paper mode");
  console.log(
    `  Symbols: ${SYMBOLS.join(", ")} | Portfolio: $${PORTFOLIO.toFixed(2)} | Max trade: $${MAX_TRADE_SIZE_USD}`,
  );
  console.log(`  OR window: ${ORB_MINUTES}m | Target: ${TARGET_R}R | Max losses/day: ${MAX_LOSSES_PER_DAY}`);
  console.log(`  Commission (each side): $${COMMISSION}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (REPLAY) {
    console.log("\n[--replay] running today's tick once with current bars\n");
    await tick();
    return;
  }
  if (ONCE) {
    console.log("\n[--once] single tick then exit\n");
    await tick();
    return;
  }

  // Long-running loop. Runs every TICK_SECONDS.
  console.log(`\nLong-running mode — ticking every ${TICK_SECONDS}s. Ctrl+C to stop.\n`);
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("Tick error:", err.message);
    }
    await new Promise((r) => setTimeout(r, TICK_SECONDS * 1000));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
