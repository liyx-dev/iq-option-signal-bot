import { fetchJsonRetry } from "../utils.js";

export class DukascopyProvider {
  constructor(env, config) {
    this.base =
      env.DUKASCOPY_BASE_URL ||
      "https://freeserv.dukascopy.com/2.0/";

    this.config = config;
    this.name = "dukascopy";
    this.instrumentCache = null;
  }

  buildUrl(path, params = {}) {
    const u = new URL(this.base);

    u.searchParams.set("path", path);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        u.searchParams.set(key, String(value));
      }
    }

    return u.toString();
  }

  async request(path, params = {}) {
    const url = this.buildUrl(path, params);

    const headers = {
      Accept: "application/json",
      "User-Agent": "LIYOG-Blitz-AI/1.0"
    };

    const retries = Number.isFinite(
      Number(this.config.providerRetries)
    )
      ? Number(this.config.providerRetries)
      : 2;

    return await fetchJsonRetry(
      url,
      { headers },
      this.config.requestTimeoutMs,
      retries
    );
  }

  normalizeTime(value) {
    const n = Number(value || 0);

    if (!Number.isFinite(n) || n <= 0) {
      return 0;
    }

    // Milliseconds -> seconds.
    if (n > 2e12) {
      return Math.floor(n / 1000);
    }

    // Some APIs can return milliseconds in the 1e12 range.
    if (n > 2e10) {
      return Math.floor(n / 1000);
    }

    return Math.floor(n);
  }

  normalizeCandle(x) {
    if (!x || typeof x !== "object") {
      return null;
    }

    const time = this.normalizeTime(
      x.time ??
      x.timestamp ??
      x.from ??
      x.date ??
      x.startTime
    );

    const open = Number(x.open);
    const high = Number(x.high);
    const low = Number(x.low);
    const close = Number(x.close);
    const volume = Number(
      x.volume ??
      x.vol ??
      0
    );

    if (
      !time ||
      ![open, high, low, close].every(Number.isFinite)
    ) {
      return null;
    }

    return {
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0
    };
  }

  normalizeSymbol(x) {
    if (!x || typeof x !== "object") {
      return "";
    }

    return String(
      x.instrument ??
      x.symbol ??
      x.name ??
      x.nameLong ??
      ""
    )
      .replace(/\s*\/\s*/g, "/")
      .trim()
      .toUpperCase();
  }

  async instrumentList() {
    const r = await this.request("api/instrumentList");

    if (!r.ok || !Array.isArray(r.body)) {
      return {
        ok: false,
        error:
          r.body?.message ||
          r.body?.error ||
          `Dukascopy instrument HTTP ${r.status || 0}`,
        status: r.status,
        latencyMs: r.latencyMs
      };
    }

    const map = new Map();

    for (const x of r.body) {
      const id = Number(x.id);

      const name = String(
        x.name ||
        x.nameLong ||
        ""
      )
        .replace(/\s*\/\s*/g, "/")
        .trim()
        .toUpperCase();

      if (name && Number.isFinite(id)) {
        map.set(name, id);
      }
    }

    this.instrumentCache = map;

    return {
      ok: true,
      map,
      count: map.size,
      latencyMs: r.latencyMs
    };
  }

  async getInstrumentId(symbol) {
    const normalized = String(symbol || "")
      .replace(/\s*\/\s*/g, "/")
      .trim()
      .toUpperCase();

    if (!this.instrumentCache) {
      const list = await this.instrumentList();

      if (!list.ok) {
        return list;
      }
    }

    const id = this.instrumentCache.get(normalized);

    if (!Number.isFinite(id)) {
      return {
        ok: false,
        error: `Dukascopy instrument not found: ${normalized}`
      };
    }

    return {
      ok: true,
      id,
      symbol: normalized
    };
  }

  async historical(symbol, count = 160) {
    const instrument = await this.getInstrumentId(symbol);

    if (!instrument.ok) {
      return instrument;
    }

    const safeCount = Math.min(
      Math.max(Number(count) || 160, 1),
      5000
    );

    const r = await this.request(
      "api/historicalPrices",
      {
        instrument: instrument.id,
        timeFrame: "1min",
        count: safeCount,
        offerSide: "B"
      }
    );

    if (!r.ok || !Array.isArray(r.body)) {
      return {
        ok: false,
        error:
          r.body?.message ||
          r.body?.error ||
          `Dukascopy historical HTTP ${r.status || 0}`,
        status: r.status,
        latencyMs: r.latencyMs
      };
    }

    const candles = r.body
      .map(x => this.normalizeCandle(x))
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);

    if (!candles.length) {
      return {
        ok: false,
        error:
          "Dukascopy returned no usable historical candles",
        status: r.status,
        latencyMs: r.latencyMs
      };
    }

    return {
      ok: true,
      candles,
      source: this.name,
      quality: 0.86,
      latencyMs: r.latencyMs
    };
  }

  async latestOneMinuteCandles() {
    const r = await this.request(
      "api/lastOneMinuteCandles"
    );

    if (!r.ok || !Array.isArray(r.body)) {
      return {
        ok: false,
        error:
          r.body?.message ||
          r.body?.error ||
          `Dukascopy latest HTTP ${r.status || 0}`,
        status: r.status,
        latencyMs: r.latencyMs
      };
    }

    const candles = [];

    for (const x of r.body) {
      const symbol = this.normalizeSymbol(x);
      const candle = this.normalizeCandle(x);

      if (symbol && candle) {
        candles.push({
          symbol,
          ...candle
        });
      }
    }

    if (!candles.length) {
      return {
        ok: false,
        error:
          "Dukascopy latest endpoint returned no usable candles",
        status: r.status,
        latencyMs: r.latencyMs
      };
    }

    return {
      ok: true,
      candles,
      source: this.name,
      quality: 0.86,
      latencyMs: r.latencyMs
    };
  }

  async currentPrices(instrumentIds = []) {
    const ids = Array.isArray(instrumentIds)
      ? instrumentIds
          .map(Number)
          .filter(Number.isFinite)
          .join(",")
      : "";

    const r = await this.request(
      "api/currentPrices",
      ids ? { instruments: ids } : {}
    );

    if (!r.ok || !Array.isArray(r.body)) {
      return {
        ok: false,
        error:
          r.body?.message ||
          r.body?.error ||
          `Dukascopy prices HTTP ${r.status || 0}`,
        status: r.status,
        latencyMs: r.latencyMs
      };
    }

    return {
      ok: true,
      prices: r.body,
      source: this.name,
      latencyMs: r.latencyMs
    };
  }
}

