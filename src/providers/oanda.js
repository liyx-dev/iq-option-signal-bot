import { fetchJson } from "../utils.js";

export class OandaProvider {
  constructor(env,config){
    this.token=env.OANDA_API_TOKEN||"";
    this.account=env.OANDA_ACCOUNT_ID||"";
    this.base=env.OANDA_BASE_URL||"https://api-fxpractice.oanda.com";
    this.config=config; this.name="oanda";
  }

  async candles(symbol,count=160){
    if(!this.token||!this.account) return {ok:false,error:"OANDA not configured"};
    const instrument=symbol.replace("/","_");
    const u=new URL(`${this.base}/v3/instruments/${instrument}/candles`);
    u.searchParams.set("granularity","M1"); u.searchParams.set("count",String(Math.min(count,5000)));
    const r=await fetchJson(u.toString(),{headers:{Authorization:`Bearer ${this.token}`,Accept:"application/json"}},this.config.requestTimeoutMs);
    if(!r.ok) return {ok:false,error:`OANDA HTTP ${r.status}`,status:r.status,latencyMs:r.latencyMs};
    const candles=(r.body?.candles||[]).map(v=>({
      time:Math.floor(new Date(v.time).getTime()/1000), open:Number(v.mid?.o), high:Number(v.mid?.h),
      low:Number(v.mid?.l), close:Number(v.mid?.c), volume:Number(v.volume||0)
    })).filter(c=>Object.values(c).every(Number.isFinite));
    return candles.length?{ok:true,candles,source:this.name,quality:0.95,latencyMs:r.latencyMs}:{ok:false,error:"OANDA empty"};
  }
}
