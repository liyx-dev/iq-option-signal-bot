import { getConfig } from "./config.js";
import { json, fetchJson, formatWAT } from "./utils.js";
import { getAssets, saveCandles, loadCandles, providerHealth, reserveQuota, getScanCursor, setScanCursor } from "./db.js";
import { TwelveDataProvider } from "./providers/twelvedata.js";
import { BinanceProvider } from "./providers/binance.js";
import { CoinGeckoProvider } from "./providers/coingecko.js";
import { OandaProvider } from "./providers/oanda.js";
import { DukascopyProvider } from "./providers/dukascopy.js";
import { analyze } from "./analysis.js";
import { reviewCandidate } from "./ai.js";
import { entryAndExpiry } from "./time.js";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEngine(env));
  },

  async fetch(request, env, ctx) {
    const url=new URL(request.url);

    if(url.pathname==="/") return json({
      status:"ok",
      service:"LIYOG Blitz AI Signal Engine",
      mode:"signal-only",
      message:"Market-data fusion engine active."
    });

    if(url.pathname==="/health") return await health(env);

    if(url.pathname==="/history"){
      const limit=Math.min(Number(url.searchParams.get("limit")||20),100);
      try {
        const {results}=await env.DB.prepare(
          "SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?"
        ).bind(limit).all();
        return json(results||[]);
      } catch(e){ return json({error:e.message},500); }
    }

    if(url.pathname==="/assets"){
      try { return json(await getAssets(env.DB)); }
      catch(e){ return json({error:e.message},500); }
    }

    if(url.pathname==="/trigger"){
      if(!authorized(request,env)) return json({error:"Unauthorized"},401);
      try { return json(await runEngine(env)); }
      catch(e){ return json({status:"error",error:e.message,stack:e.stack},500); }
    }

    if(url.pathname==="/outcome" && request.method==="POST"){
      if(!authorized(request,env)) return json({error:"Unauthorized"},401);
      try{
        const body=await request.json();
        const result=String(body.result||"").toUpperCase();
        if(!["WIN","LOSS","VOID","SKIPPED"].includes(result)) return json({error:"Invalid result"},400);
        const signalId=Number(body.signal_id);
        if(!Number.isInteger(signalId)) return json({error:"signal_id required"},400);
        await env.DB.prepare(`
          INSERT INTO signal_outcomes(signal_id,result,observed_price,observed_at,notes)
          VALUES(?,?,?,?,?)
        `).bind(signalId,result,Number(body.observed_price)||null,Date.now(),String(body.notes||"")).run();
        await env.DB.prepare("UPDATE signals SET status=? WHERE id=?").bind(result,signalId).run();
        return json({status:"recorded",signal_id:signalId,result});
      }catch(e){return json({error:e.message},500);}
    }

    return new Response("LIYOG Blitz AI Signal Engine active.",{status:200});
  }
};

function authorized(request,env){
  if(!env.ADMIN_SECRET) return true; // Set ADMIN_SECRET in production.
  return request.headers.get("Authorization")===`Bearer ${env.ADMIN_SECRET}`;
}

