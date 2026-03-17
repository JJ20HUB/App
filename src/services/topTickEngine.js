'use strict';
/**
 * topTickEngine.js — Top Tick Exhaustion Engine
 * ───────────────────────────────────────────────────────────────────────────
 * Detects ORDER FLOW EXHAUSTION at price extremes using cumulative delta
 * divergence + absorption + volume climax at new N-bar highs and lows.
 *
 * Signal Logic:
 *   SELL  — price makes a new N-bar HIGH while cumulative delta is DECLINING
 *            (institutional sellers absorbing retail buying at the top)
 *   BUY   — price makes a new N-bar LOW  while cumulative delta is RISING
 *            (institutional buyers absorbing retail selling at the bottom)
 *
 * Confidence Scoring (max 100 pts):
 *   1. Divergence Magnitude   (0–40 pts)  — size of the delta/price divergence
 *   2. Absorption at Extreme  (0–20 pts)  — high volume, little price movement
 *   3. Volume Climax          (0–15 pts)  — latest volume ≥ N× rolling average
 *   4. Delta Exhaustion       (0–15 pts)  — momentum loss: delta shrinking vs avg
 *   5. Delta Flip             (0–10 pts)  — latest bar delta opposes price direction
 *
 * Drop-in replacement for OrderFlowEngine — same EventEmitter interface and
 * ingest() / getMetrics() / reset() API.
 */

const EventEmitter = require('events');

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  // Price extreme window — signal only fires when price is at the N-bar high/low
  lookbackBars:        10,

  // Divergence confirmation window — how many recent bars to measure cumDelta shift
  divLookback:          5,

  // Minimum cumDelta change (in the opposite direction to price) to qualify
  // Larger = only very clear divergence fires; lower = more sensitive
  minDivMagnitude:     50,

  // Delta exhaustion: latest bar |delta| must be ≤ this ratio × rolling avg
  // e.g. 0.65 = current delta is ≤65% of the recent average → momentum fading
  exhaustionRatio:     0.65,

  // Absorption: large volume, tiny price movement
  absorptionMinVol:   800,
  absorptionMaxMove:    2,   // ticks

  // Volume climax: latest bar volume ≥ N× rolling window average
  volumeClimaxRatio:   1.5,

  // Minimum confidence score (0-100) to emit a signal
  minConfidence:       60,

  // Bars to skip after a signal fires (prevents back-to-back signals)
  cooldownBars:         5,

  // ATR regime filter — same semantics as OrderFlowEngine
  atrPeriod:           10,
  minAtrTicks:          3,   // below this = choppy, skip
  maxAtrTicks:        120,   // above this = runaway, skip

  // Risk/Reward metadata attached to the signal
  riskRewardRatio:     2.0,

  // Engine warmup — don't fire until N bars have been ingested
  minWarmupBars:       30,

  // Minimum bar volume (avoid trading micro-liquidity spikes)
  minSignalVolume:    200,
};

// ─── Engine ──────────────────────────────────────────────────────────────────

