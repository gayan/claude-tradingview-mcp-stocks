/**
 * Claude + TradingView MCP — Automated Stock Trading Bot
 *
 * Pulls daily candles from Questrade, calculates SMA(50) and SMA(200),
 * fires on a Golden Cross, executes via Questrade if everything lines up.
 * Designed to be TFSA-friendly: long-only, whole shares, regular hours only.
 *
 * Local mode: node bot.js
 * Cloud mode: deploy to a scheduler (Railway, GitHub Actions, etc.) and
 *             run once after US market close on weekdays.
 */

import "dotenv/config";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "fs";

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "SPY",
  timeframe: process.env.TIMEFRAME || "1D",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "10000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "500"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "1"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  questrade: {
    refreshToken: process.env.QUESTRADE_REFRESH_TOKEN,
    accountId: process.env.QUESTRADE_ACCOUNT_ID,
    loginUrl:
      process.env.QUESTRADE_LOGIN_URL || "https://practicelogin.questrade.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const TOKEN_FILE = ".questrade-token.json";
const CSV_FILE = "trades.csv";

// ─── Onboarding ────────────────────────────────────────────────────────────

function checkOnboarding() {
  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found.");
    console.log("Run: cp .env.example .env");
    console.log("Then fill in your Questrade refresh token and account ID.\n");
    process.exit(0);
  }

  if (!CONFIG.questrade.refreshToken) {
    console.log("\n⚠️  Missing QUESTRADE_REFRESH_TOKEN in .env");
    console.log(
      "Get one from https://apphub.questrade.com (see docs/brokers/questrade.md)\n",
    );
    process.exit(0);
  }

  const csvPath = new URL(CSV_FILE, import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop"\n`,
  );
}

// ─── Questrade Auth (refresh token rotation) ───────────────────────────────

function loadToken() {
  if (existsSync(TOKEN_FILE)) {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  }
  return null;
}

function saveToken(token) {
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

async function refreshAccessToken() {
  const stored = loadToken();
  const refreshToken =
    stored?.refresh_token || CONFIG.questrade.refreshToken;

  if (!refreshToken) {
    throw new Error(
      "No refresh token available. Set QUESTRADE_REFRESH_TOKEN in .env.",
    );
  }

  const url = `${CONFIG.questrade.loginUrl}/oauth2/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Questrade token refresh failed (${res.status}): ${body}\n` +
        `If the refresh token has expired, generate a new one at apphub.questrade.com.`,
    );
  }

  const data = await res.json();
  // {access_token, expires_in, refresh_token, api_server, token_type}
  data.expires_at = Date.now() + (data.expires_in - 30) * 1000;
  saveToken(data);
  return data;
}

async function getAuth() {
  let token = loadToken();
  if (!token || !token.expires_at || Date.now() >= token.expires_at) {
    token = await refreshAccessToken();
  }
  return token;
}

