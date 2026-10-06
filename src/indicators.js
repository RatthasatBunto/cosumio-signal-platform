const config = require("./config");

function ema(v, p) {
  if (v.length < p) return null;
  const k = 2 / (p + 1);
  let x = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < v.length; i++) x = v[i] * k + x * (1 - k);
  return x;
}

function atr(c, p = 14) {
  if (c.length < p + 1) return null;
  const t = [];
  for (let i = 1; i < c.length; i++) {
    const a = c[i], b = c[i - 1];
    t.push(Math.max(
      a.high - a.low,
      Math.abs(a.high - b.close),
      Math.abs(a.low - b.close)
    ));
  }
  return ema(t, p);
}

function stats(c) {
  const v = c.map(x => x.close);
  const e20 = ema(v, 20);
  const e50 = ema(v, 50);
  const r = c.slice(-20);

  return {
    close: c.at(-1)?.close ?? null,
    ema20: e20,
    ema50: e50,
    atr14: atr(c),
    recentHigh20: r.length ? Math.max(...r.map(x => x.high)) : null,
    recentLow20: r.length ? Math.min(...r.map(x => x.low)) : null,
    bias:
      e20 == null || e50 == null
        ? "UNKNOWN"
        : e20 > e50
          ? "BULLISH"
          : "BEARISH"
  };
}

function snapshot(book, price) {
  const barLimits = {
    M5: config.aiSnapshotBarsM5,
    M15: config.aiSnapshotBarsM15,
    H1: config.aiSnapshotBarsH1,
    H4: config.aiSnapshotBarsH4
  };

  // IMPORTANT: M1 is intentionally not included. According to the owner's
  // current strategy, M5 is the lowest and final execution timeframe.
  return {
    livePrice: price,
    generatedAt: new Date().toISOString(),
    executionTimeframe: config.executionTimeframe,
    frames: Object.fromEntries(
      ["M5", "M15", "H1", "H4"].map(f => [
        f,
        {
          ...stats(book.get(f)),
          lastCandles: book.get(f, barLimits[f])
        }
      ])
    )
  };
}

function distanceToNearestM5Swing(s) {
  const m = s.frames.M5;
  if (!Number.isFinite(m.atr14) || !(m.atr14 > 0)) return null;

  const distances = [];

  if (Number.isFinite(m.recentHigh20)) {
    distances.push({
      type: "HIGH",
      distance: Math.abs(s.livePrice - m.recentHigh20),
      level: m.recentHigh20
    });
  }

  if (Number.isFinite(m.recentLow20)) {
    distances.push({
      type: "LOW",
      distance: Math.abs(s.livePrice - m.recentLow20),
      level: m.recentLow20
    });
  }

  if (!distances.length) return null;

  distances.sort((a, b) => a.distance - b.distance);
  return {
    ...distances[0],
    atrDistance: distances[0].distance / m.atr14
  };
}

function shouldTrigger(s, closed = []) {
  const reasons = [];
  const blocked = [];

  const enough = ["M5", "M15", "H1", "H4"]
    .every(f => s.frames[f].ema50 != null);

  if (!enough) {
    return {
      trigger: false,
      reasons,
      blocked: ["NOT_ENOUGH_MARKET_HISTORY"]
    };
  }

  // M5 is the lowest execution timeframe. Do not spend an AI request on M1
  // closes or arbitrary ticks. Automatic review begins on a completed M5 bar.
  if (!closed.includes("M5")) {
    blocked.push("WAIT_FOR_M5_CLOSE");
  } else {
    reasons.push("M5_CANDLE_CLOSED");
  }

  const h4 = s.frames.H4.bias;
  const h1 = s.frames.H1.bias;

  if (
    ["BULLISH", "BEARISH"].includes(h4) &&
    ["BULLISH", "BEARISH"].includes(h1) &&
    h4 !== h1
  ) {
    blocked.push("H4_H1_CONFLICT");
  } else if (h4 !== "UNKNOWN" && h1 !== "UNKNOWN") {
    reasons.push(`HTF_ALIGNED_${h4}`);
  }

  const nearest = distanceToNearestM5Swing(s);

  if (!nearest) {
    blocked.push("NO_M5_SWING_CONTEXT");
  } else {
    // On M5 execution we can allow a slightly wider approach window and let
    // the final AI distinguish WAIT vs ENTER. This still avoids paying when
    // price is clearly nowhere near a recent M5 liquidity/swing location.
    const thresholdAtr = 0.55;

    if (nearest.atrDistance <= thresholdAtr) {
      reasons.push(
        nearest.type === "HIGH"
          ? "PRICE_NEAR_M5_SWING_HIGH"
          : "PRICE_NEAR_M5_SWING_LOW"
      );
    } else {
      blocked.push("PRICE_NOT_NEAR_M5_KEY_AREA");
    }
  }

  return {
    trigger: blocked.length === 0 && reasons.length >= 3,
    reasons,
    blocked,
    nearestM5Swing: nearest
  };
}

module.exports = {
  snapshot,
  shouldTrigger,
  distanceToNearestM5Swing
};
