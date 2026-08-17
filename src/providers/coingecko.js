import { fetchJsonRetry } from "../utils.js";

export class CoinGeckoProvider {
  constructor(env, config) {
    this.key = env.COINGECKO_API_KEY || "";
    this.config = config;
    this.name = "coingecko";
  }

  async price() {
    const u = new URL(
      "https://api.coingecko.com/api/v3/simple/price"
    );

    u.searchParams.set("ids", "bitcoin");
    u.searchParams.set("vs_currencies", "usd");

    const headers = {
      Accept: "application/json",
      "User-Agent": "LIYOG-Blitz-AI/1.0"
    };

    // CoinGecko Demo API authentication.
    // Keep the key in a Worker Secret, never hard-code it.
    if (this.key) {
      headers["x-cg-demo-api-key"] = this.key;
    }

    const r = await fetchJsonRetry(
      u.toString(),
      { headers },
      this.config.requestTimeoutMs,
      this.config.providerRetries
    );

    const p = Number(r.body?.bitcoin?.usd);

    if (r.ok && Number.isFinite(p)) {
      return {
        ok: true,
        price: p,
        source: this.name,
        quality: 0.82,
        latencyMs: r.latencyMs
      };
    }

    const detail =
      r.body?.status?.error_message ||
      r.body?.error ||
      r.body?.message ||
      `CoinGecko HTTP ${r.status || 0}`;

    return {
      ok: false,
      error: String(detail).slice(0, 160),
      status: r.status,
      latencyMs: r.latencyMs
    };
  }
}

