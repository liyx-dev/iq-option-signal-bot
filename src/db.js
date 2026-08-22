// ============================================================
// DATABASE LAYER (Cloudflare D1 / SQLite)
//
// All raw SQL for the engine lives here. Nothing outside this
// file should touch env.DB directly except index.js's small
// admin endpoints (/history, /outcome).
// ============================================================

export async function getAssets(db) {
  const { results } = await db
    .prepare("SELECT * FROM asset_registry WHERE enabled=1 ORDER BY priority DESC, symbol")
    .all();
  return results || [];
}

export async function saveCandles(db, symbol, candles, source, quality) {
  if (!candles?.length) return;

  // FIX (Aug 2026): Free-plan Workers cap subrequests (including
  // each individual D1 query) at 50 per invocation. Writing 360
  // candles with 360 separate INSERT calls blew straight past that
  // limit and threw "Too many API requests by single Worker
  // invocation" — confirmed via live stack trace. db.batch() sends
  // every statement in ONE subrequest instead of one-per-row, so a
  // full 360-candle write now costs exactly 1 subrequest, not 360.
  const rows = candles.slice(-360);

  const stmt = db.prepare(`
    INSERT INTO market_candles
    (symbol, timeframe_seconds, candle_time, open, high, low, close, volume, source, quality, received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol, timeframe_seconds, candle_time)
    DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
      volume=excluded.volume, source=excluded.source, quality=excluded.quality,
      received_at=excluded.received_at
  `);

  const now = Date.now();
  const batch = rows.map(c =>
    stmt.bind(symbol, 60, c.time, c.open, c.high, c.low, c.close, c.volume || 0, source, quality, now)
  );

  await db.batch(batch);
}

export async function loadCandles(db, symbol, count = 360) {
  const { results } = await db
    .prepare(`
      SELECT candle_time AS time, open, high, low, close, volume, source
      FROM market_candles
      WHERE symbol=? AND timeframe_seconds=60
      ORDER BY candle_time DESC LIMIT ?
    `)
    .bind(symbol, count)
    .all();

  return (results || [])
    .reverse()
    .map(c => ({
      ...c,
      time: Number(c.time),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    }));
}

export async function providerHealth(db, provider, ok, latencyMs, errorCode = null) {
  const now = Date.now();
  await db
    .prepare(`
      INSERT INTO provider_state(provider, status, last_success, last_error, last_error_code, latency_ms, consecutive_errors, updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(provider) DO UPDATE SET
        status=excluded.status,
        last_success=CASE WHEN excluded.status='UP' THEN excluded.last_success ELSE provider_state.last_success END,
        last_error=CASE WHEN excluded.status='UP' THEN provider_state.last_error ELSE excluded.last_error END,
        last_error_code=excluded.last_error_code,
        latency_ms=excluded.latency_ms,
        consecutive_errors=CASE WHEN excluded.status='UP' THEN 0 ELSE provider_state.consecutive_errors+1 END,
        updated_at=excluded.updated_at
    `)
    .bind(provider, ok ? "UP" : "DOWN", ok ? now : null, ok ? null : now, errorCode, latencyMs || null, ok ? 0 : 1, now)
    .run();
}

export async function quotaUsed(db, provider, windowType, windowKey) {
  const row = await db
    .prepare("SELECT used,quota FROM quota_usage WHERE provider=? AND window_type=? AND window_key=?")
    .bind(provider, windowType, windowKey)
    .first();
  return row ? { used: Number(row.used), quota: Number(row.quota) } : { used: 0, quota: 0 };
}