class TopTickEngine extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg = { ...DEFAULTS, ...cfg };
    this.symbolState = {};
  }

  /**
   * Feed a raw bar / tick from the market data adapter.
   * Same input shape as OrderFlowEngine.ingest().
   */
  ingest(raw) {
    const bar = this._normalise(raw);
    if (!bar) return null;

    const sym = bar.symbol;
    if (!this.symbolState[sym]) {
      this.symbolState[sym] = { bars: [], cumDelta: 0, lastSignalIdx: -999, idx: 0 };
    }
    const state = this.symbolState[sym];

    // ── Per-bar derived fields ────────────────────────────────────────────
    bar.delta     = bar.askVol - bar.bidVol;
    state.cumDelta += bar.delta;
    bar.cumDelta  = state.cumDelta;

    // ATR (True Range smoothed)
    const prev = state.bars[state.bars.length - 1];
    bar.tr = prev
      ? Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - prev.close),
          Math.abs(bar.low  - prev.close)
        )
      : bar.high - bar.low;
    bar.atr = prev?.atr
      ? (prev.atr * (this.cfg.atrPeriod - 1) + bar.tr) / this.cfg.atrPeriod
      : bar.tr;

    // Absorption flag
    const tickMove    = prev ? Math.abs(bar.close - prev.close) : 0;
    bar.absorption    = bar.volume >= this.cfg.absorptionMinVol &&
                        tickMove   <= this.cfg.absorptionMaxMove;

    state.bars.push(bar);
    state.idx++;

    // Keep a generous rolling buffer (2× lookback + 20 bars)
    const maxBuf = Math.max(this.cfg.lookbackBars * 2 + 20, 60);
    if (state.bars.length > maxBuf) state.bars.shift();

    const result = this._analyse(sym, state);
    if (result) this.emit('signal', result);
    return result;
  }

  // ─── Core analysis ──────────────────────────────────────────────────────

  _analyse(sym, state) {
    const { bars, idx } = state;

    // Warmup gate
    if (idx < this.cfg.minWarmupBars) return null;
    if (bars.length < this.cfg.lookbackBars + 2) return null;

    const latest = bars[bars.length - 1];

    // ── Volume gate ───────────────────────────────────────────────────────
    if ((latest.volume || 0) < this.cfg.minSignalVolume) return null;

    // ── ATR Regime filter ─────────────────────────────────────────────────
    const atr    = latest.atr || 0;
    const regime = atr < this.cfg.minAtrTicks  ? 'choppy'
                 : atr > this.cfg.maxAtrTicks  ? 'volatile'
                 : 'normal';
    if (regime !== 'normal') return null;

    // ── Cooldown ──────────────────────────────────────────────────────────
    if (idx - state.lastSignalIdx < this.cfg.cooldownBars) return null;

    // ── Price extreme detection ───────────────────────────────────────────
    const window    = bars.slice(-this.cfg.lookbackBars);
    const priceHigh = Math.max(...window.map(b => b.high));
    const priceLow  = Math.min(...window.map(b => b.low));
    const atHigh    = latest.high >= priceHigh;
    const atLow     = latest.low  <= priceLow;

    if (!atHigh && !atLow) return null; // not at an extreme, nothing to fade

    // ── CumDelta divergence ───────────────────────────────────────────────
    // Measure cumDelta shift over the last `divLookback` bars.
    // Bearish divergence: price at high + cumDelta declining → smart money selling
    // Bullish divergence: price at low  + cumDelta rising   → smart money buying
    const divBars  = bars.slice(-this.cfg.divLookback);
    const cdStart  = divBars[0]?.cumDelta ?? state.cumDelta;
    const cdEnd    = latest.cumDelta;
    const cdMove   = cdEnd - cdStart;  // + = buyers winning, − = sellers winning

    const bearishDiv = atHigh && cdMove < -this.cfg.minDivMagnitude;
    const bullishDiv = atLow  && cdMove >  this.cfg.minDivMagnitude;

    if (!bearishDiv && !bullishDiv) return null;

    const direction = bearishDiv ? 'SELL' : 'BUY';

    // ── Confidence scoring ────────────────────────────────────────────────
    const reasons = [];
    let score     = 0;

    // 1. Divergence magnitude (0-40 pts) — stronger divergence = higher score
    const divStrength = Math.min(1, Math.abs(cdMove) / (this.cfg.minDivMagnitude * 4));
    const divScore    = Math.round(divStrength * 40);
    score += divScore;
    reasons.push(
      `${direction === 'SELL' ? '↓' : '↑'} Delta Divergence ` +
      `(${divScore}pts, ΔcumDelta: ${cdMove > 0 ? '+' : ''}${Math.round(cdMove)})`
    );

    // 2. Absorption at the extreme (0-20 pts)
    const recentAbs = bars.slice(-3).filter(b => b.absorption);
    if (recentAbs.length > 0) {
      score += 20;
      reasons.push(`⊕ Absorption @ extreme (${recentAbs.length} bar${recentAbs.length > 1 ? 's' : ''})`);
    }

    // 3. Volume climax (0-15 pts) — volume spike at the extreme
    const windowNoLatest = window.slice(0, -1);
    const avgVol  = windowNoLatest.length
      ? windowNoLatest.reduce((s, b) => s + b.volume, 0) / windowNoLatest.length
      : 0;
    const volRatio = avgVol > 0 ? latest.volume / avgVol : 0;
    if (volRatio >= this.cfg.volumeClimaxRatio) {
      score += 15;
      reasons.push(`📊 Volume climax (${Math.round(volRatio * 10) / 10}× avg)`);
    }

    // 4. Delta exhaustion — momentum loss: current |delta| shrinking (0-15 pts)
    const avgAbsDelta = windowNoLatest.length
      ? windowNoLatest.reduce((s, b) => s + Math.abs(b.delta || 0), 0) / windowNoLatest.length
      : 0;
    if (avgAbsDelta > 0 && Math.abs(latest.delta) <= avgAbsDelta * this.cfg.exhaustionRatio) {
      score += 15;
      reasons.push(
        `⬇ Delta exhaustion ` +
        `(cur:${Math.round(Math.abs(latest.delta))} ≤ ${Math.round(this.cfg.exhaustionRatio * 100)}% of avg:${Math.round(avgAbsDelta)})`
      );
    }

    // 5. Delta flip bonus (0-10 pts) — latest bar delta opposes the price direction
    const deltaFlip = (direction === 'SELL' && latest.delta < 0) ||
                      (direction === 'BUY'  && latest.delta > 0);
    if (deltaFlip) {
      score += 10;
      reasons.push(`↩ Delta flip (${latest.delta >= 0 ? '+' : ''}${Math.round(latest.delta)})`);
    }

    const confidence = Math.min(100, score);
    if (confidence < this.cfg.minConfidence) return null;

    state.lastSignalIdx = idx;

    return {
      symbol:          sym,
      signal:          direction,
      confidence,
      confluences:     reasons.length,  // used by _handleSignal gate
      reasons,
      riskRewardRatio: this.cfg.riskRewardRatio,
      strategyType:    'toptick',
      metrics: {
        delta:      Math.round(latest.delta),
        cumDelta:   Math.round(state.cumDelta),
        cdMove:     Math.round(cdMove),
        imbalance:  latest.volume > 0
          ? Math.round((latest.askVol / latest.volume) * 100) / 100
          : 0.5,
        absorption: recentAbs.length,
        momentum:   cdMove,
        emaDiff:    0,
        priceHigh:  Math.round(priceHigh * 100) / 100,
        priceLow:   Math.round(priceLow  * 100) / 100,
        atr:        Math.round(atr * 100) / 100,
        regime,
        volumeRatio: Math.round(volRatio * 10) / 10,
        // keep buyScore/sellScore so signal log table renders cleanly
        buyScore:   direction === 'BUY'  ? confidence : 0,
        sellScore:  direction === 'SELL' ? confidence : 0,
        trend:      direction === 'BUY'  ? 'BUY' : 'SELL',
      },
      // Last 15 bars of raw order flow tape forwarded to Claude for context
      recentBars: bars.slice(-15).map(b => ({
        t:      b.time,
        o:      b.open,  h: b.high, l: b.low, c: b.close,
        vol:    b.volume,
        askVol: Math.round(b.askVol),
        bidVol: Math.round(b.bidVol),
        delta:  Math.round(b.delta),
        imb:    b.volume > 0 ? Math.round((b.askVol / b.volume) * 100) / 100 : 0.5,
        abs:    b.absorption ? 1 : 0,
        atr:    Math.round((b.atr || 0) * 100) / 100,
      })),
      bar:       latest,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Input normalisation (same as OrderFlowEngine) ────────────────────────

  _normalise(raw) {
    if (!raw) return null;
    const b = {};
    b.symbol  = raw.symbol || raw.sym || raw.ticker || 'UNKNOWN';
    b.time    = raw.time || raw.timestamp || raw.t || Date.now();
    b.open    = parseFloat(raw.open   || raw.o || raw.price || 0);
    b.high    = parseFloat(raw.high   || raw.h || b.open);
    b.low     = parseFloat(raw.low    || raw.l || b.open);
    b.close   = parseFloat(raw.close  || raw.c || raw.last  || b.open);
    b.volume  = parseFloat(raw.volume || raw.vol || raw.v   || 0);

    b.askVol  = parseFloat(
      raw.askVol   || raw.ask_vol || raw.buyVol   || raw.buy_vol  ||
      raw.upVol    || raw.aggressor_buy            || (b.volume * 0.5)
    );
    b.bidVol  = parseFloat(
      raw.bidVol   || raw.bid_vol || raw.sellVol  || raw.sell_vol ||
      raw.downVol  || raw.aggressor_sell           || (b.volume - b.askVol)
    );

    // Keep ask+bid ≤ total volume
    if (b.askVol + b.bidVol > b.volume * 1.05) {
      const total = b.askVol + b.bidVol;
      b.askVol = (b.askVol / total) * b.volume;
      b.bidVol = (b.bidVol / total) * b.volume;
    }
    return b;
  }

  /** Reset engine state for a symbol (or all symbols). */
  reset(symbol) {
    if (symbol) delete this.symbolState[symbol];
    else        this.symbolState = {};
  }

  /** Snapshot of current metrics for a symbol — same shape as OrderFlowEngine. */
  getMetrics(symbol) {
    const state  = this.symbolState[symbol];
    if (!state || !state.bars.length) return null;
    const latest = state.bars[state.bars.length - 1];
    const atr    = latest?.atr ?? 0;
    return {
      symbol,
      bars:      state.bars.length,
      cumDelta:  Math.round(state.cumDelta),
      lastDelta: Math.round(latest?.delta    || 0),
      imbalance: latest?.volume > 0
        ? Math.round((latest.askVol / latest.volume) * 100) / 100
        : 0.5,
      absorption: latest?.absorption || false,
      atr:        Math.round(atr * 100) / 100,
      regime:     atr < this.cfg.minAtrTicks  ? 'choppy'
                : atr > this.cfg.maxAtrTicks  ? 'volatile'
                : 'normal',
    };
  }
}

module.exports = { TopTickEngine };
