import { getConfig } from "./config.js";
import { json, formatWAT } from "./utils.js";

import {
  getAssets, loadCandles, providerHealth, cleanupStorage,
  getScanCursor, setScanCursor, saveScore, getBestRecentScore, getAllRecentScores
} from "./db.js";

import { TwelveDataProvider } from "./providers/twelvedata.js";
import { DukascopyProvider } from "./providers/dukascopy.js";

import { refreshFX, getMarketState } from "./data-orchestrator.js";

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
        mode: "fx-only, best-of-rotation",
        message: "Forex-focused quant signal engine active."
      });
    }


    if (url.pathname === "/health") {
      return await health(env);
    }


    if (url.pathname === "/status") {
      return await status(env);
    }


    // NEW: score distribution across all assets, so the user can
    // see exactly how close (or far) real market conditions are
    // from the MIN_SIGNAL_SCORE bar, without waiting on a signal.
    if (url.pathname === "/scores") {
      return await scores(env);
    }


    if (url.pathname === "/assets") {
      try {
        const assets = await getAssets(env.DB);
        return json(assets);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }


    if (url.pathname === "/history") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
      try {
        const { results } = await env.DB.prepare(
          "SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?"
        ).bind(limit).all();
        return json(results || []);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }


    if (url.pathname === "/trigger") {

      if (!authorized(request, env)) {
        return json({
          error: "Unauthorized",
          message: "Use Authorization: Bearer YOUR_ADMIN_SECRET, or add ?key=YOUR_ADMIN_SECRET to the URL"
        }, 401);
      }

      try {
        return json(await runEngine(env));
      } catch (e) {
        return json({ status: "error", error: e.message, stack: e.stack }, 500);
      }
    }


    if (url.pathname === "/outcome" && request.method === "POST") {

      if (!authorized(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }

      try {
        const body = await request.json();
        const result = String(body.result || "").toUpperCase();

        if (!["WIN", "LOSS", "VOID", "SKIPPED"].includes(result)) {
          return json({ error: "Invalid result" }, 400);
        }

        const signalId = Number(body.signal_id);
        if (!Number.isInteger(signalId)) {
          return json({ error: "signal_id required" }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO signal_outcomes (signal_id,result,observed_price,observed_at,notes)
          VALUES(?,?,?,?,?)
        `).bind(signalId, result, Number(body.observed_price) || null, Date.now(), String(body.notes || "")).run();

        await env.DB.prepare("UPDATE signals SET status=? WHERE id=?").bind(result, signalId).run();

        return json({ status: "recorded", signal_id: signalId, result });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }


    return new Response("LIYOG Blitz AI Signal Engine active. FX-only, best-of-rotation mode.", { status: 200 });

  }

};


/* ============================================================
   AUTH
============================================================ */

function authorized(request, env) {
  const secret = (env.ADMIN_SECRET || "").trim();
  if (!secret) return false;

  const header = (request.headers.get("Authorization") || "").trim();
  if (header === `Bearer ${secret}`) return true;

  const url = new URL(request.url);
  const queryKey = (url.searchParams.get("key") || "").trim();
  return queryKey === secret;
}


/* ============================================================
   MAIN ENGINE
============================================================

   FIX (Aug 2026, FX-only rebuild):
   - Crypto (Bybit/KuCoin) removed entirely. The user trades FX
     more and wants this Worker specialized on FX efficiency; crypto
     can become its own separate, simpler Worker later.
   - "Loop through everyone, pick the strongest" is what the user
     asked for, but CANNOT literally happen in one 10ms tick — full
     analysis of all ~15 FX pairs at once was exactly what caused
     the original CPU-limit crashes. Instead: every tick analyzes a
     small rotating batch (as before) but now SAVES every result
     (eligible or not) to recent_scores. Selection then looks at ALL
     assets scored within the last `bestOfWindowMs` (a full rotation
     cycle) and sends a signal only for the single highest-scoring
     ELIGIBLE one — "best of the rotation window", not "best of
     this exact tick".
============================================================ */

async function runEngine(env) {

  const cfg = getConfig(env);

  // Cleanup only runs occasionally to save subrequest budget.
  const currentMinute = new Date().getMinutes();
  if (currentMinute % 30 === 0) {
    try {
      await cleanupStorage(env.DB, cfg);
    } catch (e) {
      console.log("Storage cleanup failed:", e.message);
    }
  }

  const assets = await getAssets(env.DB);
  const fxAssets = assets.filter(a => a.kind === "FX");

  if (!fxAssets.length) {
    return { status: "ok", assets: 0, scored: 0, sent: 0, errors: 0 };
  }

  const started = Date.now();
  const results = [];

  /*
   * PROVIDERS — FX only.
   * Twelve Data primary, Dukascopy retired stub kept as a harmless
   * no-op in case a future working endpoint appears.
   */
  const td = new TwelveDataProvider(env, cfg);
  const duk = new DukascopyProvider(env, cfg);
  const providers = { td, duk };


  /*
   * STEP 1 — REFRESH FX
   */
  let fxRefresh = [];
  try {
    fxRefresh = await refreshFX(env, cfg, fxAssets, providers);
  } catch (e) {
    results.push({ status: "ERROR", stage: "FX_REFRESH", error: e.message });
  }


  /*
   * STEP 2 — ANALYZE A ROTATING BATCH, SAVE EVERY SCORE
   */
  const cursor = await getScanCursor(env.DB, "fx");
  const limit = Math.min(cfg.analysisPerRun, fxAssets.length);
  const batch = [];
  for (let n = 0; n < limit; n++) {
    batch.push(fxAssets[(cursor + n) % fxAssets.length]);
  }
  await setScanCursor(env.DB, (cursor + limit) % fxAssets.length, "fx");

  let scoredCount = 0;

  for (const asset of batch) {
    try {
      const state = await getMarketState(env.DB, asset, cfg);
      const candles = state.candles;
      const dq = state.quality;

      if (!candles.length) {
        results.push({ asset: asset.symbol, status: "NO_DATA", candles: 0, quality: dq.quality, reason: dq.reason });
        continue;
      }

      if (!dq.ready) {
        results.push({
          asset: asset.symbol, status: "WARMING_UP", candles: dq.candles,
          ageSeconds: dq.ageSeconds, gaps: dq.gaps, quality: Number(dq.quality.toFixed(3)), reason: dq.reason
        });
        continue;
      }

      if (candles.length < 300) {
        results.push({
          asset: asset.symbol, status: "WARMING_UP", candles: candles.length, requiredForMTF: 300,
          quality: Number(dq.quality.toFixed(3)), reason: "Need at least 300 contiguous 1m candles for 15m analysis"
        });
        continue;
      }

      // External confirmation via recent-candle momentum — no extra
      // subrequest needed.
      const latest = candles[candles.length - 1];
      const previous = candles[Math.max(0, candles.length - 4)];
      const move = latest.close - previous.close;
      const external = { source: latest.source || "recent_momentum", direction: move >= 0 ? "CALL" : "PUT" };

      const analysis = analyze(asset.symbol, candles, dq.quality, external, cfg);
      scoredCount++;

      // Save EVERY result — eligible or not — so /scores can show
      // the full picture and the best-of-window selector has fresh
      // data to compare across the whole rotation.
      await saveScore(env.DB, asset.symbol, analysis);

      if (!analysis.eligible) {
        results.push({
          asset: asset.symbol, status: "FILTERED", reason: analysis.reason || "No edge",
          score: analysis.score ?? null, candles: candles.length, quality: Number(dq.quality.toFixed(3))
        });
        continue;
      }

      results.push({
        asset: asset.symbol, status: "SCORED_ELIGIBLE", direction: analysis.direction,
        score: analysis.score, confidence: analysis.confidence
      });

    } catch (e) {
      results.push({ asset: asset.symbol, status: "ERROR", error: e.message });
    }
  }


  /*
   * STEP 3 — BEST-OF-ROTATION-WINDOW SELECTION
   *
   * Look at the single highest-scoring ELIGIBLE asset across the
   * last `bestOfWindowMs` (default: long enough to cover a full
   * rotation through every FX pair at least once), not just this
   * tick's batch. Only ONE signal is sent per invocation.
   */
  let sent = 0;
  const best = await getBestRecentScore(env.DB, cfg.bestOfWindowMs);

  if (best) {
    // Re-fetch full candle context for the winning asset so the
    // Telegram message and AI review have real snapshot data, not
    // just the stored summary row.
    const asset = fxAssets.find(a => a.symbol === best.symbol);

    if (asset) {
      try {
        const state = await getMarketState(env.DB, asset, cfg);
        const latest = state.candles[state.candles.length - 1];
        const previous = state.candles[Math.max(0, state.candles.length - 4)];
        const move = latest.close - previous.close;
        const external = { source: latest.source || "recent_momentum", direction: move >= 0 ? "CALL" : "PUT" };
        const freshAnalysis = analyze(asset.symbol, state.candles, state.quality.quality, external, cfg);

        if (freshAnalysis.eligible) {
          const ai = await reviewCandidate(env, { ...freshAnalysis, asset });

          let finalCandidate = { ...freshAnalysis, asset, ai };
          let shouldSend = true;

          if (ai.ok) {
            if (ai.decision !== "APPROVE" || ai.direction !== freshAnalysis.direction) {
              shouldSend = false;
              results.push({ asset: asset.symbol, status: "AI_REJECTED", reason: ai.reason, score: freshAnalysis.score });
            } else {
              finalCandidate.score = Math.round(Math.min(100, Math.max(0, freshAnalysis.score + ai.adjustment)) * 10) / 10;
              finalCandidate.confidence = Math.max(freshAnalysis.confidence, ai.confidence);
              finalCandidate.reason = `${freshAnalysis.reason}. AI review: ${ai.reason}`;
              if (finalCandidate.score < cfg.minScore) shouldSend = false;
            }
          }

          if (shouldSend) {
            const { entryMs, expiryMs } = entryAndExpiry(cfg.entryLeadMinutes, finalCandidate.expiryMinutes);
            const entryTime = formatWAT(entryMs);
            const expiryTime = formatWAT(expiryMs);
            const message = buildTelegram(finalCandidate, entryTime, expiryTime);

            let telegramStatus = "Skipped (missing Telegram secrets)";
            if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
              try {
                await sendTelegramMessage(env, message);
                telegramStatus = "Sent Successfully";
                sent++;
              } catch (e) {
                telegramStatus = `Failed: ${e.message}`;
              }
            }

            await env.DB.prepare(`
              INSERT INTO signals
              (symbol,signal,confidence,price,time_frame,entry_time,reasoning,score,expiry_minutes,data_source,data_quality,setup,external_confirmation,status)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).bind(
              finalCandidate.asset.symbol, finalCandidate.direction, finalCandidate.confidence,
              finalCandidate.snapshots.s1.close, "1M", entryTime, finalCandidate.reason,
              finalCandidate.score, finalCandidate.expiryMinutes, "fusion", finalCandidate.dataQuality,
              finalCandidate.setup, finalCandidate.externalConfirmation, "PENDING"
            ).run();

            results.push({
              asset: finalCandidate.asset.symbol, status: "SIGNAL", direction: finalCandidate.direction,
              score: finalCandidate.score, confidence: finalCandidate.confidence, entryTime, expiryTime, telegramStatus
            });
          }
        } else {
          // Market moved since it was scored — no longer eligible on
          // a fresh re-check. Correctly skip rather than send stale.
          results.push({ asset: asset.symbol, status: "STALE_ON_RECHECK", reason: freshAnalysis.reason });
        }
      } catch (e) {
        results.push({ asset: asset.symbol, status: "ERROR", stage: "BEST_SELECTION", error: e.message });
      }
    }
  }


  return {
    status: "ok",
    durationMs: Date.now() - started,
    assets: fxAssets.length,
    refreshedFX: fxRefresh,
    scored: scoredCount,
    bestCandidate: best ? { symbol: best.symbol, score: best.score, scoredAt: new Date(best.scored_at).toISOString() } : null,
    sent,
    errors: results.filter(x => x.status === "ERROR").length,
    results
  };

}


