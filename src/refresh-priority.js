// ============================================================
// SMART TWELVE DATA ALLOCATOR
//
// FIX (Aug 2026): the original version called loadCandles() (a full
// SELECT of up to 360 rows) ONCE PER ASSET just to compute urgency —
// ~21 separate D1 subrequests before a single refresh even started.
// Combined with saveCandles' old per-row INSERT loop, this blew past
// Cloudflare Free plan's 50-subrequest-per-invocation cap and the
// engine threw "Too many API requests by single Worker invocation"
// on every run (confirmed via live stack trace).
//
// This version replaces per-asset loadCandles calls with ONE cheap
// aggregate SQL query per asset group (FX or crypto) that computes
// candle count + latest candle time directly in SQLite — a single
// subrequest covers the whole group instead of one per asset.
//
// Ranking logic unchanged: priority tier first (majors like EUR/USD,
// GBP/USD, USD/JPY get refreshed more often), urgency (coverage gap
// + staleness) breaks ties and lets a badly-behind minor pair still
// jump the queue so nothing is permanently starved.
// ============================================================
import { assessCandles } from "./data-quality.js";

function tierOf(priority) {
  if (priority >= 90) return 3; // majors
  if (priority >= 75) return 2; // solid seconds
  return 1;                     // minors
}

// One aggregate query per group: for every symbol in `symbols`,
// get how many candles it has and how recent the latest one is.
// Does NOT fetch full candle rows, so it stays cheap regardless of
// how many candles each asset has stored.
async function getHealthSummary(db, symbols) {
  if (!symbols.length) return new Map();

  const placeholders = symbols.map(() => "?").join(",");
  const { results } = await db
    .prepare(`
      SELECT symbol, COUNT(*) AS candleCount, MAX(candle_time) AS latestTime
      FROM market_candles
      WHERE timeframe_seconds = 60 AND symbol IN (${placeholders})
      GROUP BY symbol
    `)
    .bind(...symbols)
    .all();

  const map = new Map();
  for (const row of results || []) {
    map.set(row.symbol, { candleCount: Number(row.candleCount) || 0, latestTime: Number(row.latestTime) || 0 });
  }
  return map;
}

export async function rankByPriorityAndUrgency(db, cfg, assets) {
  if (!assets.length) return [];

  const symbols = assets.map(a => a.symbol);
  const health = await getHealthSummary(db, symbols);
  const nowSec = Math.floor(Date.now() / 1000);

  const scored = assets.map(asset => {
    const h = health.get(asset.symbol);

    let urgency;
    if (!h || h.candleCount === 0) {
      urgency = 1000; // never fetched — always wins immediately
    } else {
      const ageSeconds = Math.max(0, nowSec - h.latestTime);
      // Lightweight staleness/coverage proxy without loading every
      // row: fewer candles than the target window, or an old latest
      // candle, both signal "needs a refresh".
      const coverageGap = Math.max(0, cfg.candleCount - h.candleCount);
      urgency = coverageGap * 2 + Math.min(100, Math.floor(ageSeconds / 30));
    }

    const tier = tierOf(Number(asset.priority) || 50);
    const combined = tier * 100 + urgency;

    return { asset, urgency, tier, combined };
  });

  scored.sort((a, b) => b.combined - a.combined);
  return scored.map(s => s.asset);
}
