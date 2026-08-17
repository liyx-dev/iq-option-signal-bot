// ============================================================
// DATA ORCHESTRATOR
//
// Responsible for deciding WHICH assets get refreshed on each
// cron tick (the engine runs once per minute) and pulling fresh
// candles for them from the provider chain.
//
// FIX (Aug 2026): the previous version used a simple round-robin
// cursor that refreshed a fixed number of FX assets per run with
// no regard for data quality. Because Twelve Data's free tier
// returns only its most recent ~N candles per call (it does not
// backfill missing history), pairs that went 10+ minutes between
// refreshes accumulated permanent gaps in market_candles and could
// never reach "READY" state. Most pairs were stuck WARMING_UP
// forever.
//
// FIX: refresh priority is now driven by actual data health
// (gap count + staleness), not a blind cursor. Assets with gaps
// or stale data are refreshed first, every run, until they heal.
// Healthy assets are refreshed far less often since 1-minute
// candles a few minutes old are still perfectly usable.
// ============================================================
import { saveCandles, loadCandles, providerHealth, getScanCursor, setScanCursor } from "./db.js";
import { assessCandles } from "./data-quality.js";
import { reserveTwelveData } from "./quota-manager.js";

// How stale (seconds) an asset's latest candle can be before it
// is treated as needing an urgent refresh, same as cacheMaxAgeSeconds.
async function pickFxRefreshTargets(db, cfg, fxAssets) {
  const scored = [];

  for (const asset of fxAssets) {
    const candles = await loadCandles(db, asset.symbol, cfg.candleCount);
    const dq = assessCandles(candles, Math.floor(Date.now() / 1000), cfg.cacheMaxAgeSeconds);

    // Higher urgency = refreshed sooner. Gaps matter most because a
    // gappy series can never become analyzable no matter how fresh
    // the newest candle is; staleness matters second.
    let urgency = 0;
    if (!candles.length) urgency = 1000; // never fetched at all
    else {
      urgency += (dq.gaps || 0) * 10;
      urgency += dq.ready ? 0 : 50; // not yet eligible for analysis
      urgency += Math.min(50, Math.floor((dq.ageSeconds || 0) / 30));
    }

    scored.push({ asset, urgency });
  }

  scored.sort((a, b) => b.urgency - a.urgency);
  return scored.map(s => s.asset);
}

export async function refreshFX(env, cfg, assets, p) {
  const fx = assets.filter(a => a.kind === "FX");
  if (!fx.length) return [];

  // Rank by actual need rather than a blind round-robin cursor.
  const ranked = await pickFxRefreshTargets(env.DB, cfg, fx);
  const limit = Math.min(cfg.fxRefreshPerRun, ranked.length);
  const out = [];

  for (let n = 0; n < limit; n++) {
    const asset = ranked[n];
    const symbol = asset.provider_symbol || asset.symbol;
    let r = null;

    // Ask for the FULL candle window every time (not just a handful).
    // Twelve Data's free tier cost is the same "1 request = 1 credit"
    // regardless of outputsize, so requesting more candles per call is
    // free backfill — this is what actually closes gaps.
    if (await reserveTwelveData(env.DB, cfg, 1)) {
      r = await p.td.candles(symbol, cfg.candleCount);
      await providerHealth(env.DB, "twelvedata", r.ok, r.latencyMs, r.ok ? null : String(r.error || "ERROR").slice(0, 80));
    }

    if (!r?.ok) {
      // Dukascopy free endpoint is retired as of 2026 — provider kept only
      // as a harmless no-op stub in case a future working endpoint appears.
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
  const out = [];

  for (const asset of assets.filter(a => a.kind === "CRYPTO")) {
    const symbol = asset.provider_symbol || asset.symbol;

    // Primary: Bybit. Not geo-blocked (unlike Binance, which returns
    // HTTP 451 from Cloudflare's edge network) and needs no API key.
    let r = await p.bybit.candles(symbol, cfg.candleCount);
    await providerHealth(env.DB, "bybit", r.ok, r.latencyMs, r.ok ? null : String(r.error || "ERROR").slice(0, 80));

    // Fallback: KuCoin, also key-free. Symbol format differs (hyphenated),
    // so we convert e.g. "BTCUSDT" -> "BTC-USDT" here.
    if (!r.ok) {
      const kucoinSymbol = toKuCoinSymbol(symbol);
      r = await p.kucoin.candles(kucoinSymbol, cfg.candleCount);
      await providerHealth(env.DB, "kucoin", r.ok, r.latencyMs, r.ok ? null : String(r.error || "ERROR").slice(0, 80));
    }

    if (r.ok) {
      await saveCandles(env.DB, asset.symbol, r.candles, r.source, r.quality);
      out.push({ asset: asset.symbol, source: r.source, ok: true, candlesReceived: r.candles.length });
      continue;
    }

    // Last resort: CoinGecko spot price (no candles, just a reference
    // price for logging/health — cannot feed the indicator engine).
    const cg = await p.cg.price();
    await providerHealth(env.DB, "coingecko", cg.ok, cg.latencyMs, cg.ok ? null : String(cg.error || "ERROR").slice(0, 80));
    out.push({ asset: asset.symbol, source: "cache", ok: false, referencePrice: cg.ok ? cg.price : null });
  }

  return out;
}

// "BTCUSDT" -> "BTC-USDT". Handles the common quote currencies used
// in the asset registry's provider_symbol column.
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

