export default {
  // Triggered automatically by Cloudflare Cron Schedule
  async scheduled(event, env, ctx) {
    try {
      await processBlitzSignal(env);
    } catch (e) {
      console.error("Cron Execution Error:", e.message);
    }
  },

  // Allows manual trigger via URL (e.g. /trigger)
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/trigger") {
      try {
        const result = await processBlitzSignal(env);
        return Response.json(result);
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: "Execution Failed",
            details: err.message,
            stack: err.stack
          }, null, 2),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (url.pathname === "/history") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT * FROM signals ORDER BY timestamp DESC LIMIT 20"
        ).all();
        return Response.json(results);
      } catch (err) {
        return Response.json({ error: "D1 Query Failed", details: err.message }, { status: 500 });
      }
    }

    return new Response("IQ Option Signal Bot Active. Use /trigger to run test.", { status: 200 });
  }
};

async function processBlitzSignal(env) {
  let candles = [];
  let currentPrice = 0;
  let source = "BYBIT";

  // 1. Primary Data Source: Bybit Free Public V5 Kline API (30 candles, 1-min)
  try {
    const bybitRes = await fetch(
      "https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&limit=30",
      { headers: { "Accept": "application/json" } }
    );
    if (bybitRes.ok) {
      const bData = await bybitRes.json();
      if (bData.retCode === 0 && bData.result && bData.result.list) {
        // Bybit returns candles newest first: [startTime, open, high, low, close, volume, turnover]
        candles = bData.result.list.map(c => ({
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        })).reverse(); // Sort oldest to newest
        currentPrice = candles[candles.length - 1].close;
      } else {
        throw new Error("Invalid Bybit payload");
      }
    } else {
      throw new Error("Bybit response error");
    }
  } catch (err) {
    // Fallback: Binance Kline
    try {
      source = "BINANCE";
      const binanceRes = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=30");
      if (binanceRes.ok) {
        const bData = await binanceRes.json();
        candles = bData.map(c => ({
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        }));
        currentPrice = candles[candles.length - 1].close;
      } else {
        throw new Error("Binance API error");
      }
    } catch (fallbackErr) {
      // Emergency Price Fallback
      source = "COINGECKO";
      const cgRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
      const cgData = await cgRes.json();
      currentPrice = cgData.bitcoin.usd;
    }
  }

  // 2. Compute Entry Time for Next 1-minute candle in WAT
  const now = new Date();
  now.setMinutes(now.getMinutes() + 1);
  const entryTime = now.toLocaleTimeString('en-US', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  // 3. Quantitative Analysis Engine (Fast computation < 5ms)
  let direction = "WAIT";
  let confidence = 0.50;
  let reasoning = "Insufficient market structure data.";
  let skipTrade = false;

  if (candles.length >= 20) {
    const closes = candles.map(c => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi = calculateRSI(closes, 14);
    
    // Market Volatility & Tight-Range Protection (ATR Calculation)
    const atr = calculateATR(candles, 10);
    const avgPrice = currentPrice;
    const atrPercent = (atr / avgPrice) * 100;

    // Detect micro-ranging or dead/tight market condition (Vol Filter)
    const lastCandle = candles[candles.length - 1];
    const candleBodySize = Math.abs(lastCandle.close - lastCandle.open);
    const candleRange = lastCandle.high - lastCandle.low;

    // RULE 1: If market is squeezed into low-volatility tight range (ATR < 0.015%), SKIP trade.
    if (atrPercent < 0.015 || candleRange === 0) {
      skipTrade = true;
      reasoning = `DANGER: Market too tight/ranging (ATR: ${atrPercent.toFixed(4)}%). High fallout risk.`;
    } else {
      const isEmaBullish = ema9 > ema21;
      const isEmaBearish = ema9 < ema21;
      
      // Wick rejection momentum calculation
      const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
      const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;

      // Quantitative Signal Decision Tree
      if (isEmaBullish && rsi > 50 && rsi < 70 && candleBodySize > (candleRange * 0.4)) {
        direction = "CALL";
        confidence = Math.min(0.92, 0.70 + (rsi - 50) * 0.01);
        reasoning = `Bullish EMA Cross (9>21), RSI momentum (${rsi.toFixed(1)}), solid continuation candle.`;
      } else if (isEmaBearish && rsi < 50 && rsi > 30 && candleBodySize > (candleRange * 0.4)) {
        direction = "PUT";
        confidence = Math.min(0.92, 0.70 + (50 - rsi) * 0.01);
        reasoning = `Bearish EMA Cross (9<21), RSI weakness (${rsi.toFixed(1)}), downside pressure.`;
      } else if (rsi >= 70) {
        // Overbought reversal warning - wait or short
        direction = lowerWick > upperWick ? "CALL" : "WAIT";
        confidence = 0.65;
        reasoning = `RSI Overbought (${rsi.toFixed(1)}). Market unstable, awaiting pullback.`;
        if (direction === "WAIT") skipTrade = true;
      } else if (rsi <= 30) {
        // Oversold reversal warning
        direction = upperWick > lowerWick ? "PUT" : "WAIT";
        confidence = 0.65;
        reasoning = `RSI Oversold (${rsi.toFixed(1)}). Reversal risk high.`;
        if (direction === "WAIT") skipTrade = true;
      } else {
        skipTrade = true;
        reasoning = `Choppy price action. EMA flat, RSI neutral (${rsi.toFixed(1)}).`;
      }
    }
  }

  // 4. Workers AI Double Verification (Optimized Execution)
  if (env.AI && !skipTrade) {
    try {
      const prompt = `System: IQ Blitz Option Signal Validator.
Market State: BTC/USD = $${currentPrice}. Signal: ${direction}. Confidence: ${confidence}. Context: ${reasoning}.
Validate if this short-term trend is safe for 60s Blitz. Reply STRICTLY in valid JSON: {"direction": "CALL"|"PUT"|"WAIT", "confidence": 0.75-0.95, "reasoning": "1 sentence"}`;

      const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt });
      if (aiResponse && aiResponse.response) {
        const clean = aiResponse.response.trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.direction === "WAIT") {
            skipTrade = true;
            direction = "WAIT";
          } else if (parsed.direction) {
            direction = parsed.direction;
          }
          if (parsed.confidence) confidence = Math.min(0.95, parseFloat(parsed.confidence));
          if (parsed.reasoning) reasoning = parsed.reasoning;
        }
      }
    } catch (aiErr) {
      console.warn("AI Model bypassed, using quantitative engine:", aiErr.message);
    }
  }

  // 5. Send Telegram Alert (Only send actionable CALL/PUT signals to prevent spamming dead setups)
  let telegramStatus = "Skipped (Low Market Quality / WAIT Signal)";
  
  if (!skipTrade && direction !== "WAIT" && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const isCall = direction === "CALL";
    const directionEmoji = isCall ? "🟢 CALL (HIGHER) 📈" : "🔴 PUT (LOWER) 📉";

    const message = `
🔔 *IQ OPTION BLITZ SIGNAL!*

🎫 *Asset:* 🪙 BTC/USD (Blitz / Crypto)
⚡ *Source:* ${source} Feed
⏳ *Expiration:* 1 Minute
➡️ *Entry Time:* ${entryTime} (WAT)
📈 *Direction:* ${directionEmoji}
🎯 *Confidence:* ${(confidence * 100).toFixed(0)}%

↪️ *Martingale Recovery:*
 Level 1 → ${getOffsetTime(now, 1)}
 Level 2 → ${getOffsetTime(now, 2)}

💡 *Reason:* ${reasoning}
    `.trim();

    await sendTelegramMessage(env, message);
    telegramStatus = "Sent Successfully";
  }

  // 6. Log Signal into Cloudflare D1
  if (env.DB) {
    await env.DB.prepare(
      "INSERT INTO signals (symbol, signal, confidence, price, time_frame, entry_time, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind("BTCUSD", direction, confidence, currentPrice, "1M", entryTime, reasoning).run();
  }

  return {
    status: skipTrade ? "Filtered (Market Skipped)" : "Success",
    source,
    entryTime,
    direction,
    confidence,
    currentPrice,
    telegramStatus,
    reasoning
  };
}

// Technical Indicator Helper Functions
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = (prices[i] * k) + (ema * (1 - k));
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateATR(candles, period = 10) {
  let trSum = 0;
  const slice = candles.slice(-period);
  for (let i = 1; i < slice.length; i++) {
    const high = slice[i].high;
    const low = slice[i].low;
    const prevClose = slice[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  return trSum / (slice.length - 1);
}

function getOffsetTime(baseDate, addMinutes) {
  const d = new Date(baseDate.getTime() + addMinutes * 60000);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

async function sendTelegramMessage(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: "Markdown"
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram API Error: ${errText}`);
  }
}

