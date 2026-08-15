const TD = "https://api.twelvedata.com/time_series";

export async function fetchCandles(asset, env, outputsize = 220) {
  if (!env.TWELVE_DATA_API_KEY) throw new Error("Missing TWELVE_DATA_API_KEY");

  const u = new URL(TD);
  u.searchParams.set("symbol", asset.provider_symbol);
  u.searchParams.set("interval", "1min");
  u.searchParams.set("outputsize", String(outputsize));
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

  const res = await fetch(u, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
  const data = await res.json();

  if (data.status === "error") throw new Error(data.message || "Twelve Data error");
  if (!Array.isArray(data.values)) throw new Error("Twelve Data returned no candles");

  const now = Date.now();
  const candles = data.values
    .map(x => ({
      time: Date.parse(String(x.datetime).replace(" ", "T") + "Z"),
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close),
      volume: Number(x.volume || 0)
    }))
    .filter(x => Number.isFinite(x.time) && x.time + 60000 <= now)
    .filter(x => [x.open,x.high,x.low,x.close].every(Number.isFinite))
    .sort((a,b)=>a.time-b.time);

  if (candles.length < 80) throw new Error(`Only ${candles.length} closed 1m candles`);
  return candles;
}

export function aggregateCandles(candles, minutes) {
  const buckets = new Map();
  for (const c of candles) {
    const start = Math.floor(c.time / (minutes*60000)) * (minutes*60000);
    let b = buckets.get(start);
    if (!b) {
      b = { time:start, open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volume };
      buckets.set(start,b);
    } else {
      b.high = Math.max(b.high,c.high);
      b.low = Math.min(b.low,c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a,b)=>a.time-b.time);
}

export function dataQuality(candles) {
  if (!candles.length) return 0;
  let gaps = 0;
  for (let i=1;i<candles.length;i++) {
    if (candles[i].time - candles[i-1].time > 60000) gaps++;
  }
  const continuity = Math.max(0, 1 - gaps / Math.max(candles.length-1,1));
  const freshness = Math.max(0, 1 - (Date.now() - candles.at(-1).time - 60000) / 180000);
  return Math.round(Math.max(0, Math.min(1, continuity*0.7 + freshness*0.3))*100)/100;
}

