import { snapshot, resample } from "./indicators.js";
import { clamp, round } from "./utils.js";

/*
 * ============================================================
 * LIYOG BLITZ AI — QUANT ANALYSIS ENGINE
 *
 * Multi-timeframe confirmation, trend/momentum/volatility analysis,
 * support/resistance proximity awareness. Deliberately selective —
 * "no signal" beats a low-quality signal.
 *
 * Timeframes: 1M (execution) / 5M (confirmation) / 15M (structure)
 * ============================================================
 */

function directionFromBias(bias) {
  if (bias > 0) return "CALL";
  if (bias < 0) return "PUT";
  return null;
}

function biasFromSnapshot(s) {
  if (!s) return 0;
  let b = 0;

  if (s.ema9 > s.ema21) b += 1.5; else if (s.ema9 < s.ema21) b -= 1.5;
  if (s.ema21 > s.ema50) b += 1.5; else if (s.ema21 < s.ema50) b -= 1.5;
  if (s.macdHistogram > 0) b += 1.5; else if (s.macdHistogram < 0) b -= 1.5;
  if (s.plusDI > s.minusDI) b += 1.5; else if (s.minusDI > s.plusDI) b -= 1.5;
  if (s.rsi >= 55) b += 1; else if (s.rsi <= 45) b -= 1;
  if (s.momentum > 0) b += 1; else if (s.momentum < 0) b -= 1;
  if (s.trend === "BULLISH") b += 2;
  if (s.trend === "BEARISH") b -= 2;

  // Candle body strength: a strong-bodied candle in the bias
  // direction adds modest confirmation; a strong opposite-bodied
  // candle is a mild contradiction. Ported from a proven simpler
  // implementation — cheap signal, low weight by design.
  if (s.candle) {
    if (s.candle.bullish && s.candle.bodyRatio > 0.6) b += 0.5;
    if (s.candle.bearish && s.candle.bodyRatio > 0.6) b -= 0.5;
  }

  return b;
}

function regime(s) {
  if (!s) return "UNKNOWN";
  if (Number.isFinite(s.adx) && s.adx >= 25) {
    if (s.trend === "BULLISH") return "TREND_UP";
    if (s.trend === "BEARISH") return "TREND_DOWN";
  }
  return "RANGE";
}

