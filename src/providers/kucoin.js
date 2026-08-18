// KuCoin public market data. Secondary crypto fallback behind Bybit.
// No API key required for candle data.
import { fetchJsonRetry } from "../utils.js";

export class KuCoinProvider {
  constructor(config) {
    this.config = config;
    this.name = "kucoin";
    this.base = "https://api.kucoin.com";
  }

  // symbol example: "BTC-USDT" (KuCoin uses a hyphen, not BTCUSDT)
  async candles(symbol = "BTC-USDT", count = 200) {
    const u = new URL(`${this.base}/api/v1/market/candles`);
    u.searchParams.set("symbol", symbol);
    u.searchParams.set("type", "1min");
    // KuCoin requires a time range rather than a simple "limit".
    const endAt = Math.floor(Date.now() / 1000);
    const startAt = endAt - count * 60;
    u.searchParams.set("startAt", String(startAt));
    u.searchParams.set("endAt", String(endAt));

    const r = await fetchJsonRetry(
      u.toString(),
      { headers: { Accept: "application/json", "User-Agent": "LIYOG-Blitz-AI/1.0" } },
      this.config.requestTimeoutMs,
      this.config.providerRetries
    );

    if (!r.ok) {
      return { ok: false, error: `KuCoin HTTP ${r.status || 0}`, status: r.status, latencyMs: r.latencyMs };
    }

    if (r.body?.code !== "200000") {
      return { ok: false, error: r.body?.msg || "KuCoin API error", status: r.status, latencyMs: r.latencyMs };
    }

    // KuCoin returns [time, open, close, high, low, volume, turnover], NEWEST first.
    // Note the field order differs from Bybit/Binance: close comes before high/low.
    const list = Array.isArray(r.body?.data) ? r.body.data : [];
    const candles = list
      .map(x => ({
        time: Math.floor(Number(x[0])),
        open: Number(x[1]),
        close: Number(x[2]),
        high: Number(x[3]),
        low: Number(x[4]),
        volume: Number(x[5] || 0)
      }))
      .filter(c => Object.values(c).every(Number.isFinite))
      .sort((a, b) => a.time - b.time);

    if (!candles.length) {
      return { ok: false, error: "KuCoin returned no usable candles", latencyMs: r.latencyMs };
    }

    return { ok: true, candles, source: this.name, quality: 0.90, latencyMs: r.latencyMs };
  }
}