async function runEngine(env){
  const cfg=getConfig(env);
  const assets=await getAssets(env.DB);
  if(!assets.length) return {status:"ok",assets:0,candidates:0,sent:0,errors:0};

  const started=Date.now();
  const results=[];
  const candidates=[];

  const td=new TwelveDataProvider(env,cfg);
  const binance=new BinanceProvider(cfg);
  const cg=new CoinGeckoProvider(env,cfg);
  const oanda=new OandaProvider(env,cfg);
  const duk=new DukascopyProvider(env,cfg);

  // 1) Pull a single public Dukascopy 1m snapshot for FX when available.
  // This is an external FX reference, NOT IQ Option OTC data.
  let dukeLatest=null;
  try{
    dukeLatest=await duk.latestOneMinuteCandles();
    await providerHealth(env.DB,"dukascopy",!!dukeLatest.ok,dukeLatest.latencyMs,dukeLatest.ok?null:"LATEST_FAILED");
    if(dukeLatest.ok){
      const byName=new Map(dukeLatest.candles.map(c=>[c.symbol.replace("/","").toUpperCase(),c]));
      for(const a of assets.filter(x=>x.kind==="FX")){
        const key=(a.provider_symbol||a.symbol).replace("/","").toUpperCase();
        const c=byName.get(key);
        if(c) await saveCandles(env.DB,a.symbol,[c],"dukascopy",dukeLatest.quality);
      }
    }
  }catch(e){ await providerHealth(env.DB,"dukascopy",false,null,e.message.slice(0,80)); }

  // 2) Refresh exactly ONE FX history set per minute, rotating through the registry.
  // With 800/day this stays below the free daily quota (~720/month-minute calls).
  const fx=assets.filter(a=>a.kind==="FX");
  const cursor=await getScanCursor(env.DB);
  let refreshedSymbol=null;

  if(fx.length && (new Date().getUTCMinutes()%2===0)){
    const asset=fx[cursor%fx.length];
    const symbol=asset.provider_symbol||asset.symbol;
    const reservedMinute=await reserveQuota(env.DB,"twelvedata","minute",minuteKey(),cfg.twelveMinuteQuota,1);
    const reservedDay=reservedMinute && await reserveQuota(env.DB,"twelvedata","day",dayKey(),cfg.twelveDailyQuota,1);

    if(reservedDay){
      const r=await td.candles(symbol,cfg.candleCount);
      await providerHealth(env.DB,"twelvedata",r.ok,r.latencyMs,r.ok?null:String(r.error||"ERROR").slice(0,80));
      if(r.ok){ await saveCandles(env.DB,asset.symbol,r.candles,r.source,r.quality); refreshedSymbol=asset.symbol; }
    }
    await setScanCursor(env.DB,(cursor+1)%Math.max(fx.length,1));
  }

  // 3) OANDA is an optional authenticated FX provider. If configured, use it
  // as a secondary refresh source for the same rotating asset.
  if(fx.length && oanda.token && oanda.account && refreshedSymbol){
    const asset=fx.find(a=>a.symbol===refreshedSymbol);
    const r=await oanda.candles(asset.provider_symbol,cfg.candleCount);
    await providerHealth(env.DB,"oanda",r.ok,r.latencyMs,r.ok?null:String(r.error||"ERROR").slice(0,80));
    if(r.ok) await saveCandles(env.DB,asset.symbol,r.candles,r.source,r.quality);
  }

  // 4) Crypto gets its own high-quality exchange feed; no Twelve Data credit.
  const crypto=assets.filter(a=>a.kind==="CRYPTO");
  for(const asset of crypto){
    try{
      const r=await binance.candles(asset.provider_symbol||"BTCUSDT",cfg.candleCount);
      await providerHealth(env.DB,"binance",r.ok,r.latencyMs,r.ok?null:String(r.error||"ERROR").slice(0,80));
      if(r.ok) await saveCandles(env.DB,asset.symbol,r.candles,r.source,r.quality);

      // CoinGecko is deliberately used only as a cross-check, not another candle hammer.
      if(asset.symbol==="BTCUSD_OTC"){
        const cgR=await cg.price();
        if(cgR.ok){
          const last=r.ok?r.candles[r.candles.length-1]?.close:null;
          const divergence=last?Math.abs(cgR.price-last)/last:1;
          if(divergence<0.01) await providerHealth(env.DB,"coingecko",true,cgR.latencyMs,null);
          else await providerHealth(env.DB,"coingecko",false,cgR.latencyMs,"PRICE_DIVERGENCE");
        } else await providerHealth(env.DB,"coingecko",false,null,cgR.error);
      }
    }catch(e){results.push({asset:asset.symbol,status:"ERROR",error:e.message});}
  }

  // 5) Analyze all assets from the local candle cache. No provider indicator calls.
  for(const asset of assets){
    try{
      const candles=await loadCandles(env.DB,asset.symbol,cfg.candleCount);
      const latest=candles[candles.length-1];
      if(!latest){results.push({asset:asset.symbol,status:"NO_DATA"});continue;}
      const age=Math.floor(Date.now()/1000)-latest.time;
      const quality=age<=cfg.maxCandleAgeSeconds?0.88:0.55;
      if(candles.length<60){results.push({asset:asset.symbol,status:"WARMING_UP",candles:candles.length});continue;}

      let external=null;
      if(asset.kind==="CRYPTO"){
        external={source:"binance",direction:latest.close>candles[Math.max(0,candles.length-4)].close?"CALL":"PUT"};
      } else {
        // External FX confirmation is intentionally conservative.
        const extMove=latest.close-candles[Math.max(0,candles.length-4)].close;
        external={source:latest.source||"cached",direction:extMove>=0?"CALL":"PUT"};
      }

      const a=analyze(asset.symbol,candles,quality,external,cfg);
      if(a.eligible) candidates.push({...a,asset});
      else results.push({asset:asset.symbol,status:"FILTERED",reason:a.reason||"No edge",score:a.score??null});
    }catch(e){results.push({asset:asset.symbol,status:"ERROR",error:e.message});}
  }

  // 6) Rank candidates, then let AI act as a conservative critic.
  candidates.sort((a,b)=>b.score-a.score);
  const selected=[];
  const usedKeys=new Set();
  for(const original of candidates){
    if(selected.length>=cfg.maxSignalsPerRun) break;
    const key=`${original.asset.symbol}-${original.direction}`;
    if(usedKeys.has(key)) continue;

    const ai=await reviewCandidate(env,original);
    const c={...original, ai};
    if(ai.ok){
      if(ai.decision!=="APPROVE" || ai.direction!==original.direction){
        results.push({asset:original.asset.symbol,status:"AI_REJECTED",reason:ai.reason,score:original.score});
        continue;
      }
      c.score=Math.round(Math.min(100,Math.max(0,original.score+ai.adjustment))*10)/10;
      c.confidence=Math.max(original.confidence,ai.confidence);
      c.reason=`${original.reason}. AI review: ${ai.reason}`;
      if(c.score<cfg.minScore) continue;
    }
    selected.push(c);
    usedKeys.add(key);
  }

  let sent=0;
  for(const c of selected){
    const {entryMs,expiryMs}=entryAndExpiry(cfg.entryLeadMinutes,c.expiryMinutes);
    const entryTime=formatWAT(entryMs), expiryTime=formatWAT(expiryMs);
    const message=buildTelegram(c,entryTime,expiryTime);
    let telegramStatus="Skipped (missing Telegram secrets)";
    if(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_CHAT_ID){
      try{ await sendTelegramMessage(env,message); telegramStatus="Sent Successfully"; sent++; }
      catch(e){ telegramStatus=`Failed: ${e.message}`; }
    }

    await env.DB.prepare(`
      INSERT INTO signals
      (symbol,signal,confidence,price,time_frame,entry_time,reasoning,score,expiry_minutes,data_source,data_quality,setup,external_confirmation,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      c.asset.symbol,c.direction,c.confidence,c.snapshots.s1.close,"1M",
      entryTime,c.reason,c.score,c.expiryMinutes,"fusion",c.dataQuality,c.setup,
      c.externalConfirmation,"PENDING"
    ).run();

    results.push({
      asset:c.asset.symbol,status:"SIGNAL",direction:c.direction,score:c.score,
      confidence:c.confidence,entryTime,expiryTime,telegramStatus
    });
  }

  return {
    status:"ok",durationMs:Date.now()-started,assets:assets.length,
    candidates:candidates.length,sent,errors:results.filter(x=>x.status==="ERROR").length,
    results
  };
}

function buildTelegram(c,entryTime,expiryTime){
  const call=c.direction==="CALL";
  return [
    "━━━━━━━━━━━━━━━━",
    "⚡ *BLITZ AI SIGNAL*",
    "━━━━━━━━━━━━━━━━",
    "",
    `🎫 *Asset:* ${c.asset.display_name}`,
    `➡️ *Direction:* ${call?"🟢 CALL (HIGHER) 📈":"🔴 PUT (LOWER) 📉"}`,
    `🕐 *Entry:* ${entryTime}`,
    `⏳ *Expiry:* ${expiryTime}`,
    `🎯 *Score:* ${c.score}/100`,
    `🧠 *AI/Quant Confidence:* ${Math.round(c.confidence*100)}%`,
    `🧩 *Setup:* ${c.setup}`,
    "",
    `💡 *Reason:* ${c.reason}`,
    "",
    `🔎 *Confirmation:* ${c.externalConfirmation}`,
    `🛡️ *Data quality:* ${Math.round(c.dataQuality*100)}%`,
    "",
    "⚠️ *Use the exact entry time shown. If the setup changes before entry, do not enter.*",
    "━━━━━━━━━━━━━━━━"
  ].join("\n");
}

async function sendTelegramMessage(env,text){
  const url=`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
    chat_id:env.TELEGRAM_CHAT_ID,text,parse_mode:"Markdown"
  })});
  if(!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
}

async function health(env){
  try{
    const {results}=await env.DB.prepare(`
      SELECT provider,status,last_success,last_error,last_error_code,latency_ms,consecutive_errors,updated_at
      FROM provider_state ORDER BY provider
    `).all();
    return json({status:"ok",providers:results||[],now:new Date().toISOString()});
  }catch(e){return json({status:"degraded",error:e.message},500);}
}

function minuteKey(){
  const d=new Date(); return d.toISOString().slice(0,16);
}
function dayKey(){
  const d=new Date(); return d.toISOString().slice(0,10);
}
