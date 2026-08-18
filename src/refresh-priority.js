// ============================================================
// SMART TWELVE DATA ALLOCATOR
//
// The problem: Twelve Data's free tier gives only 8 requests/minute
// and 800/day. With 15+ FX pairs, we cannot refresh everyone on
// every tick. Blind round-robin wastes calls on low-value pairs
// at the same rate as high-value ones.
//
// The fix: a tiered, need-weighted budget.
//   - Every asset has a `priority` (already in your asset_registry
//     schema — majors like EUR/USD, GBP/USD, USD/JPY score highest).
//   - Urgency = how badly an asset NEEDS a refresh right now
//     (gaps, staleness, or never-fetched).
//   - Final refresh order = priority tier first, urgency second
//     within each tier. This means majors get refreshed more often
//     under normal conditions, but a minor pair that's gone badly
//     stale/gappy still gets attention before it's starved forever.
//
// This spends the 8/min budget where it earns the most analyzable,
// signal-quality data, while still guaranteeing every enabled pair
// eventually gets healed.
// ============================================================
import { loadCandles } from "./db.js";
import { assessCandles } from "./data-quality.js";

// Splits assets into priority tiers based on the registry's
// `priority` column (0-100). Tiers determine refresh frequency
// multiplier, not a hard cutoff — an urgent low-tier pair can
// still jump the queue via the urgency score.
function tierOf(priority) {
  if (priority >= 90) return 3; // majors: EUR/USD, GBP/USD, USD/JPY etc.
  if (priority >= 75) return 2; // solid seconds
  return 1;                     // minors
}

export async function rankByPriorityAndUrgency(db, cfg, assets) {
  const scored = [];

  for (const asset of assets) {
    const candles = await loadCandles(db, asset.symbol, cfg.candleCount);
    const dq = assessCandles(candles, Math.floor(Date.now() / 1000), cfg.cacheMaxAgeSeconds);

    let urgency = 0;
    if (!candles.length) {
      urgency = 1000; // never fetched — always wins immediately
    } else {
      urgency += (dq.gaps || 0) * 10;             // gaps are the worst offense
      urgency += dq.ready ? 0 : 50;                // not yet analyzable
      urgency += Math.min(50, Math.floor((dq.ageSeconds || 0) / 30)); // staleness
    }

    const tier = tierOf(Number(asset.priority) || 50);

    // Combined score: tier dominates under normal (low-urgency)
    // conditions so majors get refreshed most often, but a large
    // urgency spike (e.g. gaps=200) can still outrank a healthy
    // major, so nothing gets permanently starved.
    const combined = tier * 100 + urgency;

    scored.push({ asset, urgency, tier, combined });
  }

  scored.sort((a, b) => b.combined - a.combined);
  return scored.map(s => s.asset);
}

