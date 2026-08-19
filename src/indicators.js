// ============================================================
// INDICATOR ENGINE
//
// Pure local computation — no provider indicator endpoints needed.
// Combines EMA/RSI/ATR/MACD/ADX/Bollinger with support/resistance
// swing structure and candle body/wick stats for a fuller picture
// of each timeframe.
// ============================================================

export function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

export function atr(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
  });
  const out = new Array(candles.length).fill(null);
  if (tr.length <= period) return out;
  let a = tr.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  out[period] = a;
  for (let i = period + 1; i < tr.length; i++) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast), es = ema(values, slow);
  const line = values.map((_, i) => ef[i] - es[i]);
  const sig = ema(line.slice(slow), signal);
  const full = new Array(values.length).fill(null);
  const hist = new Array(values.length).fill(null);
  for (let i = slow; i < values.length; i++) {
    full[i] = line[i];
    const s = sig[i - slow];
    hist[i] = s == null ? null : line[i] - s;
  }
  return { line: full, signal: full.map((_, i) => (i < slow ? null : sig[i - slow] ?? null)), histogram: hist };
}

export function adx(candles, period = 14) {
  const n = candles.length, out = new Array(n).fill(null), plus = new Array(n).fill(null), minus = new Array(n).fill(null);
  if (n <= period * 2) return { adx: out, plusDI: plus, minusDI: minus };
  const tr = [], pDM = [], mDM = [];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    pDM.push(up > down && up > 0 ? up : 0);
    mDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  }
  let atr14 = tr.slice(0, period).reduce((s, v) => s + v, 0);
  let p14 = pDM.slice(0, period).reduce((s, v) => s + v, 0);
  let m14 = mDM.slice(0, period).reduce((s, v) => s + v, 0);
  const dx = new Array(n).fill(null);
  for (let i = period; i < tr.length; i++) {
    if (i > period) { atr14 = atr14 - atr14 / period + tr[i]; p14 = p14 - p14 / period + pDM[i]; m14 = m14 - m14 / period + mDM[i]; }
    const p = 100 * (p14 / Math.max(atr14, 1e-12));
    const m = 100 * (m14 / Math.max(atr14, 1e-12));
    plus[i + 1] = p; minus[i + 1] = m;
    dx[i + 1] = 100 * Math.abs(p - m) / Math.max(p + m, 1e-12);
  }
  const first = dx.slice(period + 1, period + 1 + period).filter(Number.isFinite);
  if (first.length < period) return { adx: out, plusDI: plus, minusDI: minus };
  let a = first.reduce((s, v) => s + v, 0) / first.length;
  out[period * 2] = a;
  for (let i = period * 2 + 1; i < n; i++) { if (Number.isFinite(dx[i])) a = (a * (period - 1) + dx[i]) / period; out[i] = a; }
  return { adx: out, plusDI: plus, minusDI: minus };
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = new Array(values.length).fill(null), upper = new Array(values.length).fill(null), lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const w = values.slice(i - period + 1, i + 1);
    const m = w.reduce((s, v) => s + v, 0) / period;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / period);
    mid[i] = m; upper[i] = m + mult * sd; lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

export function roc(values, period = 5) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    out[i] = ((values[i] / values[i - period]) - 1) * 100;
  }
  return out;
}

// Swing-based support/resistance and trend structure over the last
// `lookback` candles. Counts consecutive higher-highs/higher-lows
// (bullish structure) vs lower-highs/lower-lows (bearish structure).
export function structure(candles, lookback = 20) {
  const c = candles.slice(-lookback);
  if (c.length < 8) return { trend: "RANGE", support: null, resistance: null, higherHighs: 0, higherLows: 0, lowerHighs: 0, lowerLows: 0 };

  let hh = 0, hl = 0, lh = 0, ll = 0;
  for (let i = 2; i < c.length; i++) {
    if (c[i].high > c[i - 1].high && c[i - 1].high > c[i - 2].high) hh++;
    if (c[i].low > c[i - 1].low && c[i - 1].low > c[i - 2].low) hl++;
    if (c[i].high < c[i - 1].high && c[i - 1].high < c[i - 2].high) lh++;
    if (c[i].low < c[i - 1].low && c[i - 1].low < c[i - 2].low) ll++;
  }

  const support = Math.min(...c.map(x => x.low));
  const resistance = Math.max(...c.map(x => x.high));

  let trend = "RANGE";
  if (hh + hl > lh + ll + 1) trend = "BULLISH";
  else if (lh + ll > hh + hl + 1) trend = "BEARISH";

  return { trend, support, resistance, higherHighs: hh, higherLows: hl, lowerHighs: lh, lowerLows: ll };
}

// Body/wick shape of a single candle — used to weight strong-bodied
// momentum candles slightly higher than indecisive/doji-like ones.
export function candleStats(c) {
  const range = Math.max(c.high - c.low, Number.EPSILON);
  const body = Math.abs(c.close - c.open);
  return {
    range,
    body,
    bodyRatio: body / range,
    bullish: c.close > c.open,
    bearish: c.close < c.open,
    upperWick: c.high - Math.max(c.open, c.close),
    lowerWick: Math.min(c.open, c.close) - c.low
  };
}

export function resample(candles, minutes) {
  const size = minutes * 60;
  const groups = new Map();
  for (const c of candles) {
    const t = Math.floor(c.time / size) * size;
    if (!groups.has(t)) groups.set(t, { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    else {
      const g = groups.get(t);
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volume += c.volume || 0;
    }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

export function snapshot(candles) {
  if (candles.length < 40) return null;
  const close = candles.map(c => c.close);
  const e9 = ema(close, 9), e21 = ema(close, 21), e50 = ema(close, 50);
  const R = rsi(close, 14), A = atr(candles, 14), M = macd(close), D = adx(candles, 14), B = bollinger(close, 20, 2), RC = roc(close, 5);
  const S = structure(candles, 20);
  const i = close.length - 1;
  const momentum = (close[i] - close[Math.max(0, i - 5)]) / Math.max(Math.abs(close[Math.max(0, i - 5)]), 1e-12);
  const emaTrend = e9[i] > e21[i] && e21[i] > e50[i] ? "BULLISH" : e9[i] < e21[i] && e21[i] < e50[i] ? "BEARISH" : "RANGE";
  const trend = emaTrend === S.trend ? emaTrend : (emaTrend === "RANGE" ? S.trend : emaTrend);

  return {
    close: close[i], ema9: e9[i], ema21: e21[i], ema50: e50[i],
    rsi: R[i], atr: A[i], macd: M.line[i], macdSignal: M.signal[i], macdHistogram: M.histogram[i],
    adx: D.adx[i], plusDI: D.plusDI[i], minusDI: D.minusDI[i],
    bbMid: B.mid[i], bbUpper: B.upper[i], bbLower: B.lower[i],
    roc: RC[i], support: S.support, resistance: S.resistance,
    candle: candleStats(candles[i]),
    momentum, trend, structureTrend: S.trend
  };
}
