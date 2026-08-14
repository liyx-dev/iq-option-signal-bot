export default {
  // Triggered automatically by Cloudflare Cron Schedule
  async scheduled(event, env, ctx) {
    await processBlitzSignal(env);
  },

  // Allows manual trigger via URL (e.g. /trigger)
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/trigger") {
      const result = await processBlitzSignal(env);
      return Response.json(result);
    }

    if (url.pathname === "/history") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM signals ORDER BY timestamp DESC LIMIT 20"
      ).all();
      return Response.json(results);
    }

    return new Response("IQ Option Signal Bot Running Active", { status: 200 });
  }
};

async function processBlitzSignal(env) {
  // 1. Fetch live 1-minute ticker market data (BTC/USD used as reference index)
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true");
  const data = await res.json();
  const currentPrice = data.bitcoin.usd;
  const change24h = data.bitcoin.usd_24h_change.toFixed(2);

  // 2. Compute Entry Time for Next 1-minute candle
  const now = new Date();
  now.setMinutes(now.getMinutes() + 1);
  const entryTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  // 3. Formulate Prompt for Workers AI (Llama 3.1)
  const prompt = `
    You are an expert high-frequency binary options trader for IQ Option Blitz/Binary.
    Asset: BTC/USD (Reference Index)
    Current Price: $${currentPrice}
    24h Change: ${change24h}%

    Analyze current momentum for a 1-minute option candle starting at ${entryTime}.
    Output ONLY a valid raw JSON object with these keys:
    "direction": ("CALL" or "PUT"),
    "confidence": (number between 0.0 and 1.0),
    "reasoning": (short 1-sentence breakdown)
  `;

  const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: "You output valid raw JSON only. Do not format with markdown ticks." },
      { role: "user", content: prompt }
    ]
  });

  let analysis;
  try {
    analysis = JSON.parse(aiResponse.response);
  } catch (e) {
    analysis = { direction: "CALL", confidence: 0.5, reasoning: "Pattern fallback evaluation" };
  }

  // 4. Send Telegram Alert if Confidence Threshold (>= 70%) is met
  if (analysis.confidence >= 0.70) {
    const isCall = analysis.direction === "CALL";
    const directionEmoji = isCall ? "🟢 CALL (HIGHER) 📈" : "🔴 PUT (LOWER) 📉";

    const message = `
🔔 *IQ OPTION BLITZ SIGNAL!*

🎫 *Asset:* 🪙 Bitcoin / OTC
⏳ *Expiration:* 1 Minute
➡️ *Entry Time:* ${entryTime}
📈 *Direction:* ${directionEmoji}
🎯 *Confidence:* ${(analysis.confidence * 100).toFixed(0)}%

↪️ *Martingale Recovery (Optional):*
 Level 1 → ${getOffsetTime(now, 1)}
 Level 2 → ${getOffsetTime(now, 2)}

💡 *Reason:* ${analysis.reasoning}
    `.trim();

    await sendTelegramMessage(env, message);

    // 5. Store Signal in Cloudflare D1
    await env.DB.prepare(
      "INSERT INTO signals (symbol, signal, confidence, price, time_frame, entry_time, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind("BTCUSD", analysis.direction, analysis.confidence, currentPrice, "1M", entryTime, analysis.reasoning).run();
  }

  return { success: true, entryTime, analysis };
}

function getOffsetTime(baseDate, addMinutes) {
  const d = new Date(baseDate.getTime() + addMinutes * 60000);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

async function sendTelegramMessage(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: "Markdown"
    })
  });
}
