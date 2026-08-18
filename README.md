# LIYOG Blitz AI — Fix Package, Round 4: THE REAL ROOT CAUSE (Aug 2026)

## What we finally found
Your Cloudflare Logs showed every single cron run dying with:
```
"outcome": "exceededCpu", "cpuTimeMs": 10
```

**Free-plan Cloudflare Workers get only 10ms of CPU time per cron
invocation.** Your engine was computing full indicator math (EMA,
RSI, ATR, MACD, ADX, Bollinger Bands) across 3 timeframes for up to
21 assets EVERY MINUTE — genuinely heavy computation that blew past
10ms and got killed before finishing. This is why nothing worked no
matter how good the provider/data-fetching fixes were: the engine
never got far enough to send a signal.

This also explains why your ORIGINAL BTC-only setup worked — 1 asset
was cheap enough to fit under 10ms. Scaling to 21 assets broke it.

## The fix (no $5/month required)
1. **Rotating analysis batches.** Instead of analyzing all ~21 assets
   every tick, the engine now analyzes only 2 assets per run
   (`analysisPerRun`), cycling through the full list using the
   existing `scan_state.cursor` column. Benchmarked: full 3-timeframe
   analysis costs roughly 1-3ms per asset, so 2 assets leaves real
   margin under the 10ms cap.
2. **Cron interval changed from every 1 minute to every 2 minutes.**
   This doesn't add CPU time per tick (that's fixed at 10ms
   regardless of interval) — but it roughly doubles Twelve Data's
   effective safety margin against the 800/day quota, since refresh
   attempts now happen half as often.
3. Every asset still gets analyzed regularly — a full rotation
   through 21 assets at 2/tick, every 2 minutes, takes about 21
   minutes per asset. Slower than the old (broken) "analyze
   everyone every minute" design, but this version actually runs to
   completion instead of being killed every time.

## IMPORTANT — this may still need one more tuning round
I benchmarked the indicator math in a generic Node environment, not
on your actual Cloudflare account, so `analysisPerRun: 2` is an
educated estimate, not a guarantee. After deploying:
- Check Cloudflare Logs again for `"outcome":"exceededCpu"` entries.
- If you still see them, tell me and we'll drop `analysisPerRun` to 1
  via the `ANALYSIS_PER_RUN` environment variable (no code redeploy
  needed — just add/edit that variable in Cloudflare's dashboard).
- If logs look clean (no CPU errors), we can cautiously try raising
  it back up later.

## Files to REPLACE
- `wrangler.toml` — cron changed to `*/2 * * * *`, observability confirmed enabled
- `src/index.js` — rotating analysis batch logic
- `src/config.js` — new `analysisPerRun` setting
- `src/data-orchestrator.js`, `src/db.js`, `src/quota-manager.js`,
  `src/providers/dukascopy.js`, `src/providers/bybit.js`,
  `src/providers/kucoin.js`, `src/providers/fxref.js` — carried over
  from round 3, unchanged in this round

## New optional environment variable
- `ANALYSIS_PER_RUN` — how many assets to analyze per tick. Defaults
  to 2. Lower this to 1 if you still see CPU errors after deploying.

## After deploying
1. Watch Cloudflare Logs for a few ticks (every 2 minutes now, so
   check back after ~10 minutes for several data points).
2. Look specifically for `"outcome"` in the logs — should say
   something other than `"exceededCpu"` (e.g. `"ok"`).
3. Once confirmed clean, give it 30-60 minutes for candles to
   accumulate and the analysis rotation to cover multiple assets,
   then check `/status` and `/trigger?key=...` again.