function expiryFrom(atrPct, agreement, regimeName, min = 1, max = 5) {
  let expiry = 1;
  if (regimeName !== "RANGE" && agreement >= 0.90 && atrPct < 0.004) expiry = 3;
  else if (agreement >= 0.80 && atrPct < 0.006) expiry = 2;
  else if (regimeName !== "RANGE" && agreement >= 0.90 && atrPct < 0.012) expiry = 3;
  return Math.max(min, Math.min(max, expiry));
}

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function analyze(symbol, candles1m, dataQuality, external = null, cfg = {}) {

  if (!Array.isArray(candles1m) || candles1m.length < 300) {
    return { eligible: false, reason: "Insufficient 1m candles" };
  }

  if (!Number.isFinite(dataQuality) || dataQuality < (cfg.minDataQuality ?? 0.78)) {
    return { eligible: false, reason: "Data quality below minimum threshold" };
  }

  const c5 = resample(candles1m, 5);
  const c15 = resample(candles1m, 15);

  if (c5.length < 30 || c15.length < 20) {
    return { eligible: false, reason: "Insufficient higher-timeframe candles" };
  }

  const s1 = snapshot(candles1m);
  const s5 = snapshot(c5);
  const s15 = snapshot(c15);

  if (!s1 || !s5 || !s15) {
    return { eligible: false, reason: "Indicator warmup incomplete" };
  }

  const requiredValues = [s1.rsi, s1.atr, s1.macdHistogram, s1.adx, s1.plusDI, s1.minusDI, s5.rsi, s5.adx, s15.rsi, s15.adx];
  if (requiredValues.some(value => !Number.isFinite(Number(value)))) {
    return { eligible: false, reason: "Invalid indicator values" };
  }

  const b1 = biasFromSnapshot(s1);
  const b5 = biasFromSnapshot(s5);
  const b15 = biasFromSnapshot(s15);

  // Execution timeframe weighted highest: 1M=50%, 5M=30%, 15M=20%.
  const weightedBias = b1 * 0.50 + b5 * 0.30 + b15 * 0.20;
  const direction = directionFromBias(weightedBias);

  if (!direction) {
    return { eligible: false, reason: "No directional edge" };
  }

  const bullishVotes = [b1 > 0, b5 > 0, b15 > 0].filter(Boolean).length;
  const bearishVotes = [b1 < 0, b5 < 0, b15 < 0].filter(Boolean).length;
  const matchingVotes = direction === "CALL" ? bullishVotes : bearishVotes;
  const agreement = matchingVotes / 3;

  if (agreement < 0.67) {
    return { eligible: false, reason: "Insufficient multi-timeframe agreement" };
  }

  const marketRegime = regime(s1);

  const atr = finite(s1.atr);
  const close = Math.max(Math.abs(finite(s1.close, 1)), 1e-12);
  const atrPct = atr / close;

  if (atrPct > 0.025) {
    return { eligible: false, reason: "Volatility too high for short expiry" };
  }

  let score = 50;

  score += Math.min(18, Math.abs(weightedBias) * 2.5);
  score += agreement * 18;

  if (s1.adx >= 30) score += 8;
  else if (s1.adx >= 25) score += 5;
  else if (s1.adx < 18) score -= 6;

  const rsi = finite(s1.rsi);
  if (direction === "CALL") {
    if (rsi >= 55 && rsi <= 68) score += 6;
    else if (rsi >= 50 && rsi < 55) score += 2;
    if (rsi > 74) score -= 12;
  }
  if (direction === "PUT") {
    if (rsi <= 45 && rsi >= 32) score += 6;
    else if (rsi > 45 && rsi <= 50) score += 2;
    if (rsi < 26) score -= 12;
  }

  const macdHistogram = finite(s1.macdHistogram);
  if (direction === "CALL" && macdHistogram > 0) score += 6;
  if (direction === "PUT" && macdHistogram < 0) score += 6;
  if (direction === "CALL" && macdHistogram < 0) score -= 6;
  if (direction === "PUT" && macdHistogram > 0) score -= 6;

  const plusDI = finite(s1.plusDI);
  const minusDI = finite(s1.minusDI);
  if (direction === "CALL" && plusDI > minusDI) score += 5;
  if (direction === "PUT" && minusDI > plusDI) score += 5;
  if (direction === "CALL" && plusDI < minusDI) score -= 5;
  if (direction === "PUT" && minusDI < plusDI) score -= 5;

  if (direction === "CALL") {
    if (s5.trend === "BULLISH") score += 5;
    if (s15.trend === "BULLISH") score += 5;
    if (s5.trend === "BEARISH") score -= 8;
    if (s15.trend === "BEARISH") score -= 10;
  }
  if (direction === "PUT") {
    if (s5.trend === "BEARISH") score += 5;
    if (s15.trend === "BEARISH") score += 5;
    if (s5.trend === "BULLISH") score -= 8;
    if (s15.trend === "BULLISH") score -= 10;
  }

  const momentum = finite(s1.momentum);
  if (direction === "CALL" && momentum > 0) score += 4;
  if (direction === "PUT" && momentum < 0) score += 4;
  if (direction === "CALL" && momentum < 0) score -= 4;
  if (direction === "PUT" && momentum > 0) score -= 4;

  const bbMid = finite(s1.bbMid, null);
  const bbUpper = finite(s1.bbUpper, null);
  const bbLower = finite(s1.bbLower, null);

  if (bbMid !== null && bbUpper !== null && bbLower !== null && bbUpper > bbLower) {
    const bbRange = bbUpper - bbLower;
    const bbPosition = (s1.close - bbLower) / Math.max(bbRange, 1e-12);

    if (direction === "CALL" && bbPosition > 0.92) score -= 7;
    if (direction === "PUT" && bbPosition < 0.08) score -= 7;
    if (direction === "CALL" && bbPosition >= 0.50 && bbPosition <= 0.85) score += 3;
    if (direction === "PUT" && bbPosition >= 0.15 && bbPosition <= 0.50) score += 3;
  }

  // FIX: support/resistance proximity penalty, ported from a proven
  // simpler implementation. Avoid chasing CALL right into a nearby
  // resistance ceiling, or PUT right into a nearby support floor —
  // both are classic short-expiry traps where price often stalls or
  // reverses right at the level instead of continuing through it.
  if (Number.isFinite(s1.resistance) && Number.isFinite(s1.support) && atr > 0) {
    const distToResistance = (s1.resistance - s1.close) / atr;
    const distToSupport = (s1.close - s1.support) / atr;
    if (direction === "CALL" && distToResistance < 0.35) score -= 8;
    if (direction === "PUT" && distToSupport < 0.35) score -= 8;
  }

  if (atrPct > 0.015) score -= 8;
  else if (atrPct > 0.010) score -= 4;

  let externalText = "none";
  if (external?.direction) {
    const same = external.direction === direction;
    if (same) score += 5; else score -= 9;
    externalText = `${external.source}:${external.direction}${same ? "✓" : "✕"}`;
  }

  const quality = clamp(finite(dataQuality, 0), 0, 1);
  if (quality < 0.90) score *= 0.94 + quality * 0.06;
  if (quality < 0.82) score -= 5;

  score = clamp(score, 0, 100);
  score = round(score, 1);

  const minScore = cfg.minScore ?? 76;
  const requiredAgreement = marketRegime === "RANGE" ? 1.0 : 0.67;

  const eligible = score >= minScore && quality >= (cfg.minDataQuality ?? 0.78) && agreement >= requiredAgreement;

  if (!eligible) {
    return {
      eligible: false,
      direction,
      score,
      confidence: round(clamp(0.50 + (score - 50) / 100, 0.50, 0.95), 3),
      reason: score < minScore
        ? `Score below threshold (${score}/${minScore})`
        : marketRegime === "RANGE"
          ? "Ranging market requires full timeframe agreement"
          : "Setup quality below required threshold"
    };
  }

  let confidence = 0.50 + (score - 50) / 100;
  if (agreement === 1) confidence += 0.03;
  if (marketRegime === "TREND_UP" || marketRegime === "TREND_DOWN") confidence += 0.02;
  confidence = clamp(confidence, 0.50, 0.97);
  confidence = round(confidence, 3);

  const expiryMinutes = expiryFrom(atrPct, agreement, marketRegime, 1, 5);

  const setup = [
    `1m ${direction === "CALL" ? "CALL" : "PUT"}`,
    `5m ${String(s5.trend).toLowerCase()}`,
    `15m ${String(s15.trend).toLowerCase()}`,
    marketRegime.toLowerCase()
  ].join(" / ");

  const reason = [
    `1m ${String(s1.trend).toLowerCase()}`,
    `RSI ${round(s1.rsi, 1)}`,
    `ADX ${round(s1.adx, 1)}`,
    `5m ${String(s5.trend).toLowerCase()}`,
    `15m ${String(s15.trend).toLowerCase()}`,
    `MTF agreement ${Math.round(agreement * 100)}%`,
    `MACD ${s1.macdHistogram >= 0 ? "positive" : "negative"}`,
    `momentum ${momentum >= 0 ? "positive" : "negative"}`
  ].join("; ");

  return {
    eligible: true,
    symbol,
    direction,
    score,
    confidence,
    expiryMinutes,
    setup,
    reason,
    externalConfirmation: externalText,
    dataQuality: quality,
    snapshots: { s1, s5, s15 },
    agreement,
    regime: marketRegime
  };
}

