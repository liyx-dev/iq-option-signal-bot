import { fetchJson } from "../utils.js";

export class CoinGeckoProvider {
  constructor(env,config){ this.key=env.COINGECKO_API_KEY||""; this.config=config; this.name="coingecko"; }

  async price() {
    const u=new URL("https://api.coingecko.com/api/v3/simple/price");
    u.searchParams.set("ids","bitcoin"); u.searchParams.set("vs_currencies","usd");
    if(this.key) u.searchParams.set("x_cg_demo_api_key",this.key);
    const r=await fetchJson(u.toString(),{headers:{"User-Agent":"LIYOG-Blitz-AI/1.0"}},this.config.requestTimeoutMs);
    const p=Number(r.body?.bitcoin?.usd);
    return r.ok&&Number.isFinite(p)?{ok:true,price:p,source:this.name,quality:0.82,latencyMs:r.latencyMs}:{ok:false,error:`CoinGecko HTTP ${r.status||0}`};
  }
}
