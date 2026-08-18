// exchangerate.host — free, no API key, no daily quota published.
// This does NOT provide 1-minute candles (no free forex API does, beyond
// Twelve Data). It provides a single current spot rate per pair, which we
// use only as an external directional confirmation check — the same role
// CoinGecko plays for BTC in coingecko.js. It is never used as a primary
// candle source.
import { fetchJsonRetry } from "../utils.js";

export class FxRefProvider {
  constructor(config) {
    this.config = config;
    this.name = "fxref";
    this.base = "https://api.exchangerate.host";
  }

  // pair example: "EUR/USD" -> base=EUR, quote=USD
  async price(pair) {
    const [base, quote] = String(pair || "").split("/");
    if (!base || !quote) return { ok: false, error: "Invalid pair format" };

    const u = new URL(`${this.base}/latest`);
    u.searchParams.set("base", base);
    u.searchParams.set("symbols", quote);

    const r = await fetchJsonRetry(
      u.toString(),
      { headers: { Accept: "application/json" } },
      this.config.requestTimeoutMs,
      this.config.providerRetries
    );

    const p = Number(r.body?.rates?.[quote]);

    if (r.ok && Number.isFinite(p)) {
      return { ok: true, price: p, source: this.name, quality: 0.6, latencyMs: r.latencyMs };
    }

    return {
      ok: false,
      error: r.body?.error?.info || `fxref HTTP ${r.status || 0}`,
      status: r.status,
      latencyMs: r.latencyMs
    };
  }
}