/* ============================================================
   STATUS / FEED MONITOR
============================================================ */

async function status(env) {

  const cfg = getConfig(env);
  const assets = (await getAssets(env.DB)).filter(a => a.kind === "FX");
  const output = [];

  for (const asset of assets) {
    const candles = await loadCandles(env.DB, asset.symbol, cfg.candleCount);

    const clean = candles
      .filter(c => Number.isFinite(Number(c.time)) && [c.open, c.high, c.low, c.close].every(Number.isFinite))
      .sort((a, b) => a.time - b.time);

    let gaps = 0;
    for (let i = 1; i < clean.length; i++) {
      const diff = clean[i].time - clean[i - 1].time;
      if (diff > 75) gaps += Math.max(1, Math.round(diff / 60) - 1);
    }

    const latest = clean.at(-1);
    const ageSeconds = latest ? Math.max(0, Math.floor(Date.now() / 1000) - Number(latest.time)) : null;

    const five = Math.floor(clean.length / 5);
    const fifteen = Math.floor(clean.length / 15);

    let state = "WARMING_UP";
    if (!clean.length) {
      state = "NO_DATA";
    } else if (clean.length >= 300 && gaps === 0 && ageSeconds !== null && ageSeconds <= cfg.cacheMaxAgeSeconds) {
      state = "READY";
    } else if (ageSeconds !== null && ageSeconds > cfg.cacheMaxAgeSeconds) {
      state = "STALE";
    }

    output.push({
      asset: asset.symbol, name: asset.display_name, providerSymbol: asset.provider_symbol,
      candles1m: clean.length, required1m: 300, candles5m: five, required5m: 30, candles15m: fifteen, required15m: 20,
      gaps, ageSeconds, latestCandleUTC: latest ? new Date(Number(latest.time) * 1000).toISOString() : null,
      latestSource: latest?.source || null, state
    });
  }

  return json({
    status: "ok",
    config: {
      candleCount: cfg.candleCount, fxRefreshPerRun: cfg.fxRefreshPerRun, cacheMaxAgeSeconds: cfg.cacheMaxAgeSeconds,
      minSignalScore: cfg.minScore, minDataQuality: cfg.minDataQuality, analysisPerRun: cfg.analysisPerRun,
      bestOfWindowMs: cfg.bestOfWindowMs
    },
    assets: output
  });
}


