export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return sma(trs, period);
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const kf = 2 / (fast + 1), ks = 2 / (slow + 1), kg = 2 / (signal + 1);
  let ef = closes.slice(0, fast).reduce((a,b)=>a+b,0)/fast;
  let es = closes.slice(0, slow).reduce((a,b)=>a+b,0)/slow;
  const macdLine = [];
  for (let i = fast; i < slow; i++) ef = closes[i]*kf + ef*(1-kf);
  for (let i = slow; i < closes.length; i++) {
    ef = closes[i]*kf + ef*(1-kf);
    es = closes[i]*ks + es*(1-ks);
    macdLine.push(ef - es);
  }
  if (macdLine.length < signal) return null;
  let sig = macdLine.slice(0, signal).reduce((a,b)=>a+b,0)/signal;
  for (let i = signal; i < macdLine.length; i++) sig = macdLine[i]*kg + sig*(1-kg);
  return { line: macdLine.at(-1), signal: sig, histogram: macdLine.at(-1) - sig };
}

export function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const mean = sma(closes, period);
  const slice = closes.slice(-period);
  const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { middle: mean, upper: mean + mult * sd, lower: mean - mult * sd, width: (2 * mult * sd) / mean };
}

export function roc(closes, period = 5) {
  if (closes.length <= period) return null;
  return ((closes.at(-1) / closes.at(-1-period)) - 1) * 100;
}

export function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const trs = [], plus = [], minus = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));
    const up = c.high-p.high, down = p.low-c.low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const dx = [];
  for (let i = period; i <= trs.length; i++) {
    const tr = trs.slice(i-period,i).reduce((a,b)=>a+b,0);
    if (!tr) continue;
    const p = plus.slice(i-period,i).reduce((a,b)=>a+b,0) / tr * 100;
    const m = minus.slice(i-period,i).reduce((a,b)=>a+b,0) / tr * 100;
    dx.push((Math.abs(p-m) / Math.max(p+m, 1e-9)) * 100);
  }
  return dx.length >= period ? sma(dx, period) : null;
}

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
