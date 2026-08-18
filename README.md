# LIYOG Blitz AI — Fix Package, Round 5: SUBREQUEST LIMIT (Aug 2026)

## What broke this time
Your live stack trace showed the CPU fix worked (464ms used, not
killed for CPU) but hit a NEW wall:
```
"Too many API requests by single Worker invocation."
at getScanCursor (index.js:205:76)
at runEngine (index.js:1417:32)
```

**Free-plan Workers cap total subrequests (every individual fetch()
call AND every individual D1 query) at 50 per invocation.** Three
things were each quietly burning through this budget:

1. `saveCandles()` was inserting candles ONE ROW AT A TIME — up to
   360 separate D1 calls to save a single asset's candle history.
2. `rankByPriorityAndUrgency()` (the smart-refresh-priority logic
   from round 3) called a full candle load PER ASSET just to compute
   urgency — ~21 extra D1 calls before any actual refresh happened.
3. `reserveQuota()` made 4 separate D1 calls per check, called twice
   per Twelve Data reservation (minute + day window) = 8 calls per
   asset just for quota bookkeeping.

Combined, a single run could easily need 100+ subrequests — Cloudflare
correctly refused after 50.

## The fix
1. **`saveCandles()` now uses `db.batch()`** — sends all candle
   INSERTs as ONE subrequest instead of one-per-row.
2. **`rankByPriorityAndUrgency()` now uses ONE aggregate SQL query**
   per asset group (FX or crypto) instead of loading full candle
   history for every asset individually.
3. **`reserveQuota()` now does the check-and-reserve in a single
   atomic UPDATE** instead of SELECT-then-UPDATE-then-SELECT,
   cutting it from 4 D1 calls to 2.
4. **`fxRefreshPerRun` and `cryptoRefreshPerRun` both lowered to 2**
   to leave real margin — hand-counted worst-case subrequest total
   now comes to ~38-42 per run, safely under the 50 cap.
5. **`cleanupStorage()` now only runs once every ~30 ticks** instead
   of every run, freeing 4 more subrequests of headroom most of the
   time.

## Files to REPLACE
- `wrangler.toml` (unchanged from round 4)
- `src/index.js` — cleanup now gated to every ~30th tick
- `src/db.js` — batched candle saves, atomic quota reservation
- `src/config.js` — fxRefreshPerRun and cryptoRefreshPerRun both default to 2
- `src/refresh-priority.js` — aggregate query instead of per-asset loads
- `src/data-orchestrator.js`, `src/quota-manager.js`,
  `src/providers/*` — unchanged from round 4, included for completeness

## What to expect after deploying
1. Check Cloudflare Logs — a healthy run should just complete, no
   `"exceededCpu"` and no "Too many API requests" exception.
2. This is now a lighter engine per tick (2 FX + 2 crypto refreshed,
   2 assets analyzed, every 2 minutes). It will take longer to warm
   up and cycle through all pairs, but should now run to completion
   instead of dying every time.
3. Once logs look clean for a few ticks, give it real time (an hour
   or more) for candles to accumulate, then check `/status` and
   `/trigger?key=...` again.

