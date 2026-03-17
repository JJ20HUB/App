'use strict';
/**
 * orderFlowEngine.js
 *
 * AI Order Flow Signal Engine  (v2 — with Trend + Regime filters)
 * ──────────────────────────────────────────────────────────────────
 * Ingests raw market tape / order-flow data, computes key metrics in a rolling
 * window, applies trend & volatility-regime filters, and emits directional
 * signals ready for a 2:1 (or configurable) risk-reward auto-trader.
 *
 * Scoring components (total max ≈ 130 pts):
 *   • Delta strength       (0-25)  — net buy/sell aggressor volume per bar
 *   • Cumulative Delta     (0-25)  — sustained directional pressure over window
 *   • Volume Imbalance     (0-25)  — ask% vs bid% proportion
 *   • Absorption           (0-25)  — large volume with no resulting price move
 *   • Momentum             (0-10)  — direction of rolling delta sum
 *   • Trend Alignment      (0-20)  — EMA slope agrees with signal direction
 *
 * Regime (ATR) filter — SUPPRESSES the signal if:
 *   • ATR < minAtrTicks  → market too quiet / choppy, edges don't follow through
 *   • ATR > maxAtrTicks  → market too runaway / gapping, SL likely to blow
 *
 * Signal output:
 *   { signal:'BUY'|'SELL'|'HOLD', confidence:0-100, reasons:string[],
 *     riskRewardRatio, metrics:{delta,cumDelta,imbalance,absorption,momentum,
 *                                ema,atr,trend,regime} }
 */

const EventEmitter = require('events');

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  windowSize:          20,       // bars in the rolling analysis window
  deltaThreshold:      250,      // min |delta| to consider meaningful
  imbalanceThreshold:  0.62,     // >62% ask vol = buy signal component
  absorptionMinVol:    1000,     // min volume to qualify as absorption candle
  absorptionMaxMove:   2,        // max ticks moved for absorption classification
  momentumPeriod:      5,        // bars to compute momentum over
  minConfidence:       70,       // ↑ raised: only fire genuinely high-probability signals
  cooldownBars:        5,        // ↑ raised: prevents chasing fast moves
  // ── Trend filter ──────────────────────────────────────────────────────────
  trendPeriod:         10,       // EMA period for trend direction
  trendBonus:          20,       // max pts added when signal aligns with EMA slope
  // ── Regime (ATR) filter ───────────────────────────────────────────────────
  atrPeriod:           10,       // period for Average True Range
  minAtrTicks:         4,        // ↑ raised: skip dead / no-edge markets
  maxAtrTicks:         100,      // ↓ tightened: skip blow-through runaway conditions
  // ── Risk / reward ─────────────────────────────────────────────────────────
  riskRewardRatio:     2.0,      // TP = SL × riskRewardRatio  (2 = 2:1)
  // ── Confluence gate (NEW) ─────────────────────────────────────────────────
  // Minimum number of the 6 scored components that must agree on direction.
  // Higher = fewer trades, higher quality. 4/6 = strong multi-factor confirmation.
  minConfluence:       4,        // require ≥4 components pointing the same way
  // ── Signal warmup (NEW) ───────────────────────────────────────────────────
  // Don't fire any signal until this many bars have been ingested (engine warm-up).
  minWarmupBars:       30,
  // ── Volume gate (NEW) ────────────────────────────────────────────────────
  // Signal bar must have at least this much volume to avoid low-liquidity noise.
  minSignalVolume:     200,
  // ── Delta/CumDelta/Imbalance triple-lock (NEW) ────────────────────────────
  // When true, ALL THREE core order-flow metrics (delta direction, cumDelta trend,
  // imbalance direction) must agree with the signal. Eliminates mixed signals.
  requireTripleLock:   true,
};

// ─── Engine class ─────────────────────────────────────────────────────────────

