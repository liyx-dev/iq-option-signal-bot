import {reserveQuota} from "./db.js";
export function minuteKey(){return new Date().toISOString().slice(0,16)}
export function dayKey(){return new Date().toISOString().slice(0,10)}
export async function reserveTwelveData(db,cfg,credits=1){
 const m=await reserveQuota(db,"twelvedata","minute",minuteKey(),cfg.twelveMinuteQuota,credits);
 if(!m)return false;
 return !!(await reserveQuota(db,"twelvedata","day",dayKey(),cfg.twelveDailyQuota,credits));
}

