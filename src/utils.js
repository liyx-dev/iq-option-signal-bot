export function json(data,status=200,extra={}){return new Response(JSON.stringify(data,null,2),{status,headers:{"Content-Type":"application/json; charset=utf-8",...extra}})}
export function clamp(n,min,max){return Math.min(max,Math.max(min,n))}
export function median(v){const a=v.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
export async function fetchJson(url,options={},timeoutMs=8500){
 const c=new AbortController(),t=setTimeout(()=>c.abort(),timeoutMs),s=Date.now();
 try{const response=await fetch(url,{...options,signal:c.signal}),text=await response.text();let body;try{body=text?JSON.parse(text):{}}catch{body={raw:text}}
 return {ok:response.ok,status:response.status,body,latencyMs:Date.now()-s,headers:Object.fromEntries(response.headers.entries())}}
 finally{clearTimeout(t)}
}
export async function fetchJsonRetry(url,options={},timeoutMs=8500,retries=2){
 let last=null;
 for(let i=0;i<=retries;i++){try{last=await fetchJson(url,options,timeoutMs)}catch(e){last={ok:false,status:0,body:{},latencyMs:null,error:e.message}}
  if(last.ok)return last;if(![408,425,429,500,502,503,504].includes(last.status))return last;
  if(i<retries)await new Promise(r=>setTimeout(r,Math.min(1200,250*(i+1))));
 } return last;
}
export function iso(tsMs=Date.now()){return new Date(tsMs).toISOString()}
export function formatWAT(tsMs){return new Date(tsMs).toLocaleTimeString("en-US",{timeZone:"Africa/Lagos",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:true})}
export function round(n,digits=5){const p=10**digits;return Math.round(n*p)/p}

