// ============================================================
// SMART TWELVE DATA ALLOCATOR
//
// Ranking logic: priority tier first (majors like EUR/USD, GBP/USD,
// USD/JPY get refreshed more often under normal conditions), urgency
// (coverage gap + staleness) breaks ties AND can override tier when
// a lower-priority pair has gone badly stale.
//
// FIX (Aug 2026): live /status data over several hours showed
// low-priority pairs (CHFJPY, EURCAD, NZDCAD — all priority 70)
// stuck 25+ hours stale while higher-tier pairs kept getting
// refreshed every cycle. Root cause: urgency was capped at 100
// (`Math.min(100, ...)`) while tier contributed 100-300 to the
// combined score — so a starved tier-1 pair (max combined: 100+100
// =200) could NEVER outrank a healthy tier-3 pair (300+0=300), no
// matter how stale it got. The "nothing is ever starved" comment
// was aspirational but the math didn't deliver it. Fixed by scaling
// urgency's ceiling well above the maximum possible tier gap, so
// genuine staleness can break through and force a refresh.
// ============================================================

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

  // Tier contributes at most 300 (tier 3 x 100). Urgency's ceiling
  // is set well above that (2000) so a sufficiently stale/gappy pair
  // can always eventually outrank even a perfectly healthy major —
  // this is what actually guarantees no pair is starved forever.
  const MAX_URGENCY = 2000;

  const scored = assets.map(asset => {
    const h = health.get(asset.symbol);

    let urgency;
    if (!h || h.candleCount === 0) {
      urgency = MAX_URGENCY; // never fetched — always wins immediately
    } else {
      const ageSeconds = Math.max(0, nowSec - h.latestTime);
      const coverageGap = Math.max(0, cfg.candleCount - h.candleCount);
      // Staleness grows without an artificial cap now — a pair that's
      // gone hours stale accumulates enough urgency to beat any tier.
      urgency = Math.min(MAX_URGENCY, coverageGap * 2 + Math.floor(ageSeconds / 30));
    }

    const tier = tierOf(Number(asset.priority) || 50);
    const combined = tier * 100 + urgency;

    return { asset, urgency, tier, combined };
  });

  scored.sort((a, b) => b.combined - a.combined);
  return scored.map(s => s.asset);
}