async function qtFetch(path, opts = {}) {
  const auth = await getAuth();
  const url = `${auth.api_server.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `${auth.token_type} ${auth.access_token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Questrade ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

// ─── Market Hours Guard ────────────────────────────────────────────────────

function isUSMarketOpen(now = new Date()) {
  // Convert to ET. Approximation: ET = UTC-4 in DST, UTC-5 in standard time.
  // Good enough for a daily-bar strategy. For finer-grained needs use a tz lib.
  const utcMs = now.getTime();
  // DST: second Sunday of March → first Sunday of November (US rule).
  const year = now.getUTCFullYear();
  const dstStart = nthSundayOfMonth(year, 2, 2); // March is month index 2
  const dstEnd = nthSundayOfMonth(year, 10, 1); // November
  const inDST = utcMs >= dstStart && utcMs < dstEnd;
  const offsetHours = inDST ? -4 : -5;
  const et = new Date(utcMs + offsetHours * 3600 * 1000);

  const day = et.getUTCDay(); // 0 Sun … 6 Sat
  if (day === 0 || day === 6) return { open: false, reason: "weekend" };

  const minutes = et.getUTCHours() * 60 + et.getUTCMinutes();
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  if (minutes < open || minutes >= close) {
    return { open: false, reason: "outside regular hours (9:30–16:00 ET)" };
  }
  return { open: true };
}

function nthSundayOfMonth(year, monthIdx, n) {
  // Returns UTC ms at 07:00 UTC (== 02:00 ET / 03:00 EDT) which is when
  // the US DST switchover actually happens. Close enough for our guard.
  const d = new Date(Date.UTC(year, monthIdx, 1, 7, 0, 0));
  const firstSundayOffset = (7 - d.getUTCDay()) % 7;
  d.setUTCDate(1 + firstSundayOffset + (n - 1) * 7);
  return d.getTime();
}

// ─── Logging ───────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Symbol Lookup + Candles ───────────────────────────────────────────────

async function lookupSymbolId(symbol) {
  const data = await qtFetch(
    `/v1/symbols/search?prefix=${encodeURIComponent(symbol)}`,
  );
  const exact = data.symbols.find(
    (s) => s.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  if (!exact) {
    throw new Error(
      `Symbol ${symbol} not found in Questrade. Candidates: ${data.symbols
        .slice(0, 5)
        .map((s) => s.symbol)
        .join(", ")}`,
    );
  }
  return exact.symbolId;
}

async function fetchDailyCandles(symbolId, days = 260) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  // Questrade requires ISO 8601 with timezone offset.
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "-00:00");
  const path =
    `/v1/markets/candles/${symbolId}` +
    `?startTime=${encodeURIComponent(iso(start))}` +
    `&endTime=${encodeURIComponent(iso(end))}` +
    `&interval=OneDay`;
  const data = await qtFetch(path);
  return data.candles.map((c) => ({
    time: new Date(c.start).getTime(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

async function getQuote(symbolId) {
  const data = await qtFetch(`/v1/markets/quotes?ids=${symbolId}`);
  return data.quotes[0];
}

// ─── Indicators ────────────────────────────────────────────────────────────

function calcSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ─── Position Check ────────────────────────────────────────────────────────

async function getOpenPositionQty(symbol) {
  if (!CONFIG.questrade.accountId) return 0;
  const data = await qtFetch(
    `/v1/accounts/${CONFIG.questrade.accountId}/positions`,
  );
  const pos = data.positions.find(
    (p) => p.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  return pos ? pos.openQuantity : 0;
}

// ─── Safety Check ──────────────────────────────────────────────────────────

function runSafetyCheck({ price, sma50Today, sma200Today, sma50Yest, sma200Yest, openQty }) {
  const results = [];
  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");
  console.log("  Direction: LONG-ONLY (TFSA-safe)\n");

  check(
    "SMA(50) above SMA(200) today (long-term uptrend)",
    `> ${sma200Today.toFixed(2)}`,
    sma50Today.toFixed(2),
    sma50Today > sma200Today,
  );

  check(
    "Yesterday SMA(50) ≤ SMA(200) (fresh Golden Cross today)",
    `≤ ${sma200Yest.toFixed(2)}`,
    sma50Yest.toFixed(2),
    sma50Yest <= sma200Yest,
  );

  check(
    "No existing position in this symbol",
    "0 shares",
    `${openQty} shares`,
    openQty === 0,
  );

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

function checkTradeLimits(log) {
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  const todayCount = countTodaysTrades(log);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }
  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );
  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );
  return true;
}

// ─── Order Placement ───────────────────────────────────────────────────────

async function placeQuestradeOrder({ symbolId, action, quantity }) {
  if (!CONFIG.questrade.accountId) {
    throw new Error("QUESTRADE_ACCOUNT_ID not set in .env");
  }
  const body = {
    accountNumber: CONFIG.questrade.accountId,
    symbolId,
    quantity,
    action, // "Buy" or "Sell"
    orderType: "Market",
    timeInForce: "Day",
    primaryRoute: "AUTO",
    secondaryRoute: "AUTO",
  };
  return qtFetch(
    `/v1/accounts/${CONFIG.questrade.accountId}/orders`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

// ─── Tax CSV ───────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Broker",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}

function writeTradeCsv(entry) {
  const now = new Date(entry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!entry.allPass) {
    const failed = entry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (entry.paperTrading) {
    side = "BUY";
    quantity = entry.shares;
    totalUSD = (entry.shares * entry.price).toFixed(2);
    // Questrade ETF/stock commission: $0.01/share, $4.95 min, $9.95 max
    fee = Math.min(9.95, Math.max(4.95, entry.shares * 0.01)).toFixed(2);
    netAmount = (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2);
    orderId = entry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = entry.shares;
    totalUSD = (entry.shares * entry.price).toFixed(2);
    fee = Math.min(9.95, Math.max(4.95, entry.shares * 0.01)).toFixed(2);
    netAmount = (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2);
    orderId = entry.orderId || "";
    mode = "LIVE";
    notes = entry.error ? `Error: ${entry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Questrade",
    entry.symbol,
    side,
    quantity,
    entry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));
  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(2)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Stock Trading Bot — Questrade");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Market hours
  const market = isUSMarketOpen();
  if (!market.open) {
    console.log(`\n🚫 US market is closed (${market.reason}). No trade today.`);
    // Still allowed to run the analysis for visibility, but block execution.
  } else {
    console.log(`\n✅ US market is open.`);
  }

  // Trade limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch data
  console.log("\n── Fetching market data from Questrade ─────────────────\n");
  const symbolId = await lookupSymbolId(CONFIG.symbol);
  console.log(`  ${CONFIG.symbol} symbolId: ${symbolId}`);

  const quote = await getQuote(symbolId);
  const price = quote.lastTradePrice ?? quote.askPrice ?? quote.bidPrice;
  console.log(`  Last price: $${price?.toFixed(2)}`);

  const candles = await fetchDailyCandles(symbolId, 260);
  if (candles.length < 201) {
    console.log(
      `\n⚠️  Only ${candles.length} daily candles returned — need 201+ for SMA(200) + crossover detection. Exiting.`,
    );
    return;
  }
  const closes = candles.map((c) => c.close);
  const sma50Today = calcSMA(closes, 50);
  const sma200Today = calcSMA(closes, 200);
  const sma50Yest = calcSMA(closes.slice(0, -1), 50);
  const sma200Yest = calcSMA(closes.slice(0, -1), 200);

  console.log(`  SMA(50)  today:    $${sma50Today.toFixed(2)}`);
  console.log(`  SMA(200) today:    $${sma200Today.toFixed(2)}`);
  console.log(`  SMA(50)  yesterday: $${sma50Yest.toFixed(2)}`);
  console.log(`  SMA(200) yesterday: $${sma200Yest.toFixed(2)}`);

  // Position check
  let openQty = 0;
  if (CONFIG.questrade.accountId) {
    try {
      openQty = await getOpenPositionQty(CONFIG.symbol);
      console.log(`  Open position: ${openQty} shares`);
    } catch (err) {
      console.log(`  ⚠️  Could not fetch positions: ${err.message}`);
    }
  } else {
    console.log(`  ⚠️  QUESTRADE_ACCOUNT_ID not set — assuming no position`);
  }

  // Safety check
  const { results, allPass } = runSafetyCheck({
    price,
    sma50Today,
    sma200Today,
    sma50Yest,
    sma200Yest,
    openQty,
  });

  // Position size in whole shares
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );
  const shares = Math.floor(tradeSize / price);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const entry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { sma50Today, sma200Today, sma50Yest, sma200Yest },
    conditions: results,
    allPass,
    shares,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    marketOpen: market.open,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else if (shares < 1) {
    console.log(
      `🚫 Calculated share count is 0 — trade size $${tradeSize.toFixed(2)} below price $${price.toFixed(2)}`,
    );
    entry.allPass = false;
    entry.conditions.push({
      label: "Whole-share size ≥ 1",
      required: ">= 1",
      actual: shares,
      pass: false,
    });
  } else if (!market.open) {
    console.log(`🚫 Market closed — would have bought ${shares} shares of ${CONFIG.symbol} but holding off.`);
    entry.allPass = false;
    entry.conditions.push({
      label: "Market open",
      required: "open",
      actual: market.reason,
      pass: false,
    });
  } else {
    console.log(`✅ ALL CONDITIONS MET`);
    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would buy ${shares} shares of ${CONFIG.symbol} at ~$${price.toFixed(2)} (=$${(shares * price).toFixed(2)})`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      entry.orderPlaced = true;
      entry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — BUY ${shares} ${CONFIG.symbol} at market`,
      );
      try {
        const order = await placeQuestradeOrder({
          symbolId,
          action: "Buy",
          quantity: shares,
        });
        const placed = order.orders?.[0];
        entry.orderPlaced = true;
        entry.orderId = placed?.id?.toString() || "unknown";
        console.log(`✅ ORDER PLACED — ${entry.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        entry.error = err.message;
      }
    }
  }

  log.trades.push(entry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  writeTradeCsv(entry);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
