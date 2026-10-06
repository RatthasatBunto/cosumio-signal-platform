const HARD_MIN_RR = 3;

function calculateRR({ side, entry, sl, tp }) {
  const cleanSide = String(side || "").toUpperCase();
  const e = Number(entry);
  const s = Number(sl);
  const t = Number(tp);

  if (![e, s, t].every(Number.isFinite)) {
    return { ok: false, reason: "Entry / SL / TP must be valid numbers" };
  }

  if (cleanSide === "BUY" && !(s < e && t > e)) {
    return {
      ok: false,
      reason: "BUY requires SL below Entry and TP above Entry"
    };
  }

  if (cleanSide === "SELL" && !(s > e && t < e)) {
    return {
      ok: false,
      reason: "SELL requires SL above Entry and TP below Entry"
    };
  }

  if (!["BUY", "SELL"].includes(cleanSide)) {
    return { ok: false, reason: "Side must be BUY or SELL" };
  }

  const risk = Math.abs(e - s);
  const reward = Math.abs(t - e);

  if (!(risk > 0)) {
    return { ok: false, reason: "Risk distance is zero" };
  }

  const rr = reward / risk;

  if (!Number.isFinite(rr)) {
    return { ok: false, reason: "RR could not be calculated" };
  }

  return {
    ok: true,
    entry: e,
    sl: s,
    tp: t,
    rr: Number(rr.toFixed(2)),
    risk,
    reward
  };
}

function enforceHardRR(plan, configuredMinimum = HARD_MIN_RR) {
  const checked = calculateRR(plan);

  if (!checked.ok) {
    return checked;
  }

  // COSUMIO hard floor: even if MIN_RR is accidentally configured lower,
  // the AI/Owner publish path can never publish below 1:3.
  const minimum = Math.max(HARD_MIN_RR, Number(configuredMinimum) || 0);

  if (checked.rr < minimum) {
    return {
      ok: false,
      reason: `RR 1:${checked.rr.toFixed(2)} is below COSUMIO hard minimum 1:${minimum.toFixed(2)}`,
      rr: checked.rr,
      minimum
    };
  }

  return {
    ...checked,
    ok: true,
    minimum
  };
}

module.exports = {
  HARD_MIN_RR,
  calculateRR,
  enforceHardRR
};
