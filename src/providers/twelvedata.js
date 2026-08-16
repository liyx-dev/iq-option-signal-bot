import { fetchJson } from "../utils.js";

export class TwelveDataProvider {
  constructor(env, config) {
    this.key = env.TWELVE_DATA_API_KEY || "";
    this.config = config;
    this.name = "twelvedata";
  }

  async candles(symbol, count=160) {
    if(!this.key) return {ok:false, error:"Missing TWELVE_DATA_API_KEY"};
    const url=new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval","1min");
    url.searchParams.set("outputsize",String(Math.min(count,5000)));
    url.searchParams.set("apikey",this.key);
    const r=await fetchJson(url.toString(),{},this.config.requestTimeoutMs);
    if(!r.ok) return {ok:false,error:`Twelve Data HTTP ${r.status}`,status:r.status,latencyMs:r.latencyMs};
    if(r.body?.status==="error") return {ok:false,error:r.body.message||"Twelve Data error",status:r.status,latencyMs:r.latencyMs};
    const values=Array.isArray(r.body?.values)?r.body.values:[];
    const candles=values.map(v=>({
      time:Math.floor(new Date(v.datetime+"Z").getTime()/1000),
      open:Number(v.open), high:Number(v.high), low:Number(v.low), close:Number(v.close), volume:Number(v.volume||0)
    })).filter(c=>Object.values(c).every(Number.isFinite)).sort((a,b)=>a.time-b.time);
    return candles.length ? {ok:true,candles,source:this.name,quality:0.92,latencyMs:r.latencyMs} :
      {ok:false,error:"Twelve Data returned no candles",latencyMs:r.latencyMs};
  }
}

