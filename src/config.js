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

    entryLeadMinutes:
      clampInt(
        env.ENTRY_LEAD_MINUTES,
        2,
        1,
        3
      ),

    minScore:
      clampNum(
        env.MIN_SIGNAL_SCORE,
        80,
        60,
        95
      ),

    minDataQuality:
      clampNum(
        env.MIN_DATA_QUALITY,
        0.85,
        0.5,
        0.99
      ),

    maxSignalsPerRun:
      clampInt(
        env.MAX_SIGNALS_PER_RUN,
        2,
        1,
        5
      ),

    candleCount:
      clampInt(
        env.CANDLE_COUNT,
        360,
        300,
        500
      ),

    requestTimeoutMs:
      clampInt(
        env.REQUEST_TIMEOUT_MS,
        8500,
        3000,
        15000
      ),

    fxRefreshPerRun:
      clampInt(
        env.FX_REFRESH_PER_RUN,
        4,
        1,
        8
      ),

    providerRetries:
      clampInt(
        env.PROVIDER_RETRIES,
        2,
        0,
        4
      ),

    cacheMaxAgeSeconds:
      clampInt(
        env.CACHE_MAX_AGE_SECONDS,
        180,
        60,
        900
      ),

    minMTFAgreement:
      clampNum(
        env.MIN_MTF_AGREEMENT,
        0.80,
        0.67,
        1
      )
  };
}


function clampNum(v, f, min, max) {

  const n = Number(v);

  return Number.isFinite(n)
    ? Math.min(max, Math.max(min, n))
    : f;
}


function clampInt(v, f, min, max) {

  const n = Math.floor(Number(v));

  return Number.isFinite(n)
    ? Math.min(max, Math.max(min, n))
    : f;
}

