# LIYOG Blitz AI — Fix Package, Round 3 (Aug 2026)

This is the complete, current state of every fix so far. It supersedes
rounds 1 and 2 — just deploy everything in this package as-is.

## What's in this round

**1. Crypto source fixed for real this time.**
CryptoCompare's free tier now requires an API key (confirmed via a
live HTTP 401 in your own /health output) — removed. Bybit briefly
403'd but recovered on its own (confirmed UP, 17ms) — that was a
transient edge-IP filter, not a permanent block like Binance's.
Bybit is back in as primary crypto source, KuCoin as fallback.

**2. Smart Twelve Data allocation — the "tiered budget" you asked for.**
New file `src/refresh-priority.js` replaces the old flat gap-priority
logic. It now ranks assets by:
  - **Tier** (from each asset's `priority` column in asset_registry —
    majors like EUR/USD, GBP/USD, USD/JPY already have priority
    90-95, so they land in the top tier automatically, no schema
    change needed)
  - **Urgency** (gaps, staleness, never-fetched) within that tier

This means majors get refreshed most often under normal conditions
(spending the scarce 8/min, 800/day budget where signal quality is
highest), while a lower-priority pair that's gone badly stale can
still jump the queue via its urgency score — nothing is ever
permanently starved. Same allocator is now shared by both FX and
crypto refresh logic.

**3. Signals already don't wait for every pair to be ready — confirmed.**
Your instinct that "once any pair is ready it should be analyzed" is
already how index.js's main loop works: it iterates every asset
independently, and READY assets get scored regardless of what state
other assets are in. This part didn't need a fix. What DOES need
watching is the scoring gate itself (score >= 76, data quality,
timeframe agreement) — see "How to see WHY a pair didn't signal"
below.

## Files to REPLACE (overwrite existing paths in your repo)
- `src/index.js`
- `src/data-orchestrator.js`
- `src/config.js`
- `src/db.js`
- `src/quota-manager.js`
- `src/providers/dukascopy.js`
- `src/providers/bybit.js`
- `src/providers/kucoin.js`
- `src/providers/fxref.js`

## Files to ADD (new)
- `src/refresh-priority.js`

## Files to DELETE from your repo
- `src/providers/binance.js`
- `src/providers/oanda.js`
- `src/providers/cryptocompare.js` — if you added this in round 2,
  remove it now. It needs a paid-tier key we don't have.

## wrangler.toml
Add this block near the top (you already did this per our
conversation — just confirming it stays in place):
```toml
[observability]
enabled = true
```

## How to see WHY a pair didn't signal (use this instead of guessing)
Hit `/trigger?key=YOUR_ADMIN_SECRET` in your browser. The JSON
response's `results` array shows EVERY asset's outcome for that run:
- `"status":"READY"` pairs that didn't qualify show `"status":"FILTERED"`
  with a `reason` field (e.g. "Score below threshold (68/76)" or
  "Insufficient multi-timeframe agreement") and the actual `score`.
- This tells you directly whether the engine is being appropriately
  selective (working as intended — short-expiry trading needs a high
  bar) versus something being broken. Going 30-60+ minutes without a
  signal while pairs show FILTERED with real scores close to the
  threshold is normal, disciplined behavior, not a bug.

## SQL (only if not already run)
`add_crypto_pairs.sql` — adds ETH/SOL/XRP/LTC/DOGE. Edit first to
keep only pairs actually on your IQ Option Blitz asset list.

## After deploying
1. Check `/health` — expect `bybit: UP`, `kucoin` rarely touched,
   `twelvedata: UP`, `cryptocompare` gone entirely (stops updating).
2. Check `/status` — crypto pairs should start accumulating fresh
   candles again (source: "bybit" instead of stale "kucoin").
3. Check `/trigger?key=...` — read the `results` array to see real
   scores per asset, not just whether Telegram fired.
