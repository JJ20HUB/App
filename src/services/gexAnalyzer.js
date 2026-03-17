'use strict';
/**
 * gexAnalyzer.js
 *
 * GEX-Powered Key Level Analyzer  (Functional Gamma Exposure via Order Flow)
 * ───────────────────────────────────────────────────────────────────────────
 * True GEX (Gamma Exposure) comes from options chains.  Since TopStep/Tradovate
 * gives us raw futures order flow rather than options data, this service builds
 * *functional* GEX levels from the actual tape — levels that behave the same
 * way: price is magnetically attracted (pin) or violently repelled (flip).
 *
 * Five components mapped to GEX behavior:
 *
 *  1. Volume Profile  →  POC / VAH / VAL + High/Low Volume Nodes
 *     Classic GEX pins align with high-volume nodes; air pockets at LVNs
 *     cause fast moves through (same as a GEX "flip zone").
 *
 *  2. Delta Cluster Reversals
 *     Zones where cumulative delta sharply reversed — equivalent to where
 *     option market-makers had to flip their hedges en masse.
 *
 *  3. Absorption Zones
 *     High volume + tiny price movement = institutional willingness to defend
 *     a level.  Same structural significance as large open interest strikes.
 *
 *  4. VWAP + Standard Deviation Bands
 *     VWAP acts as the daily "gamma gravity" line.  ±1σ / ±2σ bands are
 *     where dealers typically start/stop hedging flow.
 *
 *  5. Range Extremes  (session high/low)
 *     Known anchors for stop clusters and breakout acceleration zones.
 *
 * Output shape:
 * {
 *   poc, vah, val,
 *   vwap, vwapSD1H, vwapSD1L, vwapSD2H, vwapSD2L,
 *   hvNodes: [{ price, volume, type:'HVN' }],
 *   lvNodes: [{ price, volume, type:'LVN' }],
 *   deltaReversals: [{ price, delta, direction:'flip_buy'|'flip_sell' }],
 *   absorptionZones: [{ price, volume, direction: 'buy'|'sell' }],
 *   keyLevels: [{ price, type, strength, label }],  // merged, ranked list
 *   sessionHigh, sessionLow,
 *   tickSize, bucketSize,
 * }
 */

const logger = require('../utils/logger');

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  tickSize:          0.25,   // MES/ES  (NQ/MNQ = 0.25 as well; YM = 1)
  bucketMultiplier:  4,      // bucketSize = tickSize × multiplier  (1 pt for ES/NQ)
  valueAreaPct:      0.70,   // 70% of volume = Value Area
  hvnThresholdPct:   1.30,   // above 130% of mean volume per bucket = HVN
  lvnThresholdPct:   0.50,   // below 50% of mean volume per bucket = LVN
  absorptionMinVol:  800,    // min bar volume to qualify as absorption
  absorptionMaxMove: 2,      // max ticks price moved to call it absorption
  minBarsForGex:     30,     // minimum bars needed to produce reliable levels
  maxGexLevels:      8,      // max key levels returned to AI
};

// ─── Helper: round price to nearest bucket ────────────────────────────────────

function roundToBucket(price, bucketSize) {
  return Math.round(price / bucketSize) * bucketSize;
}

// ─── Volume Profile ───────────────────────────────────────────────────────────

function buildVolumeProfile(bars, bucketSize) {
  const profile = new Map(); // price → total volume
  for (const b of bars) {
    const lo = Math.min(b.open, b.close, b.low  || b.close);
    const hi = Math.max(b.open, b.close, b.high || b.close);
    // Distribute bar volume proportionally across price range
    let level = roundToBucket(lo, bucketSize);
    const steps = Math.max(1, Math.round((hi - lo) / bucketSize));
    const volPerStep = (b.volume || 0) / steps;
    for (let i = 0; i <= steps; i++) {
      const key = roundToBucket(level, bucketSize);
      profile.set(key, (profile.get(key) || 0) + volPerStep);
      level += bucketSize;
    }
  }
  return profile;
}

