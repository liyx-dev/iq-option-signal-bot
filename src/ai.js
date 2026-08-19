import { clamp } from "./utils.js";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export async function reviewCandidate(env, candidate) {
  if (!env.AI) return { ok: false, reason: "AI binding unavailable" };
  const s = candidate.snapshots;
  const payload = {
    asset: candidate.asset.display_name,
    direction: candidate.direction,
    deterministicScore: candidate.score,
    dataQuality: candidate.dataQuality,
    setup: candidate.setup,
    agreement: candidate.agreement,
    regime: candidate.regime,
    oneMinute: s.s1,
    fiveMinute: s.s5,
    fifteenMinute: s.s15,
    externalConfirmation: candidate.externalConfirmation
  };

  const prompt = `You are the final risk-control reviewer for a 1-5 minute binary/Blitz signal.
You are NOT allowed to invent missing market data. The deterministic engine has already computed the features.
Review the setup like a disciplined short-term trader.
Reject marginal, contradictory, overextended or low-quality setups.
Do not chase certainty. A high score is not a guarantee.
Return ONLY JSON matching the supplied schema.

MARKET SNAPSHOT:
${JSON.stringify(payload)}`;

  try {
    const response = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: "You are a conservative quantitative trading reviewer. Prefer NO_TRADE when evidence conflicts." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 220,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "signal_review",
          schema: {
            type: "object",
            properties: {
              decision: { type: "string", enum: ["APPROVE", "REJECT", "WAIT"] },
              direction: { type: "string", enum: ["CALL", "PUT"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              adjustment: { type: "number", minimum: -10, maximum: 10 },
              reason: { type: "string" }
            },
            required: ["decision", "direction", "confidence", "adjustment", "reason"]
          }
        }
      }
    });
    const text = response?.response || response?.result?.response;
    if (!text) return { ok: false, reason: "AI returned no response" };
    const parsed = typeof text === "string" ? JSON.parse(text) : text;
    return {
      ok: true,
      decision: parsed.decision,
      direction: parsed.direction,
      confidence: clamp(Number(parsed.confidence), 0, 1),
      adjustment: clamp(Number(parsed.adjustment), -10, 10),
      reason: String(parsed.reason || "")
    };
  } catch (e) {
    return { ok: false, reason: `AI review failed: ${e.message}` };
  }
}
