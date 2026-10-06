const config = require("./config");
const store = require("./store");
const { snapshot, shouldTrigger } = require("./indicators");
const { analyze } = require("./ai");
const { HARD_MIN_RR } = require("./risk-guard");

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

class SignalEngine {
  constructor({ market, broadcast }) {
    this.market = market;
    this.broadcast = broadcast;
    this.lastAiAt = 0;
    this.state = "IDLE";
    this.lastDecision = null;
    this.lastError = null;
    this.lastTriggerReasons = [];
    this.lastBlockedReasons = [];
    this.lastSkipReason = null;
    this.lastRequestContext = null;
    this.lastUsage = null;
    this.requestsDay = utcDayKey();
    this.requestsToday = 0;
    this.skippedByPrefilter = 0;
    this.skippedByCooldown = 0;
    this.skippedAsDuplicate = 0;
    this.skippedByDailyLimit = 0;
  }

  resetDailyCounterIfNeeded() {
    const day = utcDayKey();
    if (day !== this.requestsDay) {
      this.requestsDay = day;
      this.requestsToday = 0;
    }
  }

  effectiveMinRR() {
    return Math.max(HARD_MIN_RR, config.minRR);
  }

  status() {
    this.resetDailyCounterIfNeeded();

    return {
      state: this.state,
      enabled: config.aiEnabled,
      autoPublish: config.autoPublish,
      model: config.openaiModel,
      hasOpenAIKey: Boolean(config.openaiApiKey),
      cooldownSeconds: config.aiCooldownSeconds,
      minConfidence: config.minConfidence,
      minRR: this.effectiveMinRR(),
      hardMinRR: HARD_MIN_RR,
      executionTimeframe: config.executionTimeframe,
      lastAiAt: this.lastAiAt || null,
      lastDecision: this.lastDecision,
      lastError: this.lastError,
      lastTriggerReasons: this.lastTriggerReasons,
      lastBlockedReasons: this.lastBlockedReasons,
      lastSkipReason: this.lastSkipReason,
      lastUsage: this.lastUsage,
      costGuard: {
        requestDayUtc: this.requestsDay,
        requestsToday: this.requestsToday,
        dailyRequestLimit: config.aiDailyRequestLimit,
        duplicateWindowSeconds: config.aiDuplicateWindowSeconds,
        minPriceMoveAtr: config.aiMinPriceMoveAtr,
        snapshotBars: {
          M5: config.aiSnapshotBarsM5,
          M15: config.aiSnapshotBarsM15,
          H1: config.aiSnapshotBarsH1,
          H4: config.aiSnapshotBarsH4
        },
        skippedByPrefilter: this.skippedByPrefilter,
        skippedByCooldown: this.skippedByCooldown,
        skippedAsDuplicate: this.skippedAsDuplicate,
        skippedByDailyLimit: this.skippedByDailyLimit
      }
    };
  }

  dailyLimitReached() {
    this.resetDailyCounterIfNeeded();
    return (
      config.aiDailyRequestLimit > 0 &&
      this.requestsToday >= config.aiDailyRequestLimit
    );
  }

  isDuplicateContext(s, reasons) {
    const previous = this.lastRequestContext;
    if (!previous) return false;

    const ageMs = Date.now() - previous.at;
    if (ageMs > config.aiDuplicateWindowSeconds * 1000) return false;

    const signature = [...reasons].sort().join("|");
    if (signature !== previous.signature) return false;

    const atr = Number(s?.frames?.M5?.atr14);
    if (!(atr > 0)) return false;

    const move = Math.abs(Number(s.livePrice) - previous.price);
    return move < atr * config.aiMinPriceMoveAtr;
  }

  markSkip(reason, state = "FILTERED") {
    this.lastSkipReason = reason;
    this.state = state;
    this.broadcast("ai-status", this.status());
  }

  async onCandleClose({ price, closedFrames }) {
    const s = snapshot(this.market.book, price);
    const t = shouldTrigger(s, closedFrames);

    this.lastTriggerReasons = t.reasons || [];
    this.lastBlockedReasons = t.blocked || [];

    if (!t.trigger) {
      this.skippedByPrefilter += 1;
      this.lastSkipReason = (t.blocked || []).join(", ") || "BACKEND_PREFILTER";
      return;
    }

    if (Date.now() - this.lastAiAt < config.aiCooldownSeconds * 1000) {
      this.skippedByCooldown += 1;
      this.markSkip("AI_COOLDOWN_ACTIVE");
      return;
    }

    if (this.isDuplicateContext(s, t.reasons)) {
      this.skippedAsDuplicate += 1;
      this.markSkip("DUPLICATE_MARKET_CONTEXT");
      return;
    }

    if (this.dailyLimitReached()) {
      this.skippedByDailyLimit += 1;
      this.markSkip("AI_DAILY_REQUEST_LIMIT_REACHED", "COST_GUARD");
      return;
    }

    await this.run(s, t.reasons, { manual: false });
  }

  async manual() {
    if (!Number.isFinite(this.market.price)) {
      throw new Error("No live market price yet");
    }

    if (this.dailyLimitReached()) {
      this.skippedByDailyLimit += 1;
      this.markSkip("AI_DAILY_REQUEST_LIMIT_REACHED", "COST_GUARD");
      throw new Error(
        `AI daily request limit reached (${config.aiDailyRequestLimit}/day). Set AI_DAILY_REQUEST_LIMIT=0 to disable the cap.`
      );
    }

    return this.run(
      snapshot(this.market.book, this.market.price),
      ["OWNER_MANUAL_ANALYSIS"],
      { manual: true }
    );
  }

  async run(s, reasons, { manual = false } = {}) {
    this.resetDailyCounterIfNeeded();

    this.lastAiAt = Date.now();
    this.lastError = null;
    this.lastSkipReason = null;
    this.state = "ANALYZING";

    // Count a paid-capable request only when AI is enabled and a key exists.
    if (config.aiEnabled && config.openaiApiKey) {
      this.requestsToday += 1;
    }

    this.lastRequestContext = {
      at: this.lastAiAt,
      price: Number(s.livePrice),
      signature: [...reasons].sort().join("|"),
      manual
    };

    this.broadcast("ai-status", this.status());

    try {
      const r = await analyze(s, reasons);
      this.lastDecision = r;
      this.lastUsage = r.usage || null;
      this.state = r.state;

      if (
        r.state === "SIGNAL_READY" &&
        r.checked?.ok &&
        config.autoPublish
      ) {
        const d = r.checked.decision;

        const item = store.addSignal({
          symbol: config.publicSymbol,
          side: d.side,
          execution: d.execution,
          entry: d.entry,
          sl: d.sl,
          tp: d.tp,
          rr: `1:${d.rr}`,
          confidence: `${d.confidence}%`,
          status: d.execution === "MARKET" ? "READY" : "WAIT",
          source: "AI",
          reason: d.reason
        });

        this.broadcast("signal", item);
        this.state = "PUBLISHED";
      }

      this.broadcast("ai-status", this.status());
      return r;
    } catch (e) {
      this.state = "ERROR";
      this.lastError = e.message;
      this.broadcast("ai-status", this.status());
      throw e;
    }
  }
}

module.exports = { SignalEngine };
