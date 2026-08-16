export function assessCandles(candles,nowSec=Math.floor(Date.now()/1000),maxAge=180){
 const clean=(candles||[]).filter(c=>Number.isFinite(Number(c.time))&&[c.open,c.high,c.low,c.close].every(Number.isFinite)).sort((a,b)=>a.time-b.time);
 if(!clean.length)return {ready:false,candles:0,ageSeconds:null,gaps:null,continuity:0,freshness:0,quality:0,reason:"NO_CANDLES"};
 let gaps=0;
 for(let i=1;i<clean.length;i++){const d=clean[i].time-clean[i-1].time;if(d>75)gaps+=Math.max(1,Math.round(d/60)-1)}
 const age=Math.max(0,nowSec-clean.at(-1).time),freshness=Math.max(0,Math.min(1,1-age/Math.max(maxAge,1)));
 const continuity=Math.max(0,Math.min(1,1-gaps/Math.max(clean.length-1,1))),countQuality=Math.min(1,clean.length/160);
 const quality=.45*freshness+.35*continuity+.20*countQuality;
 return {ready:clean.length>=60&&age<=maxAge&&gaps===0,candles:clean.length,ageSeconds:age,gaps,continuity,freshness,quality,
 reason:clean.length<60?"WARMING_UP":age>maxAge?"STALE":gaps?"GAPS":"READY"};
}

