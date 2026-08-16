import {fetchJsonRetry} from "../utils.js";
export class BinanceProvider{
 constructor(config){this.config=config;this.name="binance";this.bases=[
 "https://api.binance.com","https://api-gcp.binance.com","https://api1.binance.com",
 "https://api2.binance.com","https://api3.binance.com","https://api4.binance.com"];}
 async candles(symbol="BTCUSDT",count=160){
  let last=null;
  for(const base of this.bases){
   const u=new URL(`${base}/api/v3/klines`);
   u.searchParams.set("symbol",symbol);u.searchParams.set("interval","1m");u.searchParams.set("limit",String(Math.min(count,1000)));
   const r=await fetchJsonRetry(u.toString(),{headers:{Accept:"application/json","User-Agent":"LIYOG-Blitz-AI/1.0"}},this.config.requestTimeoutMs,this.config.providerRetries);
   last=r;if(!r.ok)continue;
   const candles=(Array.isArray(r.body)?r.body:[]).map(x=>({time:Math.floor(Number(x[0])/1000),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]||0)})).filter(c=>Object.values(c).every(Number.isFinite));
   if(candles.length)return {ok:true,candles,source:this.name,quality:.97,latencyMs:r.latencyMs};
  }
  return {ok:false,error:`Binance HTTP ${last?.status||0}`,status:last?.status,latencyMs:last?.latencyMs};
 }
}
