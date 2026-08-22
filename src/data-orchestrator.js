// ============================================================
// DATA ORCHESTRATOR (FX-only, Aug 2026 rebuild)
//
// Decides WHICH FX pairs get refreshed on each cron tick and pulls
// fresh candles from Twelve Data. Refresh order comes from
// refresh-priority.js — a tiered, need-weighted allocator that
// spends the scarce Twelve Data budget (8/min, 800/day) on the
// highest-value pairs first, while never permanently starving a
// lower-priority one.
//
// Crypto (Bybit/KuCoin) was removed entirely — the user trades FX
// far more and wants this Worker specialized on FX efficiency.
// Crypto can become its own separate, simpler Worker later.
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

export async function getMarketState(db, asset, cfg) {
  const candles = await loadCandles(db, asset.symbol, cfg.candleCount);
  const quality = assessCandles(candles, Math.floor(Date.now() / 1000), cfg.cacheMaxAgeSeconds);
  return { candles, quality };
}

