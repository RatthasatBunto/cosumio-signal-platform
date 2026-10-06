const fs = require("fs");
const config = require("./config");
const { enforceHardRR, HARD_MIN_RR } = require("./risk-guard");

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["WAIT", "SIGNAL"] },
    side: { type: "string", enum: ["BUY", "SELL", "NONE"] },
    execution: { type: "string", enum: ["MARKET", "LIMIT", "NONE"] },
    entry: { anyOf: [{ type: "number" }, { type: "null" }] },
    sl: { anyOf: [{ type: "number" }, { type: "null" }] },
    tp: { anyOf: [{ type: "number" }, { type: "null" }] },
    rr: { anyOf: [{ type: "number" }, { type: "null" }] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    reason: { type: "string" }
  },
  required: [
    "status",
    "side",
    "execution",
    "entry",
    "sl",
    "tp",
    "rr",
    "confidence",
    "reason"
  ]
};

function readStrategy() {
  return JSON.parse(fs.readFileSync(config.strategyFile, "utf8"));
}

function extractOutputText(body) {
  if (typeof body?.output_text === "string" && body.output_text.trim()) {
    return body.output_text.trim();
  }

  const textParts = [];
  const refusals = [];

  for (const item of body?.output ?? []) {
    for (const part of item?.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        textParts.push(part.text);
      }

      if (part?.type === "refusal" && typeof part.refusal === "string") {
        refusals.push(part.refusal);
      }
    }
  }

  if (refusals.length) {
    throw new Error(`OpenAI refusal: ${refusals.join(" | ")}`);
  }

  const text = textParts.join("").trim();

  if (text) return text;

  const status = body?.status ?? "unknown";
  const reason = body?.incomplete_details?.reason ?? null;

  throw new Error(
    reason
      ? `OpenAI returned no output text. Status: ${status}. Incomplete reason: ${reason}`
      : `OpenAI returned no output text. Status: ${status}`
  );
}

function validateDecision(decision) {
  if (!decision || typeof decision !== "object") {
    return { ok: false, reason: "Invalid AI decision" };
  }

  if (decision.status === "WAIT") {
    return {
      ok: false,
      reason: decision.reason || "AI chose WAIT"
    };
  }

  if (decision.status !== "SIGNAL") {
    return { ok: false, reason: "Invalid status" };
  }

  if (!["BUY", "SELL"].includes(decision.side)) {
    return { ok: false, reason: "Invalid side" };
  }

  if (!["MARKET", "LIMIT"].includes(decision.execution)) {
    return { ok: false, reason: "Invalid execution" };
  }

  const confidence = Number(decision.confidence);

  if (!Number.isFinite(confidence)) {
    return { ok: false, reason: "Invalid confidence" };
  }

  const rrCheck = enforceHardRR(
    {
      side: decision.side,
      entry: decision.entry,
      sl: decision.sl,
      tp: decision.tp
    },
    config.minRR
  );

  if (!rrCheck.ok) {
    return {
      ok: false,
      reason: rrCheck.reason
    };
  }

  if (confidence < config.minConfidence) {
    return {
      ok: false,
      reason: `Confidence ${confidence}% is below minimum ${config.minConfidence}%`
    };
  }

  return {
    ok: true,
    decision: {
      status: "SIGNAL",
      side: decision.side,
      execution: decision.execution,
      entry: rrCheck.entry,
      sl: rrCheck.sl,
      tp: rrCheck.tp,
      rr: rrCheck.rr,
      confidence: Math.round(confidence),
      reason: String(decision.reason || "")
    }
  };
}

async function analyze(snapshot, triggerReasons = []) {
  if (!config.aiEnabled) {
    return { state: "DISABLED" };
  }

  if (!config.openaiApiKey) {
    return { state: "WAITING_FOR_API_KEY" };
  }

  const strategy = readStrategy();
  const effectiveMinRR = Math.max(HARD_MIN_RR, config.minRR);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.openaiModel,
      store: false,
      max_output_tokens: 500,
      instructions: [
        "You are the final analysis engine for COSUMIO SIGNAL.",
        "The backend already filtered weak market locations before calling you.",
        "The lowest and final execution timeframe is M5. Do not use M1 for confirmation, timing, entry, SL, TP, or market structure decisions.",
        "Use H4/H1 for major bias, M15 for setup context, and M5 for final execution.",
        "If any legacy strategy text still mentions M1, treat that M1 instruction as superseded by the owner's current M5 execution rule.",
        "Follow the supplied active strategy exactly except for superseded M1 references described above.",
        "Use only supplied market data.",
        "Never invent prices, indicators, candles, liquidity events, zones, or structure.",
        "Prefer WAIT when evidence is weak or the requested entry is no longer advantageous.",
        "Return one side only: BUY or SELL when status is SIGNAL.",
        "Use LIMIT only when a logical retracement entry exists.",
        "Use MARKET only when confirmation is complete and current price is still worth entering.",
        `COSUMIO hard minimum RR is 1:${effectiveMinRR}. Never output SIGNAL below it.`,
        `Minimum confidence is ${config.minConfidence}%.`,
        "Do not squeeze SL or extend TP merely to manufacture RR.",
        "Keep reason short and factual."
      ].join(" "),
      input: JSON.stringify({
        symbol: config.publicSymbol,
        strategy,
        triggerReasons,
        snapshot
      }),
      text: {
        format: {
          type: "json_schema",
          name: "cosumio_signal_decision",
          strict: true,
          schema
        }
      }
    })
  });

  let body;

  try {
    body = await response.json();
  } catch {
    throw new Error(`OpenAI returned invalid JSON. HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(
      body?.error?.message ||
      body?.message ||
      `OpenAI HTTP ${response.status}`
    );
  }

  if (body?.status === "failed" && body?.error?.message) {
    throw new Error(`OpenAI response failed: ${body.error.message}`);
  }

  const rawText = extractOutputText(body);

  let decision;

  try {
    decision = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Could not parse OpenAI structured output: ${error.message}`
    );
  }

  const checked = validateDecision(decision);

  return {
    state: checked.ok ? "SIGNAL_READY" : "WAIT",
    decision,
    checked,
    responseId: body?.id ?? null,
    responseStatus: body?.status ?? null,
    usage: body?.usage ?? null
  };
}

module.exports = {
  analyze,
  readStrategy,
  extractOutputText,
  validateDecision
};
