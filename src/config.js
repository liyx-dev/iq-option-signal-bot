export const DEFAULTS = {
  entryLeadMinutes: 2,
  minScore: 76,
  minDataQuality: 0.78,
  maxSignalsPerRun: 3,
  candleCount: 160,
  maxCandleAgeSeconds: 95,
  twelveMinuteQuota: 8,
  twelveDailyQuota: 800,
  requestTimeoutMs: 8500,
};

export function getConfig(env) {
  return {
    ...DEFAULTS,
    entryLeadMinutes: clampInt(env.ENTRY_LEAD_MINUTES, 2, 1, 3),
    minScore: clampNum(env.MIN_SIGNAL_SCORE, 76, 60, 95),
    minDataQuality: clampNum(env.MIN_DATA_QUALITY, 0.78, 0.5, 0.99),
    maxSignalsPerRun: clampInt(env.MAX_SIGNALS_PER_RUN, 3, 1, 8),
    candleCount: clampInt(env.CANDLE_COUNT, 160, 80, 300),
    requestTimeoutMs: clampInt(env.REQUEST_TIMEOUT_MS, 8500, 3000, 15000),
  };
}

function clampNum(v, fallback, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function clampInt(v, fallback, min, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