/* ============================================================
   SCORES — diagnostic distribution across all FX assets
============================================================ */

async function scores(env) {
  try {
    const rows = await getAllRecentScores(env.DB);
    const cfg = getConfig(env);

    const enriched = rows.map(r => ({
      symbol: r.symbol,
      direction: r.direction,
      score: r.score,
      confidence: r.confidence,
      dataQuality: r.data_quality,
      agreement: r.agreement,
      regime: r.regime,
      eligible: !!r.eligible,
      scoredAt: new Date(r.scored_at).toISOString(),
      ageSeconds: Math.round((Date.now() - r.scored_at) / 1000),
      distanceFromThreshold: r.score != null ? Math.round((r.score - cfg.minScore) * 10) / 10 : null
    }));

    const withScore = enriched.filter(r => r.score != null);
    const avgScore = withScore.length ? Math.round((withScore.reduce((s, r) => s + r.score, 0) / withScore.length) * 10) / 10 : null;
    const maxScore = withScore.length ? Math.max(...withScore.map(r => r.score)) : null;

    return json({
      status: "ok",
      minSignalScore: cfg.minScore,
      summary: { assetsScored: withScore.length, averageScore: avgScore, highestScore: maxScore },
      scores: enriched
    });
  } catch (e) {
    return json({ status: "error", error: e.message }, 500);
  }
}


