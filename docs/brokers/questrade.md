# Questrade — Setup Guide

Questrade uses **OAuth2 with rotating refresh tokens** instead of static API keys. You bootstrap once by registering a personal app, then the bot rotates the token automatically on every call.

This guide covers both the **practice** environment (sandbox, fake money) and **live** trading. Start with practice.

---

## 1. Open a Questrade account (if you don't have one)

- Live: https://www.questrade.com/
- Practice: comes free with any Questrade account — log into the portal and look for "IQ Edge demo" / "Practice account".

For TFSA holders: the bot is already wired for long-only and won't try to short — TFSAs are not allowed to short stocks or use margin.

---

## 2. Register a personal app to get a refresh token

1. Go to **https://apphub.questrade.com**
2. Log in with your Questrade credentials (use the **practice** login if you want to start in the sandbox).
3. Click **Register a personal app**
4. Give it a name like "Claude Trading Bot"
5. Set the callback URL to `https://localhost` (we don't actually use it)
6. Save the app.
7. On the app page, find **Generate new token** and click it.
8. **Copy the refresh token immediately** — it's only shown once.

---

## 3. Find your account ID

1. In the Questrade portal, click **Accounts**
2. Pick the TFSA (or whichever account you want the bot to trade)
3. The 8-digit number next to the account name is your `accountId`.

---

## 4. Set USD as your settlement currency

Inside a TFSA you can hold both CAD and USD. To avoid 1.5% FX conversion fees on every US trade:

1. In the Questrade portal: **Accounts → Settings → Currency settlement preferences**
2. Set the TFSA preference to **USD**.

Now USD proceeds and dividends stay in USD instead of auto-converting overnight.

---

## 5. Fill in `.env`

```
QUESTRADE_REFRESH_TOKEN=<paste from step 2>
QUESTRADE_ACCOUNT_ID=<8-digit number from step 3>
QUESTRADE_LOGIN_URL=https://practicelogin.questrade.com   # or https://login.questrade.com for live
PAPER_TRADING=true
```

The bot writes the rotated token to `.questrade-token.json` (gitignored) on every run. If you ever lose that file, re-paste a fresh token from apphub.

---

## 6. Verify

```bash
node bot.js
```

First run will exchange the refresh token, hit Questrade's symbol search to look up SPY, pull 260 daily candles, calculate SMA(50) and SMA(200), check for a Golden Cross today, and log a paper trade if conditions hit.

If you see `Questrade token refresh failed (400)`: the refresh token has expired or been used already. Generate a new one at apphub.questrade.com and paste it back into `.env`.

---

## TFSA constraints baked into the bot

- **Long-only** — `direction: long_only` in `rules.json`. The bot never shorts.
- **Whole shares** — fractional shares aren't supported in TFSAs at Questrade.
- **Regular hours only** — bot refuses to place orders outside 9:30am–4:00pm ET on weekdays.
- **No margin** — bot never uses leverage; you'll get an error from Questrade if you try.

## Practice vs live cutover

When you're ready to go live:

1. Generate a new refresh token from the **live** apphub: https://apphub.questrade.com (logged in with your live credentials).
2. In `.env`:
   - Replace `QUESTRADE_REFRESH_TOKEN` with the new token.
   - Change `QUESTRADE_LOGIN_URL` to `https://login.questrade.com`.
   - Update `QUESTRADE_ACCOUNT_ID` if the live account number is different.
3. Delete `.questrade-token.json` (it has the practice token cached).
4. Set `PAPER_TRADING=false` only when you're confident.
