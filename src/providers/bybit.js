// Bybit public market data.
// No API key required for kline (candle) data — this is a public endpoint.
// Chosen to replace Binance, which returns HTTP 451 (geo-blocked) from
// Cloudflare Workers' edge network in most regions.
import { fetchJsonRetry } from "../utils.js";

export class BybitProvider {
  constructor(config) {
    this.config = config;
    this.name = "bybit";
    this.base = "https://api.bybit.com";
  }

  // symbol example: "BTCUSDT"
  async candles(symbol = "BTCUSDT", count = 200) {
    const u = new URL(`${this.base}/v5/market/kline`);
    u.searchParams.set("category", "spot");
    u.searchParams.set("symbol", symbol);
    u.searchParams.set("interval", "1"); // 1-minute candles
    u.searchParams.set("limit", String(Math.min(count, 1000)));

    const r = await fetchJsonRetry(
      u.toString(),
      { headers: { Accept: "application/json", "User-Agent": "LIYOG-Blitz-AI/1.0" } },
      this.config.requestTimeoutMs,
      this.config.providerRetries
    );

    if (!r.ok) {
      return { ok: false, error: `Bybit HTTP ${r.status || 0}`, status: r.status, latencyMs: r.latencyMs };
    }

    // Bybit wraps results in retCode/retMsg; 0 = success.
    if (r.body?.retCode !== 0) {
      return { ok: false, error: r.body?.retMsg || "Bybit API error", status: r.status, latencyMs: r.latencyMs };
    }

    // Bybit returns [start, open, high, low, close, volume, turnover], NEWEST first.
    const list = Array.isArray(r.body?.result?.list) ? r.body.result.list : [];
    const candles = list
      .map(x => ({
        time: Math.floor(Number(x[0]) / 1000),
        open: Number(x[1]),
        high: Number(x[2]),
        low: Number(x[3]),
        close: Number(x[4]),
        volume: Number(x[5] || 0)
      }))
      .filter(c => Object.values(c).every(Number.isFinite))
      .sort((a, b) => a.time - b.time); // oldest -> newest

    if (!candles.length) {
      return { ok: false, error: "Bybit returned no usable candles", latencyMs: r.latencyMs };
    }

    return { ok: true, candles, source: this.name, quality: 0.95, latencyMs: r.latencyMs };
  }
}

