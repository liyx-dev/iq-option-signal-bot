const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const schema = {
  type:"object",
  properties:{
    decision:{type:"string",enum:["CALL","PUT","NO_TRADE"]},
    expiry_minutes:{type:"integer",minimum:1,maximum:5},
    confidence:{type:"number",minimum:0,maximum:1},
    quality:{type:"string",enum:["A","B","C","NO_TRADE"]},
    setup:{type:"string"},
    reasoning:{type:"string"},
    invalidation:{type:"string"}
  },
  required:["decision","expiry_minutes","confidence","quality","setup","reasoning","invalidation"]
};

export async function askTraderAI(env, asset, analysis) {
  if(!env.AI) return null;
  const payload = {
    asset:asset.display_name,
    market_type:asset.market_type,
    proposed_expiry_range:[asset.min_expiry_minutes,asset.max_expiry_minutes],
    deterministic_analysis:{
      direction:analysis.direction,
      score:analysis.score,
      regime:analysis.regime,
      setup:analysis.setup,
      reason:analysis.reason,
      price:analysis.lastPrice,
      data_quality:analysis.dataQuality,
      timeframes:{
        "1m": compact(analysis.timeframes.m1),
        "5m": compact(analysis.timeframes.m5),
        "15m": compact(analysis.timeframes.m15)
      }
    }
  };

  const messages=[
    {role:"system",content:
      `You are the senior short-term market analyst in a binary/Blitz signal engine.
Use ONLY the supplied market data. Never invent candles, prices, indicators or certainty.
You may reject the setup. Prefer NO_TRADE over weak or conflicting evidence.
The external instrument is labeled OTC, so do not claim that proxy data is identical to the broker feed.
Choose an expiry only from the asset's allowed range.
Return strict JSON matching the supplied schema.`
    },
    {role:"user",content:JSON.stringify(payload)}
  ];

  const r=await env.AI.run(MODEL,{
    messages,
    response_format:{type:"json_schema",json_schema:schema}
  });

  const out=r?.response;
  if(!out) return null;
  const parsed=typeof out==="string" ? JSON.parse(out) : out;
  if(!["CALL","PUT","NO_TRADE"].includes(parsed.decision)) return null;
  if(parsed.decision!=="NO_TRADE" && ![1,2,3,4,5].includes(Number(parsed.expiry_minutes))) return null;
  return parsed;
}

function compact(x){
  return {
    bias:x.bias, trend:x.trend, ema9:x.ema9, ema21:x.ema21, ema50:x.ema50,
    rsi:x.rsi, atr:x.atr, macd:x.macd, bollinger:x.bollinger, roc:x.roc,
    adx:x.adx, support:x.support, resistance:x.resistance,
    directionalStrength:x.directionalStrength
  };
}

