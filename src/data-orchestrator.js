import {saveCandles,loadCandles,providerHealth,getScanCursor,setScanCursor} from "./db.js";
import {assessCandles} from "./data-quality.js";
import {reserveTwelveData} from "./quota-manager.js";

export async function refreshFX(env,cfg,assets,p){
 const fx=assets.filter(a=>a.kind==="FX");if(!fx.length)return [];
 const cursor=await getScanCursor(env.DB),limit=Math.min(cfg.fxRefreshPerRun,fx.length),out=[];
 for(let n=0;n<limit;n++){
  const asset=fx[(cursor+n)%fx.length],symbol=asset.provider_symbol||asset.symbol;let r=null;
  if(await reserveTwelveData(env.DB,cfg,1)){r=await p.td.candles(symbol,cfg.candleCount);await providerHealth(env.DB,"twelvedata",r.ok,r.latencyMs,r.ok?null:String(r.error||"ERROR").slice(0,80))}
  if(!r?.ok){r=await p.duk.historical(symbol,cfg.candleCount);await providerHealth(env.DB,"dukascopy",r.ok,r.latencyMs,r.ok?null:String(r.error||"ERROR").slice(0,80))}
  if(!r?.ok&&p.oanda.token&&p.oanda.account){r=await p.oanda.candles(symbol,cfg.candleCount);await providerHealth(env.DB,"oanda",r.ok,r.latencyMs,r.ok?null:String(r.error||"ERROR").slice(0,80))}
  if(r?.ok){await saveCandles(env.DB,asset.symbol,r.candles,r.source,r.quality);out.push({asset:asset.symbol,source:r.source,ok:true})}
  else out.push({asset:asset.symbol,source:"cache",ok:false})
 }
 await setScanCursor(env.DB,(cursor+limit)%fx.length);return out;
}
export async function refreshCrypto(env,cfg,assets,p){
 const out=[];
 for(const asset of assets.filter(a=>a.kind==="CRYPTO")){
  const r=await p.binance.candles(asset.provider_symbol||"BTCUSDT",cfg.candleCount);
  await providerHealth(env.DB,"binance",r.ok,r.latencyMs,r.ok?null:String(r.error||"ERROR").slice(0,80));
  if(r.ok){await saveCandles(env.DB,asset.symbol,r.candles,r.source,r.quality);out.push({asset:asset.symbol,source:r.source,ok:true});continue}
  const cg=await p.cg.price();await providerHealth(env.DB,"coingecko",cg.ok,cg.latencyMs,cg.ok?null:String(cg.error||"ERROR").slice(0,80));
  out.push({asset:asset.symbol,source:"cache",ok:false,referencePrice:cg.ok?cg.price:null});
 }
 return out;
}
export async function getMarketState(db,asset,cfg){
 const candles=await loadCandles(db,asset.symbol,cfg.candleCount),quality=assessCandles(candles,Math.floor(Date.now()/1000),cfg.cacheMaxAgeSeconds);
 return {candles,quality};
}

