import { ema, rsi, atr, macd, bollinger, roc, adx, candleStats } from "./indicators.js";

function clamp(n,a=0,b=100){ return Math.max(a,Math.min(b,n)); }

function structure(candles, lookback=20) {
  const c = candles.slice(-lookback);
  if (c.length < 8) return { trend:"UNKNOWN", support:null, resistance:null, higherHighs:0, higherLows:0 };
  let hh=0, hl=0, lh=0, ll=0;
  for (let i=2;i<c.length;i++) {
    if (c[i].high > c[i-1].high && c[i-1].high > c[i-2].high) hh++;
    if (c[i].low > c[i-1].low && c[i-1].low > c[i-2].low) hl++;
    if (c[i].high < c[i-1].high && c[i-1].high < c[i-2].high) lh++;
    if (c[i].low < c[i-1].low && c[i-1].low < c[i-2].low) ll++;
  }
  const support = Math.min(...c.map(x=>x.low));
  const resistance = Math.max(...c.map(x=>x.high));
  let trend="RANGE";
  if (hh+hl > lh+ll+1) trend="BULLISH";
  else if (lh+ll > hh+hl+1) trend="BEARISH";
  return { trend, support, resistance, higherHighs:hh, higherLows:hl, lowerHighs:lh, lowerLows:ll };
}

function analyzeTimeframe(candles) {
  const closes=candles.map(c=>c.close);
  const last=candles.at(-1);
  const e9=ema(closes,9), e21=ema(closes,21), e50=ema(closes,50);
  const r=rsi(closes,14), a=atr(candles,14), m=macd(closes), bb=bollinger(closes), ro=roc(closes,5), ad=adx(candles,14);
  const s=structure(candles);
  const cs=candleStats(last);
  let bull=0,bear=0;

  if(e9 && e21){ if(e9>e21) bull+=2; else bear+=2; }
  if(e21 && e50){ if(e21>e50) bull+=2; else bear+=2; }
  if(r!=null){ if(r>=52 && r<=72) bull+=2; if(r<=48 && r>=28) bear+=2; if(r>78) bull-=1; if(r<22) bear-=1; }
  if(m){ if(m.histogram>0) bull+=2; else bear+=2; }
  if(ro!=null){ if(ro>0) bull+=1; else bear+=1; }
  if(s.trend==="BULLISH") bull+=3;
  if(s.trend==="BEARISH") bear+=3;
  if(cs.bullish && cs.bodyRatio>0.6) bull+=1;
  if(cs.bearish && cs.bodyRatio>0.6) bear+=1;

  const total=Math.max(1,bull+bear);
  const bias = bull>bear ? "CALL" : bear>bull ? "PUT" : "NEUTRAL";
  return {
    bias, bull, bear, trend:s.trend, support:s.support, resistance:s.resistance,
    ema9:e9, ema21:e21, ema50:e50, rsi:r, atr:a, macd:m, bollinger:bb, roc:ro, adx:ad,
    candle:cs, directionalStrength:Math.abs(bull-bear)/total
  };
}

export function buildAnalysis(c1,c5,c15,quality) {
  const a1=analyzeTimeframe(c1), a5=analyzeTimeframe(c5), a15=analyzeTimeframe(c15);
  let call=0, put=0;
  for(const a of [a1,a5,a15]){
    if(a.bias==="CALL") call += a===a1?38:a===a5?25:17;
    if(a.bias==="PUT") put += a===a1?38:a===a5?25:17;
  }

  const last=c1.at(-1);
  const nearResistance = a1.resistance && (a1.resistance-last.close)/Math.max(a1.atr||last.close*0.001,1) < 0.35;
  const nearSupport = a1.support && (last.close-a1.support)/Math.max(a1.atr||last.close*0.001,1) < 0.35;
  if(nearResistance) call -= 8;
  if(nearSupport) put -= 8;

  const direction = call>put ? "CALL" : put>call ? "PUT" : "NO_TRADE";
  const raw=Math.max(call,put);
  const conflict=Math.abs(call-put);
  const score=clamp(35 + raw*0.5 + conflict*0.35 + quality*10);
  const regime =
    a5.trend===a15.trend && a5.trend!=="RANGE" ? `TRENDING_${a5.trend}` :
    a1.adx!=null && a1.adx<18 ? "LOW_TREND_RANGE" : "MIXED";

  let setup="NONE";
  if(direction==="CALL" && a1.trend==="BULLISH" && a5.bias==="CALL") setup="BULLISH_MOMENTUM";
  if(direction==="PUT" && a1.trend==="BEARISH" && a5.bias==="PUT") setup="BEARISH_MOMENTUM";
  if(direction!=="NO_TRADE" && a1.bollinger){
    if(direction==="CALL" && last.close>a1.bollinger.upper) setup="BULLISH_EXPANSION";
    if(direction==="PUT" && last.close<a1.bollinger.lower) setup="BEARISH_EXPANSION";
  }

  const reasons=[];
  reasons.push(`1m ${a1.bias.toLowerCase()} with ${a1.trend.toLowerCase()} structure`);
  reasons.push(`5m ${a5.bias.toLowerCase()} / 15m ${a15.bias.toLowerCase()}`);
  if(a1.rsi!=null) reasons.push(`RSI ${a1.rsi.toFixed(1)}`);
  if(a1.adx!=null) reasons.push(`ADX ${a1.adx.toFixed(1)}`);
  if(quality<0.8) reasons.push("data continuity below ideal");

  return {
    direction: score>=72 && direction!=="NO_TRADE" ? direction : "NO_TRADE",
    score: Math.round(score*10)/10,
    regime, setup, reason: reasons.join("; "),
    timeframes:{m1:a1,m5:a5,m15:a15},
    lastPrice:last.close,
    dataQuality:quality,
    conflict:Math.round(conflict*10)/10
  };
}

export function chooseExpiry(analysis, asset) {
  const allowed=[];
  for(let m=asset.min_expiry_minutes;m<=asset.max_expiry_minutes;m++) allowed.push(m);
  if(analysis.regime.startsWith("TRENDING") && analysis.score>=86) return Math.min(3,asset.max_expiry_minutes);
  if(analysis.regime==="LOW_TREND_RANGE") return Math.min(1,asset.max_expiry_minutes);
  return Math.min(2,asset.max_expiry_minutes);
}
