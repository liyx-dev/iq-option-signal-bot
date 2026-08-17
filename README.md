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

# LIYOG Blitz AI — Fix Package, Round 2 (Aug 2026)

## What changed since round 1
Your `/health` check after round 1 showed real progress (FX pairs went
from 3 READY to 11 READY — the gap-priority fix works) but revealed two
new problems:
- **Bybit → HTTP 403.** Cloudflare Workers' IP ranges are blocked by
  Bybit too, same class of problem as Binance's HTTP 451.
- **KuCoin → HTTP 429.** Not blocked, just rate-limited — because
  crypto refresh was hitting ALL 6 crypto pairs every single minute,
  which is too fast for KuCoin's public tier.

## Round 2 fixes
- Replaced Bybit with **CryptoCompare** (`min-api.cryptocompare.com`)
  as the primary crypto candle source — no key required, purpose-built
  for OHLCV data, and separate infrastructure from Binance/Bybit so it
  isn't subject to the same IP blocking.
- Crypto refresh is now **capped and prioritized** the same way FX
  already was (`cryptoRefreshPerRun`, default 3) — it no longer fires
  a request for every crypto pair every minute, which is what was
  tripping KuCoin's rate limiter.
- KuCoin kept as the crypto fallback behind CryptoCompare, now used
  far less often so it should stop 429-ing.

## Files to REPLACE in your GitHub repo (same path, overwrite content)
- `src/index.js`
- `src/data-orchestrator.js`
- `src/config.js`
- `src/db.js`
- `src/quota-manager.js`
- `src/providers/dukascopy.js`
- `src/providers/kucoin.js` (unchanged from round 1, included for completeness)

## Files to ADD (new)
- `src/providers/cryptocompare.js`
- `src/providers/fxref.js` (if not already added from round 1)

## Files to DELETE from your repo
- `src/providers/binance.js` (if not already deleted)
- `src/providers/oanda.js` (if not already deleted)
- `src/providers/bybit.js` — **new in this round**: Bybit is blocked
  (HTTP 403) from Cloudflare's network, same as Binance. Remove it.

## New environment variable (optional)
- `CRYPTO_REFRESH_PER_RUN` — how many crypto pairs to refresh per
  cron tick. Defaults to 3 if not set. You don't need to add this
  unless you want to tune it later.

## SQL (only if you haven't run it yet from round 1)
- `add_crypto_pairs.sql` — adds ETH/SOL/XRP/LTC/DOGE to the asset
  registry. Edit it first to remove any pair not actually on your IQ
  Option Blitz asset list before running it.

## After deploying
1. Wait for a few cron ticks (runs every minute automatically).
2. Check `/health` — expect to see `cryptocompare` (UP) and `kucoin`
   (ideally UP now, or at least no longer showing rapid 429s), with
   `bybit` and `binance` both gone from the list entirely (once their
   old rows age out — they'll just stop updating, which is fine).
3. Check `/status` — crypto pairs (BTC, ETH, SOL, etc.) should start
   accumulating candles and move toward READY over the next 10-20
   minutes, same as the FX pairs did in round 1.
4. Manual trigger: `https://iq-option-signal-bot.goddayprincess1.workers.dev/trigger?key=YOUR_ADMIN_SECRET`
