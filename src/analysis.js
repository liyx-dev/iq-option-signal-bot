import { snapshot, resample } from "./indicators.js";
import { clamp, round } from "./utils.js";

function biasFromSnapshot(s) {
  if(!s) return 0;
  let b=0;
  b += s.ema9>s.ema21 ? 1 : -1;
  b += s.ema21>s.ema50 ? 1 : -1;
  b += s.macdHistogram>0 ? 1 : -1;
  b += s.plusDI>s.minusDI ? 1 : -1;
  b += s.rsi>52 ? 1 : s.rsi<48 ? -1 : 0;
  b += s.momentum>0 ? 1 : s.momentum<0 ? -1 : 0;
  if(s.trend==="BULLISH") b+=2;
  if(s.trend==="BEARISH") b-=2;
  return b;
}

function regime(s) {
  if(!s) return "UNKNOWN";
  if(Number.isFinite(s.adx) && s.adx>=25) return s.trend;
  return "RANGE";
}

function expiryFrom(atrPct, agreement, min=1,max=5) {
  // Short expiry for high noise; slightly longer when structure is coherent.
  let e=1;
  if(agreement>=0.85 && atrPct<0.003) e=3;
  else if(agreement>=0.75 && atrPct<0.006) e=2;
  else if(agreement>=0.9 && atrPct<0.01) e=4;
  else if(agreement>=0.92 && atrPct<0.02) e=5;
  return Math.max(min,Math.min(max,e));
}

export function analyze(symbol, candles1m, dataQuality, external=null, cfg={}) {
  if(!candles1m || candles1m.length<60) return {eligible:false,reason:"Insufficient 1m candles"};
  const c5=resample(candles1m,5), c15=resample(candles1m,15);
  if(c5.length<30 || c15.length<20) return {eligible:false,reason:"Insufficient resampled higher-timeframe candles"};

  const s1=snapshot(candles1m), s5=snapshot(c5), s15=snapshot(c15);
  if(!s1||!s5||!s15) return {eligible:false,reason:"Indicator warmup incomplete"};

  const b1=biasFromSnapshot(s1), b5=biasFromSnapshot(s5), b15=biasFromSnapshot(s15);
  const votes=[Math.sign(b1),Math.sign(b5),Math.sign(b15)].filter(Boolean);
  const avg=(b1*0.5+b5*0.3+b15*0.2);
  let direction=avg>0?"CALL":avg<0?"PUT":null;
  if(!direction) return {eligible:false,reason:"No directional edge"};

  const agreement=votes.filter(v=>v===(direction==="CALL"?1:-1)).length/Math.max(votes.length,1);
  const atrPct=s1.atr/Math.max(s1.close,1e-12);
  let score=50;
  score += Math.min(18,Math.abs(avg)*2.7);
  score += agreement*16;
  if(s1.adx>=25) score+=6;
  if((direction==="CALL"&&s1.rsi>=52&&s1.rsi<=68)||(direction==="PUT"&&s1.rsi<=48&&s1.rsi>=32)) score+=5;
  if((direction==="CALL"&&s1.macdHistogram>0)||(direction==="PUT"&&s1.macdHistogram<0)) score+=5;
  if((direction==="CALL"&&s1.plusDI>s1.minusDI)||(direction==="PUT"&&s1.minusDI>s1.plusDI)) score+=4;

  // Penalize contradictions, overextension and weak data.
  if(agreement<0.67) score-=14;
  if((direction==="CALL"&&s1.rsi>74)||(direction==="PUT"&&s1.rsi<26)) score-=10;
  if(atrPct>0.015) score-=8;
  score*=clamp(dataQuality,0.55,1);

  let externalText="none";
  if(external?.direction){
    const same=external.direction===direction;
    score += same?4:-7;
    externalText=`${external.source}:${external.direction}${same?"✓":"✕"}`;
  }

  score=clamp(score,0,100);
  const minScore=cfg.minScore??76;
  const eligible=score>=minScore && dataQuality>=(cfg.minDataQuality??0.78) && agreement>=0.67;

  const confidence=clamp(0.5+(score-50)/100,0.5,0.95);
  const expiry=expiryFrom(atrPct,agreement,1,5);
  const setup=`1m ${direction==="CALL"?"call":"put"}; 5m ${s5.trend.toLowerCase()} / 15m ${s15.trend.toLowerCase()}`;

  const reason=[
    `1m ${s1.trend.toLowerCase()} with RSI ${round(s1.rsi,1)} and ADX ${round(s1.adx,1)}`,
    `5m ${s5.trend.toLowerCase()}, 15m ${s15.trend.toLowerCase()}`,
    `multi-timeframe agreement ${Math.round(agreement*100)}%`,
    `MACD histogram ${s1.macdHistogram>=0?"positive":"negative"}`
  ].join("; ");

  return {
    eligible, direction, score:round(score,1), confidence:round(confidence,3),
    expiryMinutes:expiry, setup, reason, externalConfirmation:externalText,
    dataQuality, snapshots:{s1,s5,s15}, agreement, regime:regime(s1)
  };
}
