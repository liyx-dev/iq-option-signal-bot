// CryptoCompare (min-api.cryptocompare.com) — primary crypto candle source.
// No API key required for histominute. Chosen as primary after both
// Binance (HTTP 451) and Bybit (HTTP 403) turned out to block requests
// from Cloudflare Workers' IP ranges. CryptoCompare is separate
// infrastructure from those exchanges and has not shown the same issue.
import { fetchJsonRetry } from "../utils.js";

export class CryptoCompareProvider {
  constructor(config) {
    this.config = config;
    this.name = "cryptocompare";
    this.base = "https://min-api.cryptocompare.com";
  }

  // fsym example: "BTC", tsym example: "USD"
  async candles(fsym = "BTC", tsym = "USD", count = 200) {
    const u = new URL(`${this.base}/data/v2/histominute`);
    u.searchParams.set("fsym", fsym);
    u.searchParams.set("tsym", tsym);
    // histominute returns `limit + 1` candles, cap at API max of 2000.
    u.searchParams.set("limit", String(Math.min(count, 1999)));

    const r = await fetchJsonRetry(
      u.toString(),
      { headers: { Accept: "application/json", "User-Agent": "LIYOG-Blitz-AI/1.0" } },
      this.config.requestTimeoutMs,
      this.config.providerRetries
    );

    if (!r.ok) {
      return { ok: false, error: `CryptoCompare HTTP ${r.status || 0}`, status: r.status, latencyMs: r.latencyMs };
    }

    if (r.body?.Response === "Error") {
      return { ok: false, error: r.body?.Message || "CryptoCompare API error", status: r.status, latencyMs: r.latencyMs };
    }

    const list = Array.isArray(r.body?.Data?.Data) ? r.body.Data.Data : [];
    const candles = list
      .map(x => ({
        time: Math.floor(Number(x.time)),
        open: Number(x.open),
        high: Number(x.high),
        low: Number(x.low),
        close: Number(x.close),
        volume: Number(x.volumeto || 0)
      }))
      // CryptoCompare pads the start of the window with zero-value
      // candles when it has no trade data that far back — drop those.
      .filter(c => Object.values(c).every(Number.isFinite) && c.close > 0)
      .sort((a, b) => a.time - b.time);

    if (!candles.length) {
      return { ok: false, error: "CryptoCompare returned no usable candles", latencyMs: r.latencyMs };
    }

    return { ok: true, candles, source: this.name, quality: 0.90, latencyMs: r.latencyMs };
  }
}

