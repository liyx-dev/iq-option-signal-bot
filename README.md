# LIYOG Blitz AI — FX-ONLY, BEST-OF-ROTATION (Aug 2026)

## What changed

**1. Crypto removed entirely.** No more Bybit/KuCoin/CoinGecko calls,
no more crypto assets analyzed. All subrequest/CPU budget that used
to be split across two asset classes now belongs to FX alone —
subrequest budget is now ~30/50 per run (was ~44/50), giving real
margin instead of the tight squeeze we kept hitting.

**2. Best-of-rotation-window signal selection — what you asked for.**
Important nuance: analyzing all ~15 FX pairs in a single tick still
isn't possible under the 10ms CPU cap (benchmarked: 3 assets alone
hit 9.5-16ms). So instead: every tick analyzes a small rotating
batch (2 assets) as before, but now SAVES every result — eligible or
not — to a new `recent_scores` table. Each run then looks at every
asset scored within the last `bestOfWindowMs` (default 12 minutes,
roughly one full rotation cycle) and sends a signal ONLY for the
single highest-scoring ELIGIBLE one. This is "loop through all, pick
the strongest" — spread across a rotation window instead of one
impossible instant, and only one signal is sent per run.

Before sending, the winning asset is re-analyzed fresh (not just
using the stored score) — if market conditions moved and it's no
longer eligible, the engine correctly skips rather than sending
stale information.

**3. New `/scores` diagnostic endpoint.** Shows every FX asset's most
recent score, direction, confidence, and `distanceFromThreshold`
(how far each score is from `MIN_SIGNAL_SCORE`). Fastest way to
judge whether 76 is realistically achievable without guessing.

## New database table — MUST run this migration first
`add_recent_scores.sql` — creates the `recent_scores` table the new
selection logic depends on. Run via Cloudflare Dashboard → D1 →
trading_db → Console, BEFORE deploying the new code.

## Also run (optional but recommended)
`disable_crypto.sql` — sets `enabled=0` on crypto assets rather than
deleting them, so history is preserved and they can be re-enabled
later for a separate crypto-focused Worker if you build one.

## Files to REPLACE
All of `src/` except `providers/twelvedata.js` and
`providers/coingecko.js` (both unchanged, keep your existing ones).

## Files to DELETE from your repo
- `src/providers/bybit.js`
- `src/providers/kucoin.js`
- `src/providers/cryptocompare.js`
- `src/providers/fxref.js`

## Variables — what changed
- `CRYPTO_REFRESH_PER_RUN` — no longer read, safe to remove
- `ANALYSIS_FX_RATIO` — no longer read, safe to remove
- `FX_REFRESH_PER_RUN` — now defaults to 3 (was 2)
- `ANALYSIS_PER_RUN` — stays at 2 (kept conservative — see CPU note)
- NEW: `BEST_OF_WINDOW_MINUTES` — rotation window to compare scores
  over before picking the best. Defaults to 12. Optional.

## Honest note on analysisPerRun
Benchmarked 3 assets/tick at median ~9.5ms, max ~16ms — too close to
the 10ms cap given how much trouble this exact limit caused before.
Kept at 2 for real margin. If logs stay clean for a while, we can
consider raising it later.

## New endpoint: /scores
```
GET /scores
```
No auth required. Shows the full score distribution across all FX
assets, with a summary (average score, highest score, count scored).

## What to check after deploying
1. Run both SQL migrations first.
2. Deploy the code.
3. Check Cloudflare Logs — confirm "outcome":"ok", no CPU/subrequest errors.
4. Wait ~15-20 minutes (one full rotation), then check `/scores`.
5. `/trigger?key=...` now shows `scored` count and `bestCandidate`
   (whatever's currently winning the window, even if not yet sent).

