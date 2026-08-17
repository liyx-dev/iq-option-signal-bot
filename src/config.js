export const DEFAULTS = {
  entryLeadMinutes: 2,
  minScore: 76,
  minDataQuality: 0.78,
  maxSignalsPerRun: 3,

  candleCount: 320,

  maxCandleAgeSeconds: 95,

  twelveMinuteQuota: 8,
  twelveDailyQuota: 800,

  requestTimeoutMs: 8500,

  fxRefreshPerRun: 4,
  providerRetries: 2,
  cacheMaxAgeSeconds: 180
};

export function getConfig(env) {
  return {...DEFAULTS,
    entryLeadMinutes: clampInt(env.ENTRY_LEAD_MINUTES,2,1,3),
    minScore: clampNum(env.MIN_SIGNAL_SCORE,76,60,95),
    minDataQuality: clampNum(env.MIN_DATA_QUALITY,.78,.5,.99),
    maxSignalsPerRun: clampInt(env.MAX_SIGNALS_PER_RUN,3,1,8),
    candleCount: clampInt(env.CANDLE_COUNT,160,80,300),
    requestTimeoutMs: clampInt(env.REQUEST_TIMEOUT_MS,8500,3000,15000),
    fxRefreshPerRun: clampInt(env.FX_REFRESH_PER_RUN,4,1,8),
    providerRetries: clampInt(env.PROVIDER_RETRIES,2,0,4),
    cacheMaxAgeSeconds: clampInt(env.CACHE_MAX_AGE_SECONDS,180,60,900)
  };
}
function clampNum(v,f,min,max){const n=Number(v);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):f}
function clampInt(v,f,min,max){const n=Math.floor(Number(v));return Number.isFinite(n)?Math.min(max,Math.max(min,n)):f}
