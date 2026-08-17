import { getConfig } from "./config.js";
import { json, formatWAT } from "./utils.js";

import {
  getAssets,
  loadCandles,
  providerHealth,
  cleanupStorage
} from "./db.js";

import { TwelveDataProvider } from "./providers/twelvedata.js";
import { BinanceProvider } from "./providers/binance.js";
import { CoinGeckoProvider } from "./providers/coingecko.js";
import { OandaProvider } from "./providers/oanda.js";
import { DukascopyProvider } from "./providers/dukascopy.js";

import {
  refreshFX,
  refreshCrypto,
  getMarketState
} from "./data-orchestrator.js";

import { analyze } from "./analysis.js";
import { reviewCandidate } from "./ai.js";
import { entryAndExpiry } from "./time.js";


export default {

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEngine(env));
  },


  async fetch(request, env, ctx) {

    const url = new URL(request.url);


    if (url.pathname === "/") {
      return json({
        status: "ok",
        service: "LIYOG Blitz AI Signal Engine",
        mode: "signal-only",
        message: "Market-data fusion engine active."
      });
    }


    if (url.pathname === "/health") {
      return await health(env);
    }


    /*
     * NEW:
     * Detailed candle/feed status.
     *
     * This endpoint tells us:
     * - how many candles each asset has
     * - whether the data is fresh
     * - whether gaps exist
     * - whether analysis is ready
     * - latest candle time
     */
    if (url.pathname === "/status") {
      return await status(env);
    }


    if (url.pathname === "/assets") {

      try {

        const assets = await getAssets(env.DB);

        return json(assets);

      } catch (e) {

        return json({
          error: e.message
        }, 500);

      }

    }


    if (url.pathname === "/history") {

      const limit = Math.min(
        Number(url.searchParams.get("limit") || 20),
        100
      );

      try {

        const { results } = await env.DB.prepare(
          "SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?"
        ).bind(limit).all();

        return json(results || []);

      } catch (e) {

        return json({
          error: e.message
        }, 500);

      }

    }


    if (url.pathname === "/trigger") {

      if (!authorized(request, env)) {

        return json({
          error: "Unauthorized",
          message: "Use Authorization: Bearer YOUR_ADMIN_SECRET"
        }, 401);

      }

      try {

        return json(await runEngine(env));

      } catch (e) {

        return json({
          status: "error",
          error: e.message,
          stack: e.stack
        }, 500);

      }

    }


    if (url.pathname === "/outcome" && request.method === "POST") {

      if (!authorized(request, env)) {
        return json({
          error: "Unauthorized"
        }, 401);
      }

      try {

        const body = await request.json();

        const result =
          String(body.result || "").toUpperCase();

        if (
          !["WIN", "LOSS", "VOID", "SKIPPED"]
            .includes(result)
        ) {

          return json({
            error: "Invalid result"
          }, 400);

        }

        const signalId =
          Number(body.signal_id);

        if (!Number.isInteger(signalId)) {

          return json({
            error: "signal_id required"
          }, 400);

        }

        await env.DB.prepare(`
          INSERT INTO signal_outcomes
          (signal_id,result,observed_price,observed_at,notes)
          VALUES(?,?,?,?,?)
        `)
          .bind(
            signalId,
            result,
            Number(body.observed_price) || null,
            Date.now(),
            String(body.notes || "")
          )
          .run();


        await env.DB.prepare(
          "UPDATE signals SET status=? WHERE id=?"
        )
          .bind(result, signalId)
          .run();


        return json({
          status: "recorded",
          signal_id: signalId,
          result
        });

      } catch (e) {

        return json({
          error: e.message
        }, 500);

      }

    }


    return new Response(
      "LIYOG Blitz AI Signal Engine active.",
      { status: 200 }
    );

  }

};


/* ============================================================
   AUTH
============================================================ */

function authorized(request, env) {

  if (!env.ADMIN_SECRET) {
    return false;
  }

  return (
    request.headers.get("Authorization") ===
    `Bearer ${env.ADMIN_SECRET}`
  );

}


/* ============================================================
   MAIN ENGINE
============================================================ */

