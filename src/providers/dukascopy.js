import { fetchJson } from "../utils.js";

export class DukascopyProvider {
  constructor(env,config){
    this.base=env.DUKASCOPY_BASE_URL||"https://freeserv.dukascopy.com/2.0/";
    this.config=config; this.name="dukascopy"; this.instrumentCache=null;
  }

  async instrumentList(){
    const u=new URL(this.base); u.searchParams.set("path","api/instrumentList");
    const r=await fetchJson(u.toString(),{},this.config.requestTimeoutMs);
    if(!r.ok || !Array.isArray(r.body)) return {ok:false,error:`Dukascopy instrument HTTP ${r.status||0}`};
    const map=new Map();
    for(const x of r.body){
      const name=String(x.name||x.nameLong||"").replace(/\s*\/\s*/g,"/").trim();
      const id=Number(x.id);
      if(name && Number.isFinite(id)) map.set(name,id);
    }
    this.instrumentCache=map;
    return {ok:true,map,latencyMs:r.latencyMs};
  }

  async historical(symbol,count=160){
    if(!this.instrumentCache){
      const list=await this.instrumentList();
      if(!list.ok) return list;
    }
    const id=this.instrumentCache.get(symbol);
    if(!Number.isFinite(id)) return {ok:false,error:`Dukascopy instrument not found: ${symbol}`};
    const u=new URL(this.base);
    u.searchParams.set("path","api/historicalPrices");
    u.searchParams.set("instrument",String(id));
    u.searchParams.set("timeFrame","1min");
    u.searchParams.set("count",String(Math.min(count,5000)));
    u.searchParams.set("offerSide","B");
    const r=await fetchJson(u.toString(),{},this.config.requestTimeoutMs);
    if(!r.ok || !Array.isArray(r.body)) return {ok:false,error:`Dukascopy historical HTTP ${r.status||0}`};
    const candles=r.body.map(x=>{
      const time=Number(x.time||x.timestamp||x.from||x.date||0);
      return {
        time:time>2e12?Math.floor(time/1000):time,
        open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0)
      };
    }).filter(c=>c.time&&[c.open,c.high,c.low,c.close].every(Number.isFinite)).sort((a,b)=>a.time-b.time);
    return candles.length?{ok:true,candles,source:this.name,quality:0.86,latencyMs:r.latencyMs}:{ok:false,error:"Dukascopy historical response shape not recognized"};
  }

  async latestOneMinuteCandles(){
    const u=new URL(this.base); u.searchParams.set("path","api/lastOneMinuteCandles");
    const r=await fetchJson(u.toString(),{},this.config.requestTimeoutMs);
    if(!r.ok || !Array.isArray(r.body)) return {ok:false,error:`Dukascopy latest HTTP ${r.status||0}`};
    const out=[];
    for(const x of r.body){
      const symbol=String(x.instrument||x.symbol||x.name||"").replace(/\s*\/\s*/g,"/").trim();
      const time=Number(x.time||x.timestamp||x.from||0);
      const open=Number(x.open),high=Number(x.high),low=Number(x.low),close=Number(x.close);
      if(symbol && time && [open,high,low,close].every(Number.isFinite)){
        out.push({symbol,time:time>2e12?Math.floor(time/1000):time,open,high,low,close,volume:Number(x.volume||0)});
      }
    }
    return out.length?{ok:true,candles:out,source:this.name,quality:0.86,latencyMs:r.latencyMs}:{ok:false,error:"Dukascopy latest response shape not recognized"};
  }
}
