# iq-option-signal-bot
# IQ Option Blitz AI Signal Engine v2

This is a rebuilt, multi-asset signal engine for Cloudflare Workers + D1 + Workers AI.

## What changed

- No hard-coded BTC-only strategy.
- Assets live in D1.
- Scans every minute.
- Uses closed 1-minute candles.
- Aggregates the same 1m candles into 5m and 15m views.
- Calculates EMA, RSI, MACD, ATR, Bollinger Bands, ROC, ADX and candle/market-structure features locally.
- Uses a deterministic score before AI.
- AI can return CALL, PUT or NO_TRADE.
- AI returns structured JSON using Workers AI JSON Mode.
- Entry is scheduled on an exact minute boundary and displayed in WAT.
- Default lead time is 3 minutes, configurable per asset in D1.
- Expiry is dynamic from 1–5 minutes.
- Signals and features are stored in D1.
- A first-pass outcome settlement engine is included.
- `/assets`, `/history`, `/stats`, `/health`, `/trigger`, `/outcomes` endpoints are included.

## Important data caveat

The configured provider is Twelve Data. Its forex/crypto candles are market-data proxies and are NOT guaranteed to be identical to IQ Option OTC/Blitz candles. Do not interpret the engine's historical win rate as proof that it will reproduce the broker feed.

For production use, the most important future upgrade is obtaining a legally usable feed that matches the exact IQ Option OTC/Blitz instrument.

## Setup

1. Run the migration against D1:
   `npx wrangler d1 execute trading_db --remote --file migrations/0001_signal_engine.sql`

2. Add Worker secrets:
   `npx wrangler secret put TWELVE_DATA_API_KEY`
   `npx wrangler secret put TELEGRAM_BOT_TOKEN`
   `npx wrangler secret put TELEGRAM_CHAT_ID`

3. Deploy:
   `npx wrangler deploy`

4. Check:
   `/health`

5. Manually scan:
   `/trigger`

6. View configured assets:
   `/assets`

7. View signals:
   `/history`

8. View performance:
   `/stats`

## Timing

Cloudflare Cron runs on UTC. The Worker stores UTC timestamps and only converts them to Africa/Lagos for display.

The engine targets the next exact minute boundary after the configured lead time. Default lead is 180 seconds.

## API quota

The engine currently fetches one 1-minute series per active asset each scan. Twelve Data charges credits per symbol in a batch/time-series request, so your plan must support the number of active assets you scan per minute.

## Do not use the automatic outcome tracker as broker-grade settlement

The included outcome tracker uses the provider's closing price as a research metric. It is not an exact IQ Option settlement feed. Replace it with broker-matched outcome data before using the statistics as a production performance claim.
