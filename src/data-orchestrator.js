// ============================================================
// DATA ORCHESTRATOR
//
// Decides WHICH assets get refreshed on each cron tick (the engine
// runs once per minute) and pulls fresh candles for them from the
// provider chain. Refresh order comes from refresh-priority.js —
// a tiered, need-weighted allocator that spends the scarce Twelve
// Data budget (8/min, 800/day) on the highest-value pairs first,
// while never permanently starving a lower-priority one.
//
// IMPORTANT: analysis (analyze() in analysis.js) runs independently
// per-asset in index.js's main loop — it does NOT wait for every
// asset to be READY. A pair that reaches READY status this minute
// is analyzed and can produce a signal this same minute, regardless
// of what state any other pair is in.
// ============================================================
import { saveCandles, loadCandles, providerHealth } from "./db.js";
import { assessCandles } from "./data-quality.js";
import { reserveTwelveData } from "./quota-manager.js";
import { rankByPriorityAndUrgency } from "./refresh-priority.js";

export async function refreshFX(env, cfg, assets, p) {
  const fx = assets.filter(a => a.kind === "FX");
  if (!fx.length) return [];

  const ranked = await rankByPriorityAndUrgency(env.DB, cfg, fx);
  const limit = Math.min(cfg.fxRefreshPerRun, ranked.length);
  const out = [];

  for (let n = 0; n < limit; n++) {
    const asset = ranked[n];
    const symbol = asset.provider_symbol || asset.symbol;
    let r = null;

    // Request the FULL candle window every time (not just a handful).
    // Twelve Data's free tier costs 1 credit per call regardless of
    // outputsize, so requesting more candles per call is free
    // backfill — this is what closes gaps.
    if (await reserveTwelveData(env.DB, cfg, 1)) {
      r = await p.td.candles(symbol, cfg.candleCount);
      await providerHealth(env.DB, "twelvedata", r.ok, r.latencyMs, r.ok ? null : String(r.error || "ERROR").slice(0, 80));
    }

    if (!r?.ok) {
      // Dukascopy's free endpoint is retired — kept as a harmless
      // instant-fail stub in case a future working endpoint appears.
      r = await p.duk.historical(symbol, cfg.candleCount);
      await providerHealth(env.DB, "dukascopy", r.ok, r.latencyMs, r.ok ? null : String(r.error || "ERROR").slice(0, 80));
    }

    if (r?.ok) {
      await saveCandles(env.DB, asset.symbol, r.candles, r.source, r.quality);
      out.push({ asset: asset.symbol, source: r.source, ok: true, candlesReceived: r.candles.length });
    } else {
      out.push({ asset: asset.symbol, source: "cache", ok: false });
    }
  }

  return out;
}

export async function refreshCrypto(env, cfg, assets, p) {
  const crypto = assets.filter(a => a.kind === "CRYPTO");
  if (!crypto.length) return [];

  const ranked = await rankByPriorityAndUrgency(env.DB, cfg, crypto);
  const limit = Math.min(cfg.cryptoRefreshPerRun, ranked.length);
  const out = [];

  for (let n = 0; n < limit; n++) {
    const asset = ranked[n];
    const symbol = asset.provider_symbol || asset.symbol; // e.g. "BTCUSDT"

    // FIX (Aug 2026): back-to-back Bybit calls within the same tick
    // were tripping its edge-IP abuse filter (HTTP 403) under burst
    // load. A small stagger between calls costs wall-clock time, not
    // CPU time or subrequests (both of which stay unaffected), and
    // wall-clock has real headroom (~14s used of a much larger
    // budget per the live logs) — so this is free insurance.
    if (n > 0) await new Promise(resolve => setTimeout(resolve, 300));

    // Primary: Bybit. Occasional transient 403s under burst load are
    // a short-lived edge-IP abuse filter, not a permanent block like
    // Binance's HTTP 451 — confirmed by /trigger calls at lower
    // burst succeeding right after a run of 403s.
    let r = await p.bybit.candles(symbol, cfg.candleCount);
    await providerHealth(env.DB, "bybit", r.ok, r.latencyMs, r.ok ? null : String(r.error || "ERROR").slice(0, 80));

    // Fallback: KuCoin (symbol format differs — hyphenated).
    // Capped refresh volume (cryptoRefreshPerRun) keeps this from
    // re-tripping KuCoin's rate limiter the way an uncapped
    // "refresh everything every run" loop did before.
    if (!r.ok) {
      r = await p.kucoin.candles(toKuCoinSymbol(symbol), cfg.candleCount);
      await providerHealth(env.DB, "kucoin", r.ok, r.latencyMs, r.ok ? null : String(r.error || "ERROR").slice(0, 80));
    }

    if (r.ok) {
      await saveCandles(env.DB, asset.symbol, r.candles, r.source, r.quality);
      out.push({ asset: asset.symbol, source: r.source, ok: true, candlesReceived: r.candles.length });
      continue;
    }

    // Last resort: CoinGecko spot price (no candles — reference
    // price only, cannot feed the indicator engine, but keeps
    // provider_state honest about what actually happened).
    const cg = await p.cg.price();
    await providerHealth(env.DB, "coingecko", cg.ok, cg.latencyMs, cg.ok ? null : String(cg.error || "ERROR").slice(0, 80));
    out.push({ asset: asset.symbol, source: "cache", ok: false, referencePrice: cg.ok ? cg.price : null });
  }

  return out;
}

// "BTCUSDT" -> "BTC-USDT". KuCoin uses a hyphenated symbol format.
function toKuCoinSymbol(binanceStyleSymbol) {
  const s = String(binanceStyleSymbol || "").toUpperCase();
  const quotes = ["USDT", "USDC", "BUSD", "USD"];
  for (const q of quotes) {
    if (s.endsWith(q) && s.length > q.length) {
      return `${s.slice(0, -q.length)}-${q}`;
    }
  }
  return s;
}

export async function getMarketState(db, asset, cfg) {
  const candles = await loadCandles(db, asset.symbol, cfg.candleCount);
  const quality = assessCandles(candles, Math.floor(Date.now() / 1000), cfg.cacheMaxAgeSeconds);
  return { candles, quality };
}