function computeVolumeStats(profile) {
  let poc    = 0;
  let maxVol = 0;
  let totalVol = 0;
  const sorted = [...profile.entries()].sort((a, b) => a[0] - b[0]);

  for (const [price, vol] of sorted) {
    totalVol += vol;
    if (vol > maxVol) { maxVol = vol; poc = price; }
  }

  // Value Area: expand outward from POC until 70% of volume captured
  const target = totalVol * DEFAULTS.valueAreaPct;
  let vahIdx = sorted.findIndex(e => e[0] === poc);
  let valIdx = vahIdx;
  let accumulated = sorted[vahIdx]?.[1] || 0;

  while (accumulated < target && (vahIdx < sorted.length - 1 || valIdx > 0)) {
    const upVol   = vahIdx < sorted.length - 1 ? (sorted[vahIdx + 1]?.[1] || 0) : 0;
    const downVol = valIdx > 0                  ? (sorted[valIdx - 1]?.[1] || 0) : 0;
    if (upVol >= downVol && vahIdx < sorted.length - 1) {
      vahIdx++;
      accumulated += upVol;
    } else if (valIdx > 0) {
      valIdx--;
      accumulated += downVol;
    } else {
      vahIdx++;
      accumulated += upVol;
    }
  }

  const vah = sorted[vahIdx]?.[0] || poc;
  const val = sorted[valIdx]?.[0] || poc;

  // Mean volume per bucket for HVN/LVN classification
  const meanVol = totalVol / sorted.length;

  const hvNodes = [];
  const lvNodes = [];
  for (const [price, vol] of sorted) {
    if (vol > meanVol * DEFAULTS.hvnThresholdPct) {
      hvNodes.push({ price, volume: Math.round(vol), type: 'HVN' });
    } else if (vol < meanVol * DEFAULTS.lvnThresholdPct && vol > 0) {
      lvNodes.push({ price, volume: Math.round(vol), type: 'LVN' });
    }
  }

  return { poc, vah, val, hvNodes, lvNodes, totalVol, meanVol };
}

// ─── VWAP + St. Dev. Bands ────────────────────────────────────────────────────

function computeVWAP(bars) {
  let cumVolume  = 0;
  let cumTPV     = 0;  // typical price × volume
  const tpList   = [];

  for (const b of bars) {
    const vol = b.volume || 0;
    const tp  = ((b.high || b.close) + (b.low || b.close) + (b.close)) / 3;
    cumTPV   += tp * vol;
    cumVolume += vol;
    tpList.push({ tp, vol });
  }

  const vwap = cumVolume > 0 ? cumTPV / cumVolume : 0;

  // Standard deviation bands
  let sumSqDev = 0;
  for (const { tp, vol } of tpList) {
    sumSqDev += vol * Math.pow(tp - vwap, 2);
  }
  const sd = cumVolume > 0 ? Math.sqrt(sumSqDev / cumVolume) : 0;

  return {
    vwap:      Math.round(vwap * 100) / 100,
    vwapSD1H:  Math.round((vwap + sd) * 100) / 100,
    vwapSD1L:  Math.round((vwap - sd) * 100) / 100,
    vwapSD2H:  Math.round((vwap + 2 * sd) * 100) / 100,
    vwapSD2L:  Math.round((vwap - 2 * sd) * 100) / 100,
    sd:        Math.round(sd * 100) / 100,
  };
}

// ─── Delta Reversal Clusters ──────────────────────────────────────────────────

function findDeltaReversals(bars) {
  const reversals = [];
  if (bars.length < 3) return reversals;

  let runningDelta = 0;
  const deltas = bars.map(b => {
    const d = (b.delta != null) ? b.delta : ((b.askVol || 0) - (b.bidVol || 0));
    runningDelta += d;
    return { price: b.close, delta: d, cumDelta: runningDelta };
  });

  for (let i = 2; i < deltas.length; i++) {
    const prev2 = deltas[i - 2];
    const prev  = deltas[i - 1];
    const curr  = deltas[i];

    const prevTrend = prev.cumDelta   - prev2.cumDelta;
    const currTrend = curr.cumDelta   - prev.cumDelta;

    // A reversal is where cumulative delta slope flips sign
    if (prevTrend > 0 && currTrend < 0 && Math.abs(prevTrend) > 30) {
      reversals.push({
        price:     Math.round(curr.price * 100) / 100,
        delta:     Math.round(prev.cumDelta),
        direction: 'flip_sell',  // was buying, now selling
        barIndex:  i,
      });
    } else if (prevTrend < 0 && currTrend > 0 && Math.abs(prevTrend) > 30) {
      reversals.push({
        price:     Math.round(curr.price * 100) / 100,
        delta:     Math.round(prev.cumDelta),
        direction: 'flip_buy',   // was selling, now buying
        barIndex:  i,
      });
    }
  }

  // De-duplicate by price proximity (cluster within 2 pts)
  const deduped = [];
  for (const r of reversals) {
    const near = deduped.find(d => Math.abs(d.price - r.price) < 2);
    if (!near) deduped.push(r);
  }
  return deduped.slice(-10); // keep most recent 10
}