/* ============================================================
   HEALTH
============================================================ */

async function health(env) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT provider, status, last_success, last_error, last_error_code, latency_ms, consecutive_errors, updated_at
      FROM provider_state ORDER BY provider
    `).all();

    const dayKey = new Date().toISOString().slice(0, 10);
    const minuteKey = new Date().toISOString().slice(0, 16);
    const dayRow = await env.DB.prepare(
      "SELECT used, quota FROM quota_usage WHERE provider='twelvedata' AND window_type='day' AND window_key=?"
    ).bind(dayKey).first();
    const minuteRow = await env.DB.prepare(
      "SELECT used, quota FROM quota_usage WHERE provider='twelvedata' AND window_type='minute' AND window_key=?"
    ).bind(minuteKey).first();

    return json({
      status: "ok",
      providers: results || [],
      twelveDataQuota: {
        today: dayRow ? { used: Number(dayRow.used), quota: Number(dayRow.quota) } : { used: 0, quota: 800 },
        thisMinute: minuteRow ? { used: Number(minuteRow.used), quota: Number(minuteRow.quota) } : { used: 0, quota: 8 }
      },
      now: new Date().toISOString()
    });
  } catch (e) {
    return json({ status: "degraded", error: e.message }, 500);
  }
}


/* ============================================================
   TELEGRAM
============================================================ */

function buildTelegram(c, entryTime, expiryTime) {
  const call = c.direction === "CALL";

  return [
    "━━━━━━━━━━━━━━━━",
    "⚡ *BLITZ AI SIGNAL*",
    "━━━━━━━━━━━━━━━━",
    "",
    `🎫 *Asset:* ${c.asset.display_name}`,
    `➡️ *Direction:* ${call ? "🟢 CALL (HIGHER) 📈" : "🔴 PUT (LOWER) 📉"}`,
    `🕐 *Entry:* ${entryTime}`,
    `⏳ *Expiry:* ${expiryTime}`,
    `🎯 *Score:* ${c.score}/100`,
    `🧠 *AI/Quant Confidence:* ${Math.round(c.confidence * 100)}%`,
    `🧩 *Setup:* ${c.setup}`,
    "",
    `💡 *Reason:* ${c.reason}`,
    "",
    `🔎 *Confirmation:* ${c.externalConfirmation}`,
    `🛡️ *Data quality:* ${Math.round(c.dataQuality * 100)}%`,
    "",
    "⚠️ *Use the exact entry time shown. If the setup changes before entry, do not enter.*",
    "━━━━━━━━━━━━━━━━"
  ].join("\n");
}

async function sendTelegramMessage(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
  });

  if (!r.ok) {
    throw new Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
  }
}

