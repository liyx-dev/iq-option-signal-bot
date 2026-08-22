export const DEFAULTS = {
  entryLeadMinutes: 2,

  minScore: 76,
  minDataQuality: 0.78,

  // We need enough data for 300 contiguous 1m candles
  // while keeping a small safety buffer.
  candleCount: 360,

  twelveMinuteQuota: 8,
  twelveDailyQuota: 800,

  requestTimeoutMs: 8500,

  // FIX (Aug 2026, FX-only rebuild): with crypto (Bybit/KuCoin)
  // removed entirely, the full subrequest/CPU budget that used to
  // be split between FX and crypto refresh now belongs to FX alone.
  // Raised back up since there's no longer a second asset class
  // competing for the same 50-subrequest ceiling.
  fxRefreshPerRun: 3,

  // Same reasoning — with crypto's analysis slots freed up, FX gets
  // all of analysisPerRun's budget now (no more analysisFxRatio
  // split needed since crypto is gone). Benchmarked: 3 assets/tick
  // measured median ~9.5ms, max ~16ms — too close to the 10ms cap
  // for comfort given how much trouble this exact limit has caused.
  // Kept at 2 for real margin; raise cautiously only after confirming
  // clean "outcome":"ok" logs for a while at this setting.
  analysisPerRun: 2,

  // NEW (Aug 2026, best-of-rotation): rather than sending a signal
  // for the first eligible asset found in a tick, the engine now
  // saves every analysis result and, each run, looks at the single
  // highest-scoring ELIGIBLE asset scored within this window before
  // deciding to send. This window should be long enough to cover a
  // full rotation through all FX pairs at least once (so every pair
  // gets a fair chance to be compared), short enough that a "best"
  // pick isn't acting on stale market conditions.
  // At fxRefreshPerRun=3 / analysisPerRun=2 with ~15 FX pairs and a
  // 2-minute cron, a full analysis rotation takes roughly 15 minutes.
  bestOfWindowMs: 12 * 60 * 1000,

  providerRetries: 2,

  cacheMaxAgeSeconds: 180,

  // Storage retention
  candleRetentionHours: 36,
  signalRetentionDays: 90,
  outcomeRetentionDays: 90,
  quotaRetentionDays: 14,

  // Require strong multi-timeframe agreement
  minMTFAgreement: 0.80
};


export function getConfig(env) {

  return {
    ...DEFAULTS,

    entryLeadMinutes: clampInt(env.ENTRY_LEAD_MINUTES, 2, 1, 3),

    minScore: clampNum(env.MIN_SIGNAL_SCORE, 76, 60, 95),

    minDataQuality: clampNum(env.MIN_DATA_QUALITY, 0.78, 0.5, 0.99),

    candleCount: clampInt(env.CANDLE_COUNT, 360, 300, 500),

    requestTimeoutMs: clampInt(env.REQUEST_TIMEOUT_MS, 8500, 3000, 15000),

    fxRefreshPerRun: clampInt(env.FX_REFRESH_PER_RUN, 3, 1, 8),

    analysisPerRun: clampInt(env.ANALYSIS_PER_RUN, 2, 1, 6),

    bestOfWindowMs: clampInt(env.BEST_OF_WINDOW_MINUTES, 12, 4, 60) * 60 * 1000,

    providerRetries: clampInt(env.PROVIDER_RETRIES, 2, 0, 4),

    cacheMaxAgeSeconds: clampInt(env.CACHE_MAX_AGE_SECONDS, 180, 60, 900),

    minMTFAgreement: clampNum(env.MIN_MTF_AGREEMENT, 0.80, 0.67, 1)
  };
}


function clampNum(v, f, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : f;
}


function clampInt(v, f, min, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : f;
}

