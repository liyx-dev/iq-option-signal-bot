export async function getAssets(db) {
  const {results}=await db.prepare("SELECT * FROM asset_registry WHERE enabled=1 ORDER BY priority DESC, symbol").all();
  return results||[];
}

export async function saveCandles(db,symbol,candles,source,quality) {
  if(!candles?.length) return;
  const rows=candles.slice(-180);
  for(const c of rows){
    await db.prepare(`
      INSERT INTO market_candles
      (symbol,timeframe_seconds,candle_time,open,high,low,close,volume,source,quality,received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(symbol,timeframe_seconds,candle_time) DO UPDATE SET
        open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
        volume=excluded.volume,source=excluded.source,quality=excluded.quality,received_at=excluded.received_at
    `).bind(symbol,60,c.time,c.open,c.high,c.low,c.close,c.volume||0,source,quality,Date.now()).run();
  }
}

export async function loadCandles(db,symbol,count=180) {
  const {results}=await db.prepare(`
    SELECT candle_time AS time, open, high, low, close, volume
    FROM market_candles
    WHERE symbol=? AND timeframe_seconds=60
    ORDER BY candle_time DESC LIMIT ?
  `).bind(symbol,count).all();
  return (results||[]).reverse().map(c=>({...c,time:Number(c.time),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume||0)}));
}

export async function providerHealth(db,provider,ok,latencyMs,errorCode=null) {
  const now=Date.now();
  await db.prepare(`
    INSERT INTO provider_state(provider,status,last_success,last_error,last_error_code,latency_ms,consecutive_errors,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(provider) DO UPDATE SET
      status=excluded.status,
      last_success=CASE WHEN excluded.status='UP' THEN excluded.last_success ELSE provider_state.last_success END,
      last_error=CASE WHEN excluded.status='UP' THEN provider_state.last_error ELSE excluded.last_error END,
      last_error_code=excluded.last_error_code,
      latency_ms=excluded.latency_ms,
      consecutive_errors=CASE WHEN excluded.status='UP' THEN 0 ELSE provider_state.consecutive_errors+1 END,
      updated_at=excluded.updated_at
  `).bind(provider,ok?"UP":"DOWN",ok?now:null,ok?null:now,errorCode,latencyMs||null,ok?0:1,now).run();
}

export async function quotaUsed(db,provider,windowType,windowKey) {
  const row=await db.prepare("SELECT used,quota FROM quota_usage WHERE provider=? AND window_type=? AND window_key=?")
    .bind(provider,windowType,windowKey).first();
  return row?{used:Number(row.used),quota:Number(row.quota)}:{used:0,quota:0};
}

export async function reserveQuota(db,provider,windowType,windowKey,quota,credits=1) {
  const now=Date.now();
  await db.prepare(`
    INSERT OR IGNORE INTO quota_usage(provider,window_type,window_key,used,quota,updated_at)
    VALUES(?,?,?,?,?,?)
  `).bind(provider,windowType,windowKey,0,quota,now).run();
  const before=await quotaUsed(db,provider,windowType,windowKey);
  if(before.used+credits>quota) return false;
  await db.prepare(`
    UPDATE quota_usage SET used=used+?,updated_at=?
    WHERE provider=? AND window_type=? AND window_key=? AND used+?<=?
  `).bind(credits,now,provider,windowType,windowKey,credits,quota).run();
  const after=await quotaUsed(db,provider,windowType,windowKey);
  return after.used>=before.used+credits;
}

export async function getScanCursor(db) {
  const row=await db.prepare("SELECT cursor FROM scan_state WHERE id=1").first();
  return Number(row?.cursor||0);
}
export async function setScanCursor(db,cursor) {
  await db.prepare("UPDATE scan_state SET cursor=?,last_scan=?,updated_at=? WHERE id=1")
    .bind(cursor,Date.now(),Date.now()).run();
}

