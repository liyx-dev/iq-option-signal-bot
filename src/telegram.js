export async function sendTelegram(env,text) {
  if(!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return "SKIPPED";
  const url=`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r=await fetch(url,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      chat_id:env.TELEGRAM_CHAT_ID,
      text,
      parse_mode:"Markdown",
      disable_web_page_preview:true
    })
  });
  if(!r.ok) throw new Error(`Telegram error: ${await r.text()}`);
  return "SENT";
}

export function signalMessage({asset,analysis,ai,entry,expiry}) {
  const d=ai?.decision || analysis.direction;
  const emoji=d==="CALL"?"🟢 CALL (HIGHER) 📈":"🔴 PUT (LOWER) 📉";
  const confidence=Math.round((ai?.confidence ?? Math.min(0.99,analysis.score/100))*100);
  const reason=ai?.reasoning || analysis.reason;
  return [
    "━━━━━━━━━━━━━━━━",
    "⚡ *BLITZ AI SIGNAL*",
    "━━━━━━━━━━━━━━━━",
    "",
    `🎫 *Asset:* ${asset.display_name}`,
    `➡️ *Direction:* ${emoji}`,
    `🕐 *Entry:* ${entry}`,
    `⏳ *Expiry:* ${expiry}`,
    `🎯 *Score:* ${analysis.score}/100`,
    `🧠 *AI Confidence:* ${confidence}%`,
    `🧩 *Setup:* ${ai?.setup || analysis.setup}`,
    "",
    `💡 *Reason:* ${reason}`,
    "",
    `⚠️ *Data source:* ${asset.provider}`,
    "Use the exact entry time shown above. If the setup is later invalidated, do not enter.",
    "━━━━━━━━━━━━━━━━"
  ].join("\n");
}