// FIX (Aug 2026): the original reserveQuota made 4 separate D1 calls
// (INSERT OR IGNORE, SELECT, UPDATE, SELECT). Called twice per
// Twelve Data reservation (minute window + day window), that's 8 D1
// subrequests just to check quota for ONE asset — with
// fxRefreshPerRun=4 that alone was 32 subrequests per run, a major
// contributor to blowing past Cloudflare Free's 50-subrequest cap
// (confirmed via live "Too many API requests" stack trace).
//
// This version does it in 2 D1 calls total: one INSERT OR IGNORE to
// seed the row if it doesn't exist, then a single atomic UPDATE
// whose WHERE clause both checks AND reserves in one round trip
// (SQLite guarantees this is atomic — no separate read-then-write
// race window). We check rows-affected to know if it succeeded,
// no follow-up SELECT needed.
export async function reserveQuota(db, provider, windowType, windowKey, quota, credits = 1) {
  const now = Date.now();

  await db
    .prepare(`INSERT OR IGNORE INTO quota_usage(provider,window_type,window_key,used,quota,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(provider, windowType, windowKey, 0, quota, now)
    .run();

  const result = await db
    .prepare(`UPDATE quota_usage SET used=used+?,updated_at=? WHERE provider=? AND window_type=? AND window_key=? AND used+?<=?`)
    .bind(credits, now, provider, windowType, windowKey, credits, quota)
    .run();

  // D1's run() result includes meta.changes — 1 if the UPDATE's WHERE
  // clause matched (meaning there was room and the reservation
  // succeeded), 0 if the quota was already full so nothing matched.
  return (result?.meta?.changes || 0) > 0;
}

// Gives back previously-reserved credits. Used when a multi-window
// reservation partially succeeds (e.g. minute quota reserved, day
// quota then fails) so the partial reservation isn't lost forever.
export async function releaseQuota(db, provider, windowType, windowKey, credits = 1) {
  const now = Date.now();
  await db
    .prepare(`UPDATE quota_usage SET used=MAX(0, used-?),updated_at=? WHERE provider=? AND window_type=? AND window_key=?`)
    .bind(credits, now, provider, windowType, windowKey)
    .run();
}

// FIX (Aug 2026): analysis now needs two INDEPENDENT rotation
// cursors (FX and crypto) instead of one shared cursor, so FX pairs
// can get more frequent analysis attention without crypto ever
// being fully starved. Rather than a schema migration for a second
// scan_state row, this reuses the existing quota_usage table's
// flexible (provider, window_type, window_key, used) shape as a
// simple keyed cursor store — "used" holds the cursor value.
export async function getScanCursor(db, group = "default") {
  const row = await db
    .prepare("SELECT used FROM quota_usage WHERE provider='scan_cursor' AND window_type=? AND window_key='cursor'")
    .bind(group)
    .first();
  return Number(row?.used || 0);
}

export async function setScanCursor(db, cursor, group = "default") {
  const now = Date.now();
  await db
    .prepare(`
      INSERT INTO quota_usage(provider,window_type,window_key,used,quota,updated_at)
      VALUES('scan_cursor',?,'cursor',?,999999,?)
      ON CONFLICT(provider,window_type,window_key) DO UPDATE SET used=excluded.used, updated_at=excluded.updated_at
    `)
    .bind(group, cursor, now)
    .run();
}

// ============================================================
// RECENT SCORES — best-of-batch signal selection
//
// Every time an asset is analyzed (whether eligible or not), its
// result is upserted here. This lets the engine compare ALL
// recently-scored assets — not just the 1-2 in this exact tick's
// rotation batch — and send a signal only for the single strongest
// one across a full rotation window, per the user's request.
// ============================================================

export async function saveScore(db, symbol, result) {
  await db.prepare(`
    INSERT INTO recent_scores
    (symbol,direction,score,confidence,data_quality,agreement,regime,setup,reason,external_confirmation,eligible,scored_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol) DO UPDATE SET
      direction=excluded.direction, score=excluded.score, confidence=excluded.confidence,
      data_quality=excluded.data_quality, agreement=excluded.agreement, regime=excluded.regime,
      setup=excluded.setup, reason=excluded.reason, external_confirmation=excluded.external_confirmation,
      eligible=excluded.eligible, scored_at=excluded.scored_at
  `).bind(
    symbol, result.direction || null, result.score ?? null, result.confidence ?? null,
    result.dataQuality ?? null, result.agreement ?? null, result.regime || null,
    result.setup || null, result.reason || null, result.externalConfirmation || null,
    result.eligible ? 1 : 0, Date.now()
  ).run();
}

// Returns the single highest-scoring ELIGIBLE asset scored within
// the last `maxAgeMs` — the "best of a full rotation window" the
// user asked for, without needing to recompute all assets in one
// CPU-limited tick.
export async function getBestRecentScore(db, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  const row = await db.prepare(`
    SELECT * FROM recent_scores
    WHERE eligible=1 AND scored_at >= ?
    ORDER BY score DESC LIMIT 1
  `).bind(cutoff).first();
  return row || null;
}

// Full distribution for the /scores diagnostic endpoint — every
// asset's most recent score, freshest first, regardless of whether
// it was eligible.
export async function getAllRecentScores(db) {
  const { results } = await db.prepare(`
    SELECT * FROM recent_scores ORDER BY scored_at DESC
  `).all();
  return results || [];
}
    

export async function cleanupStorage(db, cfg) {
  const now = Date.now();

  const candleCutoff = now - cfg.candleRetentionHours * 60 * 60 * 1000;
  const signalCutoff = now - cfg.signalRetentionDays * 24 * 60 * 60 * 1000;
  const outcomeCutoff = now - cfg.outcomeRetentionDays * 24 * 60 * 60 * 1000;
  const quotaCutoff = now - cfg.quotaRetentionDays * 24 * 60 * 60 * 1000;

  await db.prepare(`DELETE FROM market_candles WHERE timeframe_seconds=60 AND received_at < ?`).bind(candleCutoff).run();
  await db.prepare(`DELETE FROM signals WHERE timestamp < ?`).bind(signalCutoff).run();
  await db.prepare(`DELETE FROM signal_outcomes WHERE observed_at < ?`).bind(outcomeCutoff).run();
  await db.prepare(`DELETE FROM quota_usage WHERE updated_at < ?`).bind(quotaCutoff).run();

  return {
    status: "cleaned",
    candleRetentionHours: cfg.candleRetentionHours,
    signalRetentionDays: cfg.signalRetentionDays,
    outcomeRetentionDays: cfg.outcomeRetentionDays,
    quotaRetentionDays: cfg.quotaRetentionDays
  };
}

