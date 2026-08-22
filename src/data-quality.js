export function assessCandles(
  candles,
  nowSec = Math.floor(Date.now() / 1000),
  maxAge = 180
) {

  const currentMinute = Math.floor(nowSec / 60) * 60;

  // Only CLOSED 1-minute candles.
  const clean = (candles || [])
    .filter(c => {
      const time = Number(c.time);
      if (!Number.isFinite(time)) return false;
      if (![c.open, c.high, c.low, c.close].every(Number.isFinite)) return false;
      // Reject future candles.
      if (time >= currentMinute) return false;
      // Reject candles that are absurdly old.
      if (nowSec - time > 48 * 60 * 60) return false;
      return true;
    })
    .sort((a, b) => Number(a.time) - Number(b.time));

  if (!clean.length) {
    return {
      ready: false, candles: 0, ageSeconds: null, gaps: null,
      continuity: 0, freshness: 0, countQuality: 0, quality: 0,
      reason: "NO_VALID_CANDLES"
    };
  }

  let gaps = 0;
  for (let i = 1; i < clean.length; i++) {
    const d = clean[i].time - clean[i - 1].time;
    if (d !== 60) {
      if (d > 60) gaps += Math.max(1, Math.round(d / 60) - 1);
      else gaps++; // duplicate/out-of-order interval
    }
  }

  const latest = clean[clean.length - 1];
  const age = Math.max(0, nowSec - Number(latest.time));
  const freshness = Math.max(0, Math.min(1, 1 - age / Math.max(maxAge, 1)));
  const continuity = Math.max(0, Math.min(1, 1 - gaps / Math.max(clean.length - 1, 1)));
  const countQuality = Math.min(1, clean.length / 360);
  const quality = 0.45 * freshness + 0.35 * continuity + 0.20 * countQuality;
  const ready = clean.length >= 300 && gaps === 0 && age <= maxAge;

  return {
    ready, candles: clean.length, ageSeconds: age, gaps,
    continuity, freshness, countQuality, quality,
    reason: clean.length < 300 ? "WARMING_UP" : gaps > 0 ? "GAPS" : age > maxAge ? "STALE" : "READY"
  };
}

