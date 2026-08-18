export const DEFAULTS = {
  entryLeadMinutes: 2,

  minScore: 80,
  minDataQuality: 0.85,

  maxSignalsPerRun: 2,

  // We need enough data for 300 contiguous 1m candles
  // while keeping a small safety buffer.
  candleCount: 360,

  maxCandleAgeSeconds: 180,

  twelveMinuteQuota: 8,
  twelveDailyQuota: 800,

  requestTimeoutMs: 8500,

  fxRefreshPerRun: 4,

  // FIX (Aug 2026): crypto used to refresh EVERY enabled crypto pair
  // EVERY run (once a minute), which was firing 6 rapid-fire requests
  // at KuCoin the moment CryptoCompare/Bybit failed, tripping its
  // rate limiter (HTTP 429). Capped the same way FX already was.
  cryptoRefreshPerRun: 3,

  // FIX (Aug 2026): Cloudflare Workers FREE plan allows only 10ms of
  // CPU time per cron invocation. Running full indicator math
  // (EMA/RSI/ATR/MACD/ADX/Bollinger x 3 timeframes) for all ~21
  // assets every tick blew past that limit and the Worker was
  // killed mid-run every single time ("outcome":"exceededCpu" in
  // live logs). Analysis now processes a small rotating slice of
  // assets per run instead — every asset still gets analyzed
  // regularly as the cursor cycles through, but each individual
  // tick does far less work.
  // Benchmarked: full 3-timeframe indicator math costs roughly
  // 1-3ms of real CPU time per asset. Free-plan Workers get only
  // 10ms total per cron tick, and other work in runEngine() (D1
  // row mapping, JSON building, gap/urgency scoring) also eats
  // into that budget. Kept deliberately small with real margin.
  analysisPerRun: 2,

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

    minScore: clampNum(env.MIN_SIGNAL_SCORE, 80, 60, 95),

    minDataQuality: clampNum(env.MIN_DATA_QUALITY, 0.85, 0.5, 0.99),

    maxSignalsPerRun: clampInt(env.MAX_SIGNALS_PER_RUN, 2, 1, 5),

    candleCount: clampInt(env.CANDLE_COUNT, 360, 300, 500),

    requestTimeoutMs: clampInt(env.REQUEST_TIMEOUT_MS, 8500, 3000, 15000),

    fxRefreshPerRun: clampInt(env.FX_REFRESH_PER_RUN, 4, 1, 8),

    cryptoRefreshPerRun: clampInt(env.CRYPTO_REFRESH_PER_RUN, 3, 1, 6),

    analysisPerRun: clampInt(env.ANALYSIS_PER_RUN, 2, 1, 5),

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

