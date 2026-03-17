'use strict';
/**
 * routes/strategies.js
 * Golden Arc Automation — Strategy Library
 *
 * Each strategy is a pre-tuned Order Flow Engine config that users can deploy
 * as a live auto-trader bot in one click.
 *
 * GET  /strategies          – list all strategy templates
 * POST /strategies/deploy   – deploy a strategy as a new auto-trader bot
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const svc    = require('../services/autoTraderService');

// ── Strategy definitions ─────────────────────────────────────────────────────

const STRATEGIES = [

  // ── TOP TICK EXHAUSTION  (available on all brokers) ───────────────────────
  {
    id:          'top-tick-exhaustion',
    name:        'Top Tick Exhaustion',
    tagline:     'Counter-trend fades at price extremes via delta divergence',
    description: 'Detects exhaustion at N-bar highs and lows. Fires a SELL when price makes a new high but cumulative delta is declining (smart money absorbing). Fires a BUY when price makes a new low but cumulative delta is rising. Uses the Top Tick Exhaustion engine — pure counter-trend with strict divergence and volume climax filters.',
    badge:       'TopTick',
    badgeColor:  'orange',
    brokers:     ['topstepx', 'bitunix', 'lucid'],
    defaultSymbols: { topstepx: 'NQ', bitunix: 'BTCUSDT', lucid: 'EURUSD' },
    riskLevel:   'Medium',
    style:       'Mean Reversion',
    timeframe:   '5–15 min bars',
    params: {
      strategyType:        'toptick',
      ttLookbackBars:      10,
      ttDivLookback:       5,
      ttMinDivMagnitude:   50,
      ttExhaustionRatio:   0.55,
      ttVolumeClimaxRatio: 1.5,
      minConfidence:       65,
      cooldownBars:        4,
      atrPeriod:           14,
      minAtrTicks:         5,
      maxAtrTicks:         100,
      absorptionMinVol:    1200,
      riskRewardRatio:     2.5,
      slTicks:             10,
      tpTicks:             25,
      claudeEnabled:       false,
      maxDailyLoss:        500,
      maxDailyTrades:      6,
      maxConsecLosses:     2,
      minConfluenceGate:   2,
    },
  },

  // ── THE GOLDEN ARC AI  (available on all brokers) ────────────────────────
  {
    id:          'golden-arc-ai',
    name:        'The Golden Arc AI',
    tagline:     'Trend-following with Golden Arc AI signal validation',
    description: 'The flagship Golden Arc strategy. Pairs high-confidence Order Flow Engine signals with Golden Arc AI second-opinion validation. Only fires when trend alignment is strong and AI confirms the setup — filtering out low-quality signals automatically.',
    badge:       'Flagship',
    badgeColor:  'purple',
    brokers:     ['topstepx', 'bitunix', 'lucid'],
    defaultSymbols: { topstepx: 'NQ', bitunix: 'BTCUSDT', lucid: 'EURUSD' },
    riskLevel:   'Medium',
    style:       'Trend Following',
    timeframe:   '5–15 min bars',
    params: {
      strategyType:       'orderflow',
      windowSize:         20,
      deltaThreshold:     300,
      imbalanceThreshold: 0.65,
      absorptionMinVol:   1200,
      momentumPeriod:     5,
      minConfidence:      70,
      cooldownBars:       4,
      trendPeriod:        14,
      atrPeriod:          14,
      minAtrTicks:        5,
      maxAtrTicks:        80,
      riskRewardRatio:    2.5,
      slTicks:            10,
      tpTicks:            25,
      claudeEnabled:      true,
      maxDailyLoss:       500,
      maxDailyTrades:     6,
      maxConsecLosses:    2,
    },
  },

  // ── TOPSTEP STRATEGIES ────────────────────────────────────────────────────

  {
    id:          'nq-scalper',
    name:        'NQ Scalper',
    tagline:     'Fast delta-imbalance scalping on Nasdaq futures',
    description: 'Targets rapid intraday moves on NQ using tight delta thresholds and short window analysis. High frequency, small targets, strict ATR regime filter avoids choppy sessions.',
    badge:       'Scalp',
    badgeColor:  'cyan',
    brokers:     ['topstepx'],
    defaultSymbols: { topstepx: 'NQ' },
    riskLevel:   'High',
    style:       'Scalping',
    timeframe:   '1–3 min bars',
    params: {
      strategyType:       'orderflow',
      windowSize:         10,
      deltaThreshold:     150,
      imbalanceThreshold: 0.68,
      absorptionMinVol:   800,
      momentumPeriod:     3,
      minConfidence:      60,
      cooldownBars:       2,
      trendPeriod:        8,
      atrPeriod:          8,
      minAtrTicks:        4,
      maxAtrTicks:        60,
      riskRewardRatio:    2.0,
      slTicks:            8,
      tpTicks:            16,
      claudeEnabled:      false,
      maxDailyLoss:       400,
      maxDailyTrades:     15,
      maxConsecLosses:    3,
    },
  },

  {
    id:          'es-swing',
    name:        'ES Swing Trader',
    tagline:     'Wide-stop swing trades on S&P 500 futures',
    description: 'Patient swing strategy on ES using large window analysis and strong absorption filters. Waits for high-conviction setups with 3:1 risk/reward. Fewer trades, larger targets — ideal for evaluation accounts.',
    badge:       'Swing',
    badgeColor:  'gold',
    brokers:     ['topstepx'],
    defaultSymbols: { topstepx: 'ES' },
    riskLevel:   'Low',
    style:       'Swing Trading',
    timeframe:   '15–30 min bars',
    params: {
      strategyType:       'orderflow',
      windowSize:         30,
      deltaThreshold:     400,
      imbalanceThreshold: 0.60,
      absorptionMinVol:   2000,
      momentumPeriod:     8,
      minConfidence:      65,
      cooldownBars:       6,
      trendPeriod:        20,
      atrPeriod:          14,
      minAtrTicks:        6,
      maxAtrTicks:        100,
      riskRewardRatio:    3.0,
      slTicks:            12,
      tpTicks:            36,
      claudeEnabled:      false,
      maxDailyLoss:       300,
      maxDailyTrades:     5,
      maxConsecLosses:    2,
    },
  },

  {
    id:          'mnq-micro-momentum',
    name:        'MNQ Micro Momentum',
    tagline:     'Micro-contract momentum on Micro Nasdaq',
    description: 'Built for traders building consistency with micro contracts. Balanced parameters with strict daily loss protection. Excellent for funded evaluation accounts seeking consistent small gains.',
    badge:       'Micro',
    badgeColor:  'green',
    brokers:     ['topstepx'],
    defaultSymbols: { topstepx: 'MNQ' },
    riskLevel:   'Low',
    style:       'Momentum',
    timeframe:   '5 min bars',
    params: {
      strategyType:       'orderflow',
      windowSize:         15,
      deltaThreshold:     100,
      imbalanceThreshold: 0.63,
      absorptionMinVol:   500,
      momentumPeriod:     4,
      minConfidence:      62,
      cooldownBars:       3,
      trendPeriod:        10,
      atrPeriod:          10,
      minAtrTicks:        3,
      maxAtrTicks:        50,
      riskRewardRatio:    2.0,
      slTicks:            6,
      tpTicks:            12,
      claudeEnabled:      false,
      maxDailyLoss:       200,
      maxDailyTrades:     8,
      maxConsecLosses:    3,
    },
  },

  // ── BITUNIX STRATEGIES ────────────────────────────────────────────────────

  {
    id:          'btc-momentum',
    name:        'BTC Momentum',
    tagline:     'Crypto momentum following on Bitcoin perpetuals',
    description: 'Tracks large delta imbalances in BTC-USDT perpetuals. Crypto-tuned parameters with wider ATR tolerance for high-volatility sessions. Performs best in clear trend conditions.',
    badge:       'Crypto',
    badgeColor:  'orange',
    brokers:     ['bitunix'],
    defaultSymbols: { bitunix: 'BTCUSDT' },
    riskLevel:   'High',
    style:       'Momentum',
    timeframe:   '5–15 min bars',
    params: {
      strategyType:       'orderflow',
      windowSize:         15,
      deltaThreshold:     500,
      imbalanceThreshold: 0.63,
      absorptionMinVol:   5000,
      momentumPeriod:     5,
      minConfidence:      62,
      cooldownBars:       3,
      trendPeriod:        12,
      atrPeriod:          10,
      minAtrTicks:        10,
      maxAtrTicks:        200,
      riskRewardRatio:    2.0,
      slTicks:            15,
      tpTicks:            30,
      claudeEnabled:      false,
      maxDailyLoss:       1000,
      maxDailyTrades:     8,
      maxConsecLosses:    3,
    },
  },

  {
    id:          'eth-mean-reversion',
    name:        'ETH Mean Reversion',
    tagline:     'Counter-trend exhaustion fades on Ethereum perpetuals',
    description: 'Identifies exhaustion moves in ETH using the Top Tick Exhaustion engine — fires when price reaches a new N-bar high/low but cumulative delta diverges (smart money absorbing). Fades overextended moves with disciplined 2.5:1 R/R. High selectivity through delta divergence + volume climax confirmation.',
    badge:       'Rev',
    badgeColor:  'purple',
    brokers:     ['bitunix'],
    defaultSymbols: { bitunix: 'ETHUSDT' },
    riskLevel:   'Medium',
    style:       'Mean Reversion',
    timeframe:   '15 min bars',
    params: {
      strategyType:        'toptick',
      // Top Tick Exhaustion params
      ttLookbackBars:      12,   // N-bar high/low window (wider on ETH for swing extremes)
      ttDivLookback:       6,    // bars to measure cumDelta divergence
      ttMinDivMagnitude:   80,   // higher threshold (ETH has larger native delta values)
      ttExhaustionRatio:   0.60, // delta must shrink to 60% of avg to confirm fade
      ttVolumeClimaxRatio: 1.6,  // vol spike ≥ 1.6× rolling avg = climax confirmation
      // Shared params
      minConfidence:       68,
      cooldownBars:        5,
      atrPeriod:           14,
      minAtrTicks:         8,
      maxAtrTicks:         150,
      absorptionMinVol:    3000,
      riskRewardRatio:     2.5,
      slTicks:             12,
      tpTicks:             30,
      claudeEnabled:       false,
      maxDailyLoss:        800,
      maxDailyTrades:      6,
      maxConsecLosses:     2,
      minConfluenceGate:   2,    // TT engine has fewer components
    },
  },

  {
    id:          'sol-breakout',
    name:        'SOL Breakout Hunter',
    tagline:     'Fast breakout detection on Solana perpetuals',
    description: 'Aggressive breakout strategy capturing SOL momentum spikes. Tight detection window and high imbalance threshold catch explosive moves early. Strict circuit-breaker limits damage on bad sessions.',
    badge:       'Break',
    badgeColor:  'cyan',
    brokers:     ['bitunix'],
    defaultSymbols: { bitunix: 'SOLUSDT' },
    riskLevel:   'High',
    style:       'Breakout',
    timeframe:   '3–5 min bars',
    params: {
      strategyType:       'orderflow',
      windowSize:         10,
      deltaThreshold:     200,
      imbalanceThreshold: 0.70,
      absorptionMinVol:   2000,
      momentumPeriod:     4,
      minConfidence:      65,
      cooldownBars:       2,
      trendPeriod:        8,
      atrPeriod:          8,
      minAtrTicks:        15,
      maxAtrTicks:        300,
      riskRewardRatio:    2.0,
      slTicks:            20,
      tpTicks:            40,
      claudeEnabled:      false,
      maxDailyLoss:       600,
      maxDailyTrades:     10,
      maxConsecLosses:    2,
    },
  },

  // ── LUCID STRATEGIES ──────────────────────────────────────────────────────

  {
    id:          'lucid-flow',
    name:        'Lucid Flow',
    tagline:     'Balanced order flow strategy for Lucid Markets',
    description: 'All-around order flow strategy tuned for Lucid Markets instruments. Conservative parameters with solid risk management. Suitable for a wide range of instruments including forex and indices.',
    badge:       'Flow',
    badgeColor:  'green',
    brokers:     ['lucid'],
    defaultSymbols: { lucid: 'EURUSD' },
    riskLevel:   'Low',
    style:       'Order Flow',
    timeframe:   '5–15 min bars',
    params: {
      strategyType:       'orderflow',
      windowSize:         20,
      deltaThreshold:     250,
      imbalanceThreshold: 0.62,
      absorptionMinVol:   1000,
      momentumPeriod:     5,
      minConfidence:      60,
      cooldownBars:       3,
      trendPeriod:        10,
      atrPeriod:          10,
      minAtrTicks:        3,
      maxAtrTicks:        120,
      riskRewardRatio:    2.0,
      slTicks:            12,
      tpTicks:            24,
      claudeEnabled:      false,
      maxDailyLoss:       500,
      maxDailyTrades:     10,
      maxConsecLosses:    3,
    },
  },

  {
    id:          'lucid-trend-rider',
    name:        'Lucid Trend Rider',
    tagline:     'Strong trend capture on Lucid forex & indices',
    description: 'Patient trend-following for Lucid Markets. Waits for clear EMA alignment and strong cumulative delta confirmation before entering. Extended cooldown prevents overtrading in choppy conditions.',
    badge:       'Trend',
    badgeColor:  'gold',
    brokers:     ['lucid'],
    defaultSymbols: { lucid: 'GBPUSD' },
    riskLevel:   'Medium',
    style:       'Trend Following',
    timeframe:   '15–30 min bars',
    params: {
      strategyType:       'orderflow',
      windowSize:         25,
      deltaThreshold:     350,
      imbalanceThreshold: 0.63,
      absorptionMinVol:   1500,
      momentumPeriod:     6,
      minConfidence:      65,
      cooldownBars:       5,
      trendPeriod:        15,
      atrPeriod:          14,
      minAtrTicks:        4,
      maxAtrTicks:        100,
      riskRewardRatio:    2.5,
      slTicks:            14,
      tpTicks:            35,
      claudeEnabled:      false,
      maxDailyLoss:       450,
      maxDailyTrades:     7,
      maxConsecLosses:    2,
    },
  },
];

// ── Routes ────────────────────────────────────────────────────────────────────

router.use(auth);

router.get('/', (req, res) => {
  res.json({ strategies: STRATEGIES });
});

router.post('/deploy', async (req, res) => {
  const { strategyId, broker, symbol, accountId, botName, simulationMode } = req.body;

  if (!strategyId || typeof strategyId !== 'string') {
    return res.status(400).json({ error: 'strategyId is required' });
  }

  const strategy = STRATEGIES.find(s => s.id === strategyId);
  if (!strategy) return res.status(404).json({ error: 'Strategy not found' });

  if (!broker || !strategy.brokers.includes(broker)) {
    return res.status(400).json({ error: `Strategy "${strategy.name}" does not support broker "${broker}"` });
  }

  try {
    const bot = svc.saveBot(req.user.id, {
      name:           botName  || `${strategy.name} — ${symbol || strategy.defaultSymbols[broker]}`,
      symbol:         (symbol  || strategy.defaultSymbols[broker] || '').toUpperCase().trim(),
      broker,
      accountId:      accountId || null,
      simulationMode: simulationMode ?? true,
      strategyId:     strategy.id,
      strategyName:   strategy.name,
      ...strategy.params,
      tpOverride:     true, // preserve exact tpTicks from the strategy
    });
    res.status(201).json({ bot, strategy: { id: strategy.id, name: strategy.name } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
