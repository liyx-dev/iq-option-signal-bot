import { fetchCandles, aggregateCandles, dataQuality } from "./market.js";
import { buildAnalysis, chooseExpiry } from "./strategy.js";
import { askTraderAI } from "./ai.js";
import { sendTelegram, signalMessage } from "./telegram.js";

const WAT="Africa/Lagos";
const MIN_SCORE=72;
const LEAD_DEFAULT=180;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEngine(env));
  },

  async fetch(request, env) {
    const url=new URL(request.url);
    try {
      if(url.pathname==="/trigger") return Response.json(await runEngine(env));
      if(url.pathname==="/history") return Response.json(await history(env));
      if(url.pathname==="/assets") return Response.json(await assets(env));
      if(url.pathname==="/stats") return Response.json(await stats(env));
      if(url.pathname==="/health") return Response.json(await health(env));
      if(url.pathname==="/outcomes") return Response.json(await settleOutcomes(env));
      return new Response("Blitz AI Signal Engine active. /trigger /history /assets /stats /health /outcomes",{status:200});
    } catch(e) {
      console.error(e);
      return Response.json({error:e.message,stack:e.stack},{status:500});
    }
  }
};

async function runEngine(env){
  const started=Date.now();
  const list=await getActiveAssets(env);
  let candidates=0, sent=0, errors=0;
  const results=[];

  for(const asset of list){
    try{
      const candles=await fetchCandles(asset,env,220);
      const quality=dataQuality(candles);
      if(quality<0.55){ results.push({asset:asset.symbol,status:"LOW_DATA_QUALITY",quality}); continue; }

      const c5=aggregateCandles(candles,5);
      const c15=aggregateCandles(candles,15);
      const analysis=buildAnalysis(candles,c5,c15,quality);
      if(analysis.score<MIN_SCORE || analysis.direction==="NO_TRADE"){
        results.push({asset:asset.symbol,status:"NO_TRADE",score:analysis.score,direction:analysis.direction});
        continue;
      }

      candidates++;
      let ai=null;
      try{ ai=await askTraderAI(env,asset,analysis); }
      catch(e){ console.warn(`AI failed ${asset.symbol}:`,e.message); }

      const finalDirection=ai?.decision || analysis.direction;
      if(finalDirection==="NO_TRADE"){
        results.push({asset:asset.symbol,status:"AI_REJECTED",score:analysis.score});
        continue;
      }

      const expiry=clampExpiry(Number(ai?.expiry_minutes || chooseExpiry(analysis,asset)),asset);
      const lead=Math.max(60,Number(asset.signal_lead_seconds||LEAD_DEFAULT));
      const now=Date.now();
      const entryMs=nextMinuteBoundary(now + lead*1000);
      const expiryMs=entryMs + expiry*60000;

      const validation=await recentDuplicate(env,asset.id,entryMs);
      if(validation){ results.push({asset:asset.symbol,status:"DUPLICATE"}); continue; }

      const reasoning=ai?.reasoning || analysis.reason;
      const confidence=Math.min(0.98,Math.max(0.50,Number(ai?.confidence ?? analysis.score/100)));
      const entryDisplay=formatWAT(entryMs);
      const expiryDisplay=formatWAT(expiryMs);

      const ins=await env.DB.prepare(`
        INSERT INTO signals
        (symbol,signal,confidence,price,time_frame,entry_time,reasoning,
         asset_id,signal_time_utc,entry_time_utc,expiry_time_utc,expiry_minutes,
         score,setup,market_regime,data_source,data_quality,validation_status,outcome)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        asset.symbol,finalDirection,confidence,analysis.lastPrice,`${expiry}M`,
        entryDisplay,reasoning,asset.id,new Date(now).toISOString(),
        new Date(entryMs).toISOString(),new Date(expiryMs).toISOString(),expiry,
        analysis.score,ai?.setup||analysis.setup,analysis.regime,
        asset.provider,quality,"PENDING","PENDING"
      ).run();

      const signalId=ins.meta?.last_row_id;
      const msg=signalMessage({
        asset,analysis,
        ai:{...ai,decision:finalDirection,confidence},
        entry:entryDisplay,
        expiry:expiryDisplay
      });
      const tg=await sendTelegram(env,msg);
      sent++;
      results.push({asset:asset.symbol,status:"SENT",signalId,direction:finalDirection,score:analysis.score,entry:entryDisplay,expiry:expiryDisplay,telegram:tg});

      await env.DB.prepare(
        "INSERT INTO signal_features(signal_id,features_json) VALUES(?,?)"
      ).bind(signalId,JSON.stringify({analysis,ai,generatedAt:new Date(now).toISOString()})).run();

    }catch(e){
      errors++;
      console.error(`Asset ${asset.symbol} failed:`,e);
      results.push({asset:asset.symbol,status:"ERROR",error:e.message});
    }
  }

  try{
    await settleOutcomes(env);
    await env.DB.prepare(`
      INSERT INTO engine_runs(run_time_utc,assets_scanned,candidates,signals_sent,errors,duration_ms)
      VALUES(?,?,?,?,?,?)
    `).bind(new Date().toISOString(),list.length,candidates,sent,errors,Date.now()-started).run();
  }catch(e){ console.error("run logging/settlement error",e); }

  return {status:"ok",assets:list.length,candidates,sent,errors,durationMs:Date.now()-started,results};
}

async function settleOutcomes(env){
  if(!env.DB) return {settled:0};
  const {results}=await env.DB.prepare(`
    SELECT s.id,s.symbol,s.signal,s.expiry_time_utc
    FROM signals s
    WHERE s.outcome='PENDING'
      AND s.expiry_time_utc IS NOT NULL
      AND s.expiry_time_utc <= ?
    ORDER BY s.expiry_time_utc ASC
    LIMIT 50
  `).bind(new Date().toISOString()).all();

  let settled=0;
  for(const s of results||[]){
    try{
      const asset=await env.DB.prepare("SELECT * FROM assets WHERE symbol=?").bind(s.symbol).first();
      if(!asset) continue;
      const candles=await fetchCandles(asset,env,20);
      const exit=nearestClosedClose(candles,Date.parse(s.expiry_time_utc));
      if(!exit) continue;
      const signal=String(s.signal).toUpperCase();
      const firstEntry=await env.DB.prepare("SELECT price FROM signals WHERE id=?").bind(s.id).first();
      const entry=Number(firstEntry?.price);
      let outcome="VOID";
      if(Number.isFinite(entry)){
        if(exit.close>entry) outcome=signal==="CALL"?"WIN":"LOSS";
        else if(exit.close<entry) outcome=signal==="PUT"?"WIN":"LOSS";
      }
      await env.DB.prepare(`
        UPDATE signals
        SET outcome=?, outcome_price=?, outcome_time_utc=?, validation_status='SETTLED'
        WHERE id=?
      `).bind(outcome,exit.close,new Date(exit.time).toISOString(),s.id).run();
      settled++;
    }catch(e){ console.warn("settlement failed",s.id,e.message); }
  }
  return {settled};
}

function nearestClosedClose(candles,target){
  let best=null,bestDiff=Infinity;
  for(const c of candles){
    const diff=Math.abs(c.time-target);
    if(diff<bestDiff){best=c;bestDiff=diff;}
  }
  return bestDiff<=120000?best:null;
}

async function recentDuplicate(env,assetId,entryMs){
  const row=await env.DB.prepare(`
    SELECT id FROM signals
    WHERE asset_id=? AND entry_time_utc=? LIMIT 1
  `).bind(assetId,new Date(entryMs).toISOString()).first();
  return row||null;
}

async function getActiveAssets(env){
  const {results}=await env.DB.prepare(
    "SELECT * FROM assets WHERE active=1 ORDER BY id ASC"
  ).all();
  return results||[];
}

async function history(env){
  const {results}=await env.DB.prepare(`
    SELECT s.*,a.display_name
    FROM signals s LEFT JOIN assets a ON a.id=s.asset_id
    ORDER BY s.timestamp DESC LIMIT 50
  `).all();
  return results||[];
}

async function assets(env){
  const {results}=await env.DB.prepare("SELECT * FROM assets ORDER BY id").all();
  return results||[];
}

async function stats(env){
  const {results}=await env.DB.prepare(`
    SELECT
      a.symbol,a.display_name,
      COUNT(s.id) total,
      SUM(CASE WHEN s.outcome='WIN' THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN s.outcome='LOSS' THEN 1 ELSE 0 END) losses,
      ROUND(100.0*SUM(CASE WHEN s.outcome='WIN' THEN 1 ELSE 0 END) /
        NULLIF(SUM(CASE WHEN s.outcome IN ('WIN','LOSS') THEN 1 ELSE 0 END),0),2) win_rate
    FROM assets a LEFT JOIN signals s ON s.asset_id=a.id
    GROUP BY a.id ORDER BY win_rate DESC
  `).all();
  return results||[];
}

async function health(env){
  const db=!!env.DB, ai=!!env.AI, td=!!env.TWELVE_DATA_API_KEY;
  return {ok:db&&ai&&td,bindings:{DB:db,AI:ai,TWELVE_DATA_API_KEY:td,TELEGRAM:!!(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_CHAT_ID)},timeUtc:new Date().toISOString(),timeWAT:formatWAT(Date.now())};
}

function nextMinuteBoundary(ms){
  return Math.floor(ms/60000)*60000 + 60000;
}
function formatWAT(ms){
  return new Intl.DateTimeFormat("en-US",{timeZone:WAT,hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true}).format(new Date(ms));
}
function clampExpiry(n,a){
  if(!Number.isFinite(n)) n=a.min_expiry_minutes;
  return Math.max(a.min_expiry_minutes,Math.min(a.max_expiry_minutes,Math.round(n)));
}