// ─── Absorption Zones ─────────────────────────────────────────────────────────

function findAbsorptionZones(bars, bucketSize) {
  const zones = [];
  for (const b of bars) {
    const vol       = b.volume || 0;
    const priceMove = Math.abs((b.close || 0) - (b.open || 0));
    const tickMove  = priceMove / bucketSize;

    if (vol >= DEFAULTS.absorptionMinVol && tickMove <= DEFAULTS.absorptionMaxMove) {
      const delta = (b.delta != null) ? b.delta : ((b.askVol || 0) - (b.bidVol || 0));
      zones.push({
        price:     roundToBucket(b.close, bucketSize),
        volume:    vol,
        direction: delta > 0 ? 'sell'  // sellers absorbed into buy aggression = sell-side absorption
                             : 'buy',  // buyers absorbed into sell aggression = buy-side absorption
        rawDelta:  Math.round(delta),
      });
    }
  }

  // De-dup by price proximity
  const deduped = [];
  for (const z of zones) {
    const near = deduped.find(d => Math.abs(d.price - z.price) <= bucketSize * 2);
    if (near) {
      if (z.volume > near.volume) Object.assign(near, z);
    } else {
      deduped.push({ ...z });
    }
  }
  return deduped;
}

// ─── Merge & Rank Key Levels ──────────────────────────────────────────────────
/**
 * Combines all detected levels into a single ranked list, sorted by strength.
 * Levels within `conflationDistance` of each other are merged.
 */
