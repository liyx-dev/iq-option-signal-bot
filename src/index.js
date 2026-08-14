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
  let currentPrice = 0;
  let change24h = 0;

  // 1. Fetch live market price (Try Binance API first for high-speed response)
  try {
    const binanceRes = await fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT");
    if (binanceRes.ok) {
      const bData = await binanceRes.json();
      currentPrice = parseFloat(bData.lastPrice);
      change24h = parseFloat(bData.priceChangePercent);
    } else {
      throw new Error("Binance API non-200 response");
    }
  } catch (err) {
    // Fallback to CoinGecko with User-Agent header
    const cgRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    if (!cgRes.ok) throw new Error("Failed to fetch market price from both Binance and CoinGecko APIs");
    const data = await cgRes.json();
    currentPrice = data.bitcoin.usd;
    change24h = data.bitcoin.usd_24h_change || 0;
  }

  // 2. Compute Entry Time for Next 1-minute candle
  const now = new Date();
  now.setMinutes(now.getMinutes() + 1);
  const entryTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  // 3. Fallback directional decision logic
  let direction = change24h >= 0 ? "CALL" : "PUT";
  let confidence = 0.80;
  let reasoning = `24h momentum trend bias (${change24h.toFixed(2)}%).`;

  // 4. Run Cloudflare Workers AI Analysis
  if (env.AI) {
    try {
      const prompt = `Analyze 1-minute candle momentum for BTC/USD at $${currentPrice}. Output JSON strictly with keys "direction" ("CALL" or "PUT"), "confidence" (0.7 to 0.95), "reasoning" (1 short sentence).`;
      const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        prompt: prompt
      });
      if (aiResponse && aiResponse.response) {
        reasoning = aiResponse.response.trim();
      }
    } catch (aiErr) {
      console.warn("AI Model bypassed, using fallback engine:", aiErr.message);
    }
  }

  // 5. Send Telegram Alert
  let telegramStatus = "Skipped (Missing Tokens)";
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const isCall = direction === "CALL";
    const directionEmoji = isCall ? "🟢 CALL (HIGHER) 📈" : "🔴 PUT (LOWER) 📉";

    const message = `
🔔 *IQ OPTION BLITZ SIGNAL!*

🎫 *Asset:* 🪙 Bitcoin / OTC
⏳ *Expiration:* 1 Minute
➡️ *Entry Time:* ${entryTime}
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
    status: "Success", 
    entryTime, 
    direction, 
    confidence, 
    currentPrice, 
    telegramStatus 
  };
}

function getOffsetTime(baseDate, addMinutes) {
  const d = new Date(baseDate.getTime() + addMinutes * 60000);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
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