class OrderFlowEngine extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg = { ...DEFAULTS, ...cfg };
    this.bars = [];           // rolling window of processed bars
    this.cumDelta = 0;        // running cumulative delta
    this.lastSignalBar = -999;// bar index of last non-HOLD signal
    this.barIndex = 0;
    this.symbolState = {};    // per-symbol state for multi-symbol feeds
  }

  /**
   * Feed a raw bar / tick event from the market data API.
   * Expected shape (flexible — engine normalises):
   * {
   *   symbol:  'NQ'|'ES'|'MES' etc.,
   *   time:    ISO timestamp or ms,
   *   open, high, low, close: numbers,
   *   volume:  total bar volume,
   *   askVol:  volume traded at ask (buy aggressor),
   *   bidVol:  volume traded at bid (sell aggressor),
   *   trades?: number of individual trades (optional)
   * }
   */
  ingest(raw) {
    const bar = this._normalise(raw);
    if (!bar) return null;

    const sym = bar.symbol;
    if (!this.symbolState[sym]) {
      this.symbolState[sym] = {
        bars: [], cumDelta: 0, lastSignalIdx: -999, idx: 0,
        ema: null,   // running EMA of close
      };
    }
    const state = this.symbolState[sym];

    // Compute bar delta
    bar.delta = bar.askVol - bar.bidVol;
    state.cumDelta += bar.delta;
    bar.cumDelta = state.cumDelta;

    // Absorption: high volume but small price move
    const tickMove = state.bars.length
      ? Math.abs(bar.close - state.bars[state.bars.length - 1].close)
      : 0;
    bar.absorption =
      bar.volume >= this.cfg.absorptionMinVol && tickMove <= this.cfg.absorptionMaxMove;

    // Volume imbalance ratio
    bar.imbalance = bar.volume > 0 ? bar.askVol / bar.volume : 0.5;

    // ── EMA of close (trend direction) ────────────────────────────────────
    const k = 2 / (this.cfg.trendPeriod + 1);
    state.ema = state.ema == null ? bar.close : bar.close * k + state.ema * (1 - k);
    bar.ema = state.ema;

    // ── True Range → ATR (regime / volatility) ────────────────────────────
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

    state.bars.push(bar);
    state.idx++;

    // Keep rolling window
    if (state.bars.length > this.cfg.windowSize) state.bars.shift();

    const result = this._analyse(sym, state);
    if (result) this.emit('signal', result);
    return result;
  }

  // ─── Core analysis ────────────────────────────────────────────────────────

  _analyse(sym, state) {
    const { bars, lastSignalIdx, idx } = state;
    if (bars.length < 5) return null; // need minimum history

    // ── Warmup gate — don't trade until the engine has seen enough bars ───
    if (idx < this.cfg.minWarmupBars) return null;

    const recent = bars.slice(-this.cfg.momentumPeriod);
    const latest = bars[bars.length - 1];

    // ── Volume gate — skip signal bars with too little volume ─────────────
    if ((latest.volume || 0) < this.cfg.minSignalVolume) return null;

    // ── Regime filter (ATR) ───────────────────────────────────────────────
    //    Too tight = choppy, too wide = blow-through — skip signal.
    const atr = latest.atr || 0;
    const regimeOk = (
      (!this.cfg.minAtrTicks || atr >= this.cfg.minAtrTicks) &&
      (!this.cfg.maxAtrTicks || atr <= this.cfg.maxAtrTicks)
    );
    const regime = atr < (this.cfg.minAtrTicks || 0) ? 'choppy'
                 : atr > (this.cfg.maxAtrTicks || Infinity) ? 'volatile'
                 : 'normal';

    // 1. Delta strength score (0-25)
    const absDelta = Math.abs(latest.delta);
    const deltaScore = Math.min(25, (absDelta / this.cfg.deltaThreshold) * 25);
    const deltaDir   = latest.delta > 0 ? 'BUY' : 'SELL';

    // 2. Cumulative delta trend (0-25)
    const cdOld  = bars[0]?.cumDelta ?? state.cumDelta;
    const cdNew  = latest.cumDelta;
    const cdDiff = cdNew - cdOld;
    const cdScore = Math.min(25, (Math.abs(cdDiff) / (this.cfg.deltaThreshold * 3)) * 25);
    const cdDir   = cdDiff > 0 ? 'BUY' : 'SELL';

    // 3. Volume imbalance (0-25)
    const avgImbalance = recent.reduce((s, b) => s + b.imbalance, 0) / recent.length;
    let imbalanceScore = 0;
    let imbalanceDir = 'HOLD';
    if (avgImbalance > this.cfg.imbalanceThreshold) {
      imbalanceScore = Math.min(25, ((avgImbalance - 0.5) / 0.5) * 50);
      imbalanceDir = 'BUY';
    } else if (avgImbalance < (1 - this.cfg.imbalanceThreshold)) {
      imbalanceScore = Math.min(25, (((1 - avgImbalance) - 0.5) / 0.5) * 50);
      imbalanceDir = 'SELL';
    }

    // 4. Absorption signal (0-25)
    const recentAbsorption = recent.filter(b => b.absorption);
    const absScore = Math.min(25, recentAbsorption.length * 8);
    let absDir = 'HOLD';
    if (recentAbsorption.length >= 1) {
      const absBar = recentAbsorption[recentAbsorption.length - 1];
      absDir = absBar.delta > 0 ? 'HOLD' : 'BUY'; // sellers absorbed → price likely rises
    }

    // 5. Momentum (0-10)
    const momentumDelta = recent.reduce((s, b) => s + b.delta, 0);
    const momentumDir = momentumDelta > 0 ? 'BUY' : 'SELL';
    const momentumScore = absDelta > 50 ? 10 : 0;

    // 6. EMA Trend alignment (0-20 bonus pts)
    //    Compare last EMA to EMA from `trendPeriod` bars ago for slope
    const trendBars = bars.slice(-this.cfg.trendPeriod);
    const emaOld   = trendBars[0]?.ema ?? latest.ema;
    const emaNew   = latest.ema;
    const emaDiff  = emaNew - emaOld;
    const trendDir = emaDiff > 0 ? 'BUY' : emaDiff < 0 ? 'SELL' : 'HOLD';
    const trendStrength = Math.min(1, Math.abs(emaDiff) / (atr || 1)); // normalised by ATR
    const trendScore = this.cfg.trendBonus * trendStrength; // 0-20

    // ── Vote aggregation ──────────────────────────────────────────────────────
    const votes = [
      { dir: deltaDir,      score: deltaScore,      label: 'Delta' },
      { dir: cdDir,         score: cdScore,          label: 'Cum.Delta' },
      { dir: imbalanceDir,  score: imbalanceScore,   label: 'Imbalance' },
      { dir: absDir,        score: absScore,          label: 'Absorption' },
      { dir: momentumDir,   score: momentumScore,    label: 'Momentum' },
      { dir: trendDir,      score: trendScore,       label: 'Trend (EMA)' },
    ];

    let buyScore  = 0;
    let sellScore = 0;
    const reasons = [];
    let buyConfluences  = 0;
    let sellConfluences = 0;

    for (const v of votes) {
      if (v.dir === 'BUY')  {
        buyScore  += v.score;
        if (v.score > 5) { buyConfluences++;  reasons.push(`↑ ${v.label} (${v.score.toFixed(0)}pts)`); }
      }
      if (v.dir === 'SELL') {
        sellScore += v.score;
        if (v.score > 5) { sellConfluences++; reasons.push(`↓ ${v.label} (${v.score.toFixed(0)}pts)`); }
      }
    }

    const maxScore   = 130; // max possible aggregate (added trend bonus)
    const rawConf    = Math.max(buyScore, sellScore);
    let confidence   = Math.round((rawConf / maxScore) * 100);

    // Apply regime penalty: choppy/volatile markets → cap confidence at 50%
    if (!regimeOk) confidence = Math.min(confidence, 50);

    const dominantDir      = buyScore >= sellScore ? 'BUY' : 'SELL';
    const dominantConfluence = dominantDir === 'BUY' ? buyConfluences : sellConfluences;

    // ── Confluence gate — require ≥N components pointing same way ─────────
    if (dominantConfluence < this.cfg.minConfluence) return null;

    // ── Triple-lock — delta + cumDelta + imbalance must ALL agree ─────────
    // These are the three purest order-flow metrics. If they disagree the setup
    // is mixed and the edge evaporates.
    if (this.cfg.requireTripleLock) {
      const coreDirs = [deltaDir, cdDir, imbalanceDir];
      const coreAgree = coreDirs.every(d => d === dominantDir);
      if (!coreAgree) return null; // mixed core signal — skip
    }

    // ── Divergence filter — price vs cumDelta ─────────────────────────────
    // Price making new high but cumDelta declining = bearish divergence → suppress BUY
    // Price making new low but cumDelta rising    = bullish divergence → suppress SELL
    const lookback  = Math.min(bars.length, 10);
    const oldBar    = bars[bars.length - lookback];
    if (oldBar) {
      const priceRising  = latest.close > oldBar.close;
      const deltaRising  = (latest.cumDelta || 0) > (oldBar.cumDelta || 0);
      if (dominantDir === 'BUY'  && priceRising  && !deltaRising) return null; // bearish divergence
      if (dominantDir === 'SELL' && !priceRising && deltaRising)  return null; // bullish divergence
    }

    const signal = confidence >= this.cfg.minConfidence ? dominantDir : 'HOLD';

    // Cooldown: don't repeat same direction signal within cooldownBars
    if (signal !== 'HOLD') {
      if (idx - lastSignalIdx < this.cfg.cooldownBars) return null;
      state.lastSignalIdx = idx;
    }

    return {
      symbol:          sym,
      signal,
      confidence,
      direction:       dominantDir,
      confluences:     dominantConfluence, // how many components agreed (quality indicator)
      reasons,
      riskRewardRatio: this.cfg.riskRewardRatio,
      metrics: {
        delta:       latest.delta,
        cumDelta:    Math.round(state.cumDelta),
        imbalance:   Math.round(avgImbalance * 100) / 100,
        absorption:  recentAbsorption.length,
        momentum:    momentumDelta,
        buyScore:    Math.round(buyScore),
        sellScore:   Math.round(sellScore),
        buyConfluences,
        sellConfluences,
        ema:         Math.round(emaNew * 100) / 100,
        emaDiff:     Math.round(emaDiff * 100) / 100,
        atr:         Math.round(atr * 100) / 100,
        trend:       trendDir,
        regime,
      },
      // Last 15 bars of raw order flow tape — forwarded to Claude for full context
      recentBars: state.bars.slice(-15).map(b => ({
        t:         b.time,
        o:         b.open,  h: b.high, l: b.low, c: b.close,
        vol:       b.volume,
        askVol:    Math.round(b.askVol),
        bidVol:    Math.round(b.bidVol),
        delta:     Math.round(b.delta),
        imb:       Math.round(b.imbalance * 100) / 100,
        abs:       b.absorption ? 1 : 0,
        atr:       Math.round((b.atr || 0) * 100) / 100,
      })),
      bar:       latest,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Normalise flexible input shapes ─────────────────────────────────────

  _normalise(raw) {
    if (!raw) return null;
    const b = {};

    b.symbol  = raw.symbol || raw.sym || raw.ticker || 'UNKNOWN';
    b.time    = raw.time || raw.timestamp || raw.t || Date.now();
    b.open    = parseFloat(raw.open  || raw.o || raw.price || 0);
    b.high    = parseFloat(raw.high  || raw.h || b.open);
    b.low     = parseFloat(raw.low   || raw.l || b.open);
    b.close   = parseFloat(raw.close || raw.c || raw.last || b.open);
    b.volume  = parseFloat(raw.volume || raw.vol || raw.v || 0);

    // Order flow fields - support multiple API naming conventions
    b.askVol  = parseFloat(
      raw.askVol || raw.ask_vol || raw.buyVol || raw.buy_vol ||
      raw.upVol  || raw.aggressor_buy || (b.volume * 0.5) // fallback: 50/50 split
    );
    b.bidVol  = parseFloat(
      raw.bidVol || raw.bid_vol || raw.sellVol || raw.sell_vol ||
      raw.downVol || raw.aggressor_sell || (b.volume - b.askVol)
    );

    // Ensure volumes are sane
    if (b.askVol + b.bidVol > b.volume * 1.05) {
      // Recalculate to sum correctly
      const total = b.askVol + b.bidVol;
      b.askVol = (b.askVol / total) * b.volume;
      b.bidVol = (b.bidVol / total) * b.volume;
    }

    return b;
  }

  /**
   * Reset engine state (e.g. on new trading session)
   */
  reset(symbol) {
    if (symbol) {
      delete this.symbolState[symbol];
    } else {
      this.symbolState = {};
      this.cumDelta = 0;
      this.bars = [];
      this.barIndex = 0;
    }
  }

  /**
   * Get current metrics snapshot for a symbol
   */
  getMetrics(symbol) {
    const state = this.symbolState[symbol];
    if (!state || !state.bars.length) return null;
    const latest = state.bars[state.bars.length - 1];
    return {
      symbol,
      bars:       state.bars.length,
      cumDelta:   Math.round(state.cumDelta),
      lastDelta:  latest?.delta    || 0,
      imbalance:  latest?.imbalance || 0.5,
      absorption: latest?.absorption || false,
      ema:        latest?.ema  != null ? Math.round(latest.ema * 100) / 100 : null,
      atr:        latest?.atr  != null ? Math.round(latest.atr * 100) / 100 : null,
      regime:     latest?.atr  != null
        ? (latest.atr < (this.cfg.minAtrTicks||0) ? 'choppy'
          : latest.atr > (this.cfg.maxAtrTicks||Infinity) ? 'volatile'
          : 'normal')
        : 'unknown',
    };
  }
}

module.exports = { OrderFlowEngine, DEFAULTS };