async function runEngine(env) {

  const cfg = getConfig(env);
  // Keep D1 lean and fast.
try {
  await cleanupStorage(env.DB, cfg);
} catch (e) {
  console.log(
    "Storage cleanup failed:",
    e.message
  );
}
  const assets = await getAssets(env.DB);

  if (!assets.length) {

    return {
      status: "ok",
      assets: 0,
      candidates: 0,
      sent: 0,
      errors: 0
    };

  }


  const started = Date.now();

  const results = [];

  const candidates = [];


  /*
   * PROVIDERS
   */

  const td =
    new TwelveDataProvider(env, cfg);

  const binance =
    new BinanceProvider(cfg);

  const cg =
    new CoinGeckoProvider(env, cfg);

  const oanda =
    new OandaProvider(env, cfg);

  const duk =
    new DukascopyProvider(env, cfg);


  const providers = {
    td,
    binance,
    cg,
    oanda,
    duk
  };


  /*
   * ==========================================================
   * STEP 1
   * REFRESH FX
   *
   * Uses:
   *
   * Twelve Data
   *      ↓
   * Dukascopy
   *      ↓
   * OANDA
   *      ↓
   * Existing cache
   *
   * FX_REFRESH_PER_RUN controls how many assets are refreshed.
   * ==========================================================
   */

  let fxRefresh = [];

  try {

    fxRefresh =
      await refreshFX(
        env,
        cfg,
        assets,
        providers
      );

  } catch (e) {

    results.push({
      status: "ERROR",
      stage: "FX_REFRESH",
      error: e.message
    });

  }


  /*
   * ==========================================================
   * STEP 2
   * REFRESH CRYPTO
   * ==========================================================
   */

  let cryptoRefresh = [];

  try {

    cryptoRefresh =
      await refreshCrypto(
        env,
        cfg,
        assets,
        providers
      );

  } catch (e) {

    results.push({
      status: "ERROR",
      stage: "CRYPTO_REFRESH",
      error: e.message
    });

  }


  /*
   * ==========================================================
   * STEP 3
   * ANALYSIS
   * ==========================================================
   */

  for (const asset of assets) {

    try {

      const state =
        await getMarketState(
          env.DB,
          asset,
          cfg
        );


      const candles =
        state.candles;

      const dq =
        state.quality;


      /*
       * No candles
       */

      if (!candles.length) {

        results.push({
          asset: asset.symbol,
          status: "NO_DATA",
          candles: 0,
          quality: dq.quality,
          reason: dq.reason
        });

        continue;

      }


      /*
       * Not enough candles
       */

      if (!dq.ready) {

        results.push({
          asset: asset.symbol,
          status: "WARMING_UP",
          candles: dq.candles,
          ageSeconds: dq.ageSeconds,
          gaps: dq.gaps,
          quality: Number(dq.quality.toFixed(3)),
          reason: dq.reason
        });

        continue;

      }


      /*
       * Need enough candles for 15m analysis.
       *
       * 20 x 15m = 300 one-minute candles.
       */

      if (candles.length < 300) {

        results.push({
          asset: asset.symbol,
          status: "WARMING_UP",
          candles: candles.length,
          requiredForMTF: 300,
          quality: Number(dq.quality.toFixed(3)),
          reason:
            "Need at least 300 contiguous 1m candles for 15m analysis"
        });

        continue;

      }


      /*
       * External confirmation.
       */

      let external = null;

      const latest =
        candles[candles.length - 1];


      if (asset.kind === "CRYPTO") {

        const previous =
          candles[Math.max(0, candles.length - 4)];

        external = {

          source: "binance",

          direction:
            latest.close > previous.close
              ? "CALL"
              : "PUT"

        };

      } else {

        const previous =
          candles[Math.max(0, candles.length - 4)];

        const move =
          latest.close - previous.close;

        external = {

          source:
            latest.source || "cached",

          direction:
            move >= 0
              ? "CALL"
              : "PUT"

        };

      }


      /*
       * QUANT ANALYSIS
       */

      const analysis =
        analyze(
          asset.symbol,
          candles,
          dq.quality,
          external,
          cfg
        );


      if (!analysis.eligible) {

        results.push({
          asset: asset.symbol,
          status: "FILTERED",
          reason:
            analysis.reason || "No edge",
          score:
            analysis.score ?? null,
          candles: candles.length,
          quality:
            Number(dq.quality.toFixed(3))
        });

        continue;

      }


      candidates.push({
        ...analysis,
        asset,
        feed: {
          candles: candles.length,
          quality: dq.quality,
          ageSeconds: dq.ageSeconds
        }
      });

    } catch (e) {

      results.push({
        asset: asset.symbol,
        status: "ERROR",
        error: e.message
      });

    }

  }


  /*
   * ==========================================================
   * STEP 4
   * RANK
   * ==========================================================
   */

  candidates.sort(
    (a, b) => b.score - a.score
  );


  const selected = [];

  const usedKeys = new Set();


  for (const original of candidates) {

    if (
      selected.length >=
      cfg.maxSignalsPerRun
    ) {
      break;
    }


    const key =
      `${original.asset.symbol}-${original.direction}`;


    if (usedKeys.has(key)) {
      continue;
    }


    const ai =
      await reviewCandidate(
        env,
        original
      );


    const c = {
      ...original,
      ai
    };


    if (ai.ok) {

      if (
        ai.decision !== "APPROVE" ||
        ai.direction !== original.direction
      ) {

        results.push({
          asset:
            original.asset.symbol,
          status:
            "AI_REJECTED",
          reason:
            ai.reason,
          score:
            original.score
        });

        continue;

      }


      c.score =
        Math.round(
          Math.min(
            100,
            Math.max(
              0,
              original.score +
              ai.adjustment
            )
          ) * 10
        ) / 10;


      c.confidence =
        Math.max(
          original.confidence,
          ai.confidence
        );


      c.reason =
        `${original.reason}. AI review: ${ai.reason}`;


      if (c.score < cfg.minScore) {
        continue;
      }

    }


    selected.push(c);

    usedKeys.add(key);

  }


  /*
   * ==========================================================
   * STEP 5
   * TELEGRAM
   * ==========================================================
   */

  let sent = 0;


  for (const c of selected) {

    const {
      entryMs,
      expiryMs
    } = entryAndExpiry(
      cfg.entryLeadMinutes,
      c.expiryMinutes
    );


    const entryTime =
      formatWAT(entryMs);

    const expiryTime =
      formatWAT(expiryMs);


    const message =
      buildTelegram(
        c,
        entryTime,
        expiryTime
      );


    let telegramStatus =
      "Skipped (missing Telegram secrets)";


    if (
      env.TELEGRAM_BOT_TOKEN &&
      env.TELEGRAM_CHAT_ID
    ) {

      try {

        await sendTelegramMessage(
          env,
          message
        );

        telegramStatus =
          "Sent Successfully";

        sent++;

      } catch (e) {

        telegramStatus =
          `Failed: ${e.message}`;

      }

    }


    await env.DB.prepare(`
      INSERT INTO signals
      (
        symbol,
        signal,
        confidence,
        price,
        time_frame,
        entry_time,
        reasoning,
        score,
        expiry_minutes,
        data_source,
        data_quality,
        setup,
        external_confirmation,
        status
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
      .bind(
        c.asset.symbol,
        c.direction,
        c.confidence,
        c.snapshots.s1.close,
        "1M",
        entryTime,
        c.reason,
        c.score,
        c.expiryMinutes,
        "fusion",
        c.dataQuality,
        c.setup,
        c.externalConfirmation,
        "PENDING"
      )
      .run();


    results.push({

      asset:
        c.asset.symbol,

      status:
        "SIGNAL",

      direction:
        c.direction,

      score:
        c.score,

      confidence:
        c.confidence,

      entryTime,

      expiryTime,

      telegramStatus

    });

  }


  return {

    status: "ok",

    durationMs:
      Date.now() - started,

    assets:
      assets.length,

    refreshedFX:
      fxRefresh,

    refreshedCrypto:
      cryptoRefresh,

    candidates:
      candidates.length,

    sent,

    errors:
      results.filter(
        x => x.status === "ERROR"
      ).length,

    results

  };

}


/* ============================================================
   STATUS / FEED MONITOR
============================================================ */

async function status(env) {

  const cfg =
    getConfig(env);

  const assets =
    await getAssets(env.DB);


  const output = [];


  for (const asset of assets) {

    const candles =
      await loadCandles(
        env.DB,
        asset.symbol,
        cfg.candleCount
      );


    const clean =
      candles
        .filter(c =>
          Number.isFinite(Number(c.time)) &&
          [c.open,c.high,c.low,c.close]
            .every(Number.isFinite)
        )
        .sort(
          (a,b) => a.time - b.time
        );


    let gaps = 0;

    for (let i = 1; i < clean.length; i++) {

      const diff =
        clean[i].time -
        clean[i - 1].time;

      if (diff > 75) {

        gaps += Math.max(
          1,
          Math.round(diff / 60) - 1
        );

      }

    }


    const latest =
      clean.at(-1);

    const ageSeconds =
      latest
        ? Math.max(
            0,
            Math.floor(Date.now() / 1000) -
            Number(latest.time)
          )
        : null;


    const five =
      Math.floor(clean.length / 5);

    const fifteen =
      Math.floor(clean.length / 15);


    let state =
      "WARMING_UP";


    if (!clean.length) {

      state = "NO_DATA";

    } else if (
      clean.length >= 300 &&
      gaps === 0 &&
      ageSeconds !== null &&
      ageSeconds <= cfg.cacheMaxAgeSeconds
    ) {

      state = "READY";

    } else if (
      ageSeconds !== null &&
      ageSeconds > cfg.cacheMaxAgeSeconds
    ) {

      state = "STALE";

    }


    output.push({

      asset:
        asset.symbol,

      name:
        asset.display_name,

      kind:
        asset.kind,

      providerSymbol:
        asset.provider_symbol,

      candles1m:
        clean.length,

      required1m:
        300,

      candles5m:
        five,

      required5m:
        30,

      candles15m:
        fifteen,

      required15m:
        20,

      gaps,

      ageSeconds,

      latestCandleUTC:
        latest
          ? new Date(
              Number(latest.time) * 1000
            ).toISOString()
          : null,

      latestSource:
        latest?.source || null,

      state

    });

  }


  return json({

    status: "ok",

    config: {

      candleCount:
        cfg.candleCount,

      fxRefreshPerRun:
        cfg.fxRefreshPerRun,

      cacheMaxAgeSeconds:
        cfg.cacheMaxAgeSeconds,

      providerRetries:
        cfg.providerRetries,

      minSignalScore:
        cfg.minScore,

      minDataQuality:
        cfg.minDataQuality

    },

    assets: output

  });

}


/* ============================================================
   HEALTH
============================================================ */

async function health(env) {

  try {

    const { results } =
      await env.DB.prepare(`
        SELECT
          provider,
          status,
          last_success,
          last_error,
          last_error_code,
          latency_ms,
          consecutive_errors,
          updated_at
        FROM provider_state
        ORDER BY provider
      `).all();


    return json({

      status: "ok",

      providers:
        results || [],

      now:
        new Date().toISOString()

    });

  } catch (e) {

    return json({
      status: "degraded",
      error: e.message
    }, 500);

  }

}


/* ============================================================
   TELEGRAM
============================================================ */

function buildTelegram(
  c,
  entryTime,
  expiryTime
) {

  const call =
    c.direction === "CALL";


  return [

    "━━━━━━━━━━━━━━━━",

    "⚡ *BLITZ AI SIGNAL*",

    "━━━━━━━━━━━━━━━━",

    "",

    `🎫 *Asset:* ${c.asset.display_name}`,

    `➡️ *Direction:* ${
      call
        ? "🟢 CALL (HIGHER) 📈"
        : "🔴 PUT (LOWER) 📉"
    }`,

    `🕐 *Entry:* ${entryTime}`,

    `⏳ *Expiry:* ${expiryTime}`,

    `🎯 *Score:* ${c.score}/100`,

    `🧠 *AI/Quant Confidence:* ${
      Math.round(c.confidence * 100)
    }%`,

    `🧩 *Setup:* ${c.setup}`,

    "",

    `💡 *Reason:* ${c.reason}`,

    "",

    `🔎 *Confirmation:* ${
      c.externalConfirmation
    }`,

    `🛡️ *Data quality:* ${
      Math.round(c.dataQuality * 100)
    }%`,

    "",

    "⚠️ *Use the exact entry time shown. If the setup changes before entry, do not enter.*",

    "━━━━━━━━━━━━━━━━"

  ].join("\n");

}


async function sendTelegramMessage(
  env,
  text
) {

  const url =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;


  const r =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({

          chat_id:
            env.TELEGRAM_CHAT_ID,

          text,

          parse_mode:
            "Markdown"

        })

      }
    );


  if (!r.ok) {

    throw new Error(
      `Telegram HTTP ${r.status}: ${await r.text()}`
    );

  }

}

