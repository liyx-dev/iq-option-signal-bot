# LIYOG Blitz AI — Fix Package (Aug 2026)

## What changed and why
- Binance was returning HTTP 451 (geo-blocked from Cloudflare's network) — replaced with Bybit (primary) + KuCoin (fallback), both key-free and not geo-blocked.
- Dukascopy's free candle API is retired — replaced with a harmless stub so it can't waste time in the fallback chain.
- OANDA removed (you can't get Nigerian-eligible credentials) — no longer imported anywhere.
- Fixed the bug causing 12 of 15 FX pairs to stay stuck "WARMING_UP" forever: the refresh logic now prioritizes whichever assets have gaps or stale data, instead of a blind round-robin.
- Fixed a Twelve Data quota leak where a failed reservation could silently burn a minute-credit without giving it back.
- Fixed `/trigger` and `/outcome` auth to also accept `?key=YOUR_ADMIN_SECRET` in the URL, so you can trigger a run straight from your phone's browser address bar.
- Added support for more crypto pairs (ETH, SOL, XRP, LTC, DOGE) via `add_crypto_pairs.sql` — only enable the ones your IQ Option Blitz asset list actually offers.

## Files to REPLACE in your GitHub repo (same path, overwrite content)
- `src/index.js`
- `src/data-orchestrator.js`
- `src/db.js`
- `src/quota-manager.js`
- `src/providers/dukascopy.js`

## Files to ADD (new paths)
- `src/providers/bybit.js`
- `src/providers/kucoin.js`
- `src/providers/fxref.js`

## Files to DELETE from your repo
- `src/providers/binance.js`
- `src/providers/oanda.js`

## SQL to run once against your D1 database
- `add_crypto_pairs.sql` — via Cloudflare Dashboard → D1 → trading_db → Console. Edit it first to remove any pair not actually on your IQ Option Blitz asset list.

## After deploying
1. Wait a few minutes for at least one cron tick to run (cron runs every minute automatically — you don't need to trigger it manually).
2. Check `https://iq-option-signal-bot.goddayprincess1.workers.dev/health` — you should see `bybit` and `kucoin` instead of `binance`, and `dukascopy` should stop accumulating errors (still shows DOWN, but consecutive_errors won't matter since it's now instant/free to call).
3. Check `/status` — over the following ~10-15 minutes, watch more FX pairs flip from `WARMING_UP` to `READY` as gaps get healed.
4. If you still want to manually trigger a run: `https://iq-option-signal-bot.goddayprincess1.workers.dev/trigger?key=YOUR_ADMIN_SECRET`

