import { fetchJson } from "../utils.js";

export class BinanceProvider {
  constructor(config){ this.config=config; this.name="binance"; }

  async candles(symbol="BTCUSDT", count=160) {
    const u=new URL("https://api.binance.com/api/v3/klines");
    u.searchParams.set("symbol",symbol);
    u.searchParams.set("interval","1m");
    u.searchParams.set("limit",String(Math.min(count,1000)));
    const r=await fetchJson(u.toString(),{},this.config.requestTimeoutMs);
    if(!r.ok || !Array.isArray(r.body)) return {ok:false,error:`Binance HTTP ${r.status||0}`,status:r.status,latencyMs:r.latencyMs};
    const candles=r.body.map(x=>({
      time:Math.floor(Number(x[0])/1000), open:Number(x[1]), high:Number(x[2]),
      low:Number(x[3]), close:Number(x[4]), volume:Number(x[5]||0)
    })).filter(c=>Object.values(c).every(Number.isFinite));
    return candles.length?{ok:true,candles,source:this.name,quality:0.97,latencyMs:r.latencyMs}:{ok:false,error:"Binance empty"};
  }
}