function buildKeyLevels({
  poc, vah, val, vwap, vwapSD1H, vwapSD1L, vwapSD2H, vwapSD2L,
  hvNodes, lvNodes, deltaReversals, absorptionZones,
  sessionHigh, sessionLow, bucketSize,
}) {
  const raw = [];
  const conflate = bucketSize * 3; // merge levels within 3 buckets

  const add = (price, type, strength, label, extra = {}) => {
    if (price == null || isNaN(price)) return;
    raw.push({ price: Math.round(price * 100) / 100, type, strength, label, ...extra });
  };

  // ── Anchor levels (highest structural significance) ──
  add(poc,      'POC',     10, 'Point of Control');
  add(vah,      'VAH',      9, 'Value Area High');
  add(val,      'VAL',      9, 'Value Area Low');
  add(vwap,     'VWAP',     8, 'VWAP');
  add(vwapSD1H, 'VWAP+1σ', 7, 'VWAP +1 Std Dev');
  add(vwapSD1L, 'VWAP-1σ', 7, 'VWAP -1 Std Dev');
  add(vwapSD2H, 'VWAP+2σ', 6, 'VWAP +2 Std Dev');
  add(vwapSD2L, 'VWAP-2σ', 6, 'VWAP -2 Std Dev');
  add(sessionHigh, 'SSH',  8, 'Session High');
  add(sessionLow,  'SSL',  8, 'Session Low');

  // ── Structure from order flow ──
  for (const n of hvNodes)  add(n.price, 'HVN', 7, `High-Vol Node (${n.volume.toLocaleString()})`, { volume: n.volume });
  for (const n of lvNodes)  add(n.price, 'LVN', 4, `Low-Vol Node (fast-move zone)`,                { volume: n.volume });
  for (const r of deltaReversals) {
    add(r.price, r.direction === 'flip_buy' ? 'DELTA_FLIP_BUY' : 'DELTA_FLIP_SELL', 8,
      `Delta Flip (${r.direction === 'flip_buy' ? '↑ Buy Reversal' : '↓ Sell Reversal'})`,
      { delta: r.delta });
  }
  for (const z of absorptionZones) {
    add(z.price, `ABSORPTION_${z.direction.toUpperCase()}`, 9,
      `Absorption Zone — ${z.direction}-side (${z.volume.toLocaleString()} vol)`,
      { volume: z.volume, direction: z.direction });
  }

  // ── Merge nearby levels ──────────────────────────────────────────────────
  const merged = [];
  const usedIdx = new Set();

  const sorted = raw.sort((a, b) => b.strength - a.strength); // process strongest first
  for (let i = 0; i < sorted.length; i++) {
    if (usedIdx.has(i)) continue;
    const base = { ...sorted[i] };
    const coLabels = [base.label];
    for (let j = i + 1; j < sorted.length; j++) {
      if (!usedIdx.has(j) && Math.abs(sorted[j].price - base.price) <= conflate) {
        base.strength += sorted[j].strength * 0.5; // bonus for confluent levels
        coLabels.push(sorted[j].label);
        usedIdx.add(j);
      }
    }
    base.label = coLabels.join(' + ');
    base.confluences = coLabels.length;
    merged.push(base);
  }

  return merged
    .sort((a, b) => b.strength - a.strength)
    .slice(0, DEFAULTS.maxGexLevels);
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * computeGEXLevels(bars, opts)
 *
 * @param {Array}  bars  – Array of normalised OHLCV bars, as output by
 *                         OrderFlowEngine._normalise() or TradovateMarketFeed.
 *                         Required fields per bar:
 *                           open, high, low, close, volume
 *                         Optional (improves quality):
 *                           askVol, bidVol, delta
 * @param {object} opts  – Override defaults (tickSize, bucketMultiplier, …)
 * @returns {object}     – GEX level set (see module header for shape)
 */
function computeGEXLevels(bars, opts = {}) {
  if (!bars || bars.length < DEFAULTS.minBarsForGex) {
    logger.debug(`[gexAnalyzer] Not enough bars (${bars?.length || 0}/${DEFAULTS.minBarsForGex}) — returning empty`);
    return null;
  }

  const cfg = { ...DEFAULTS, ...opts };
  const bucketSize = cfg.tickSize * cfg.bucketMultiplier;

  // Session extremes
  let sessionHigh = -Infinity;
  let sessionLow  = Infinity;
  for (const b of bars) {
    if ((b.high  || b.close) > sessionHigh) sessionHigh = b.high  || b.close;
    if ((b.low   || b.close) < sessionLow)  sessionLow  = b.low   || b.close;
  }

  // Volume Profile
  const profile = buildVolumeProfile(bars, bucketSize);
  const volStats = computeVolumeStats(profile);

  // VWAP
  const vwapStats = computeVWAP(bars);

  // Delta reversals
  const deltaReversals = findDeltaReversals(bars);

  // Absorption zones
  const absorptionZones = findAbsorptionZones(bars, bucketSize);

  // Merge into key levels
  const keyLevels = buildKeyLevels({
    ...volStats,
    ...vwapStats,
    deltaReversals,
    absorptionZones,
    sessionHigh,
    sessionLow,
    bucketSize,
  });

  const result = {
    // Core profile levels
    poc:         volStats.poc,
    vah:         volStats.vah,
    val:         volStats.val,
    // VWAP bands
    ...vwapStats,
    // Raw components
    hvNodes:         volStats.hvNodes,
    lvNodes:         volStats.lvNodes,
    deltaReversals,
    absorptionZones,
    // The ranked key levels list for AI consumption
    keyLevels,
    // Session data
    sessionHigh:  Math.round(sessionHigh * 100) / 100,
    sessionLow:   Math.round(sessionLow  * 100) / 100,
    // Meta
    barCount:    bars.length,
    tickSize:    cfg.tickSize,
    bucketSize,
    computedAt:  new Date().toISOString(),
  };

  logger.info(
    `[gexAnalyzer] Computed ${keyLevels.length} key levels for ${bars.length} bars — ` +
    `POC:${result.poc} VAH:${result.vah} VAL:${result.val} VWAP:${result.vwap}`
  );

  return result;
}

/**
 * isNearLevel(price, level, toleranceTicks, tickSize)
 * Returns true when `price` is within toleranceTicks of a key level.
 * Used by the bot loop to trigger GEX analysis when approaching a level.
 */
function isNearLevel(price, level, toleranceTicks = 4, tickSize = 0.25) {
  return Math.abs(price - level) <= toleranceTicks * tickSize;
}

/**
 * getNearbyLevels(price, keyLevels, toleranceTicks, tickSize)
 * Returns all key levels within `toleranceTicks` ticks of current price.
 */
function getNearbyLevels(price, keyLevels = [], toleranceTicks = 6, tickSize = 0.25) {
  return keyLevels.filter(l => isNearLevel(price, l.price, toleranceTicks, tickSize));
}

module.exports = { computeGEXLevels, isNearLevel, getNearbyLevels, computeVWAP };
