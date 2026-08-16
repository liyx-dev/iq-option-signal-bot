import {fetchJsonRetry} from "../utils.js";
export class CoinGeckoProvider{
 constructor(env,config){this.key=env.COINGECKO_API_KEY||"";this.config=config;this.name="coingecko";}
 async price(){
  const u=new URL("https://api.coingecko.com/api/v3/simple/price");u.searchParams.set("ids","bitcoin");u.searchParams.set("vs_currencies","usd");
  const headers={Accept:"application/json","User-Agent":"LIYOG-Blitz-AI/1.0"};
  if(this.key){u.searchParams.set("x_cg_demo_api_key",this.key);headers["x-cg-demo-api-key"]=this.key}
  const r=await fetchJsonRetry(u.toString(),{headers},this.config.requestTimeoutMs,this.config.providerRetries);
  const p=Number(r.body?.bitcoin?.usd);
  return r.ok&&Number.isFinite(p)?{ok:true,price:p,source:this.name,quality:.82,latencyMs:r.latencyMs}:{ok:false,error:`CoinGecko HTTP ${r.status||0}`,status:r.status,latencyMs:r.latencyMs};
 }
}
