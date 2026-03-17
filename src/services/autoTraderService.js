'use strict';
/**
 * autoTraderService.js  (v2 — 2:1 TP/SL enforcement + P&L tracking)
 *
 * Manages running Order Flow Auto-Trader instances.
 * Each "bot" has a config (symbol, account, engine params, risk rules),
 * receives market data via HTTP or a simulated feed, runs it through the
 * OrderFlowEngine, and places real orders via the existing broker adapters.
 *
 * Key upgrades in v2:
 *   • riskRewardRatio field (default 2.0 → TP = SL × 2)
 *   • tpTicks auto-derived: if user sets slTicks only, tpTicks = slTicks × rr
 *   • Per-bot live stats: signals, trades, wins, losses, winRate%, estimatedPnl
 *   • Session P&L estimate: +tpTicks pts on win, -slTicks pts on loss
 *   • Trend / ATR engine params forwarded
 *   • Max consecutive loss circuit-breaker (maxConsecLosses)
 */

const { v4: uuidv4 } = require('uuid');
const { OrderFlowEngine }               = require('./orderFlowEngine');
const { TopTickEngine }                 = require('./topTickEngine');
const { TradovateMarketFeed }           = require('./tradovateMarketFeed');
const { TopStepXMarketFeed }            = require('./topstepxMarketFeed');
const { TopStepXRealtimeFeed }          = require('./topstepxRealtimeFeed');
const { executeOrder }                  = require('../brokers');
const { getHistoricalBars, getContracts } = require('../brokers/topstepx');
const { computeGEXLevels, getNearbyLevels } = require('./gexAnalyzer');
const claudeAI                          = require('./claudeAI');
const db                                = require('../models/db');
const logger                            = require('../utils/logger');
const config                            = require('../config');

// Detects unconfigured placeholder values in .env
function _isPlaceholder(val) {
  if (!val) return true;
  return /^your_/i.test(val) || val === '' || val === 'undefined';
}

// In-memory map: botId → { engine, config, intervalId, status, stats }
const runners = new Map();

// ─── Bot management ──────────────────────────────────────────────────────────

/**
 * Create or update a bot config in the DB.
 */
function saveBot(userId, data) {
  // ── Enforce 2:1 TP/SL ────────────────────────────────────────────────────
  const rr       = parseFloat(data.riskRewardRatio ?? 2.0) || 2.0;
  const slTicks  = parseInt(data.slTicks   ?? 12, 10);
  // Auto-derive tpTicks unless explicitly overridden
  const tpTicks  = data.tpOverride && parseInt(data.tpTicks, 10) > 0
    ? parseInt(data.tpTicks, 10)
    : Math.round(slTicks * rr);

  const existing = db.get('autotrader_bots').find({ id: data.id }).value();
  if (existing) {
    db.get('autotrader_bots').find({ id: data.id }).assign({
      ...data, userId, riskRewardRatio: rr, slTicks, tpTicks, updatedAt: new Date().toISOString()
    }).write();
    return db.get('autotrader_bots').find({ id: data.id }).value();
  }
  const bot = {
    id:          uuidv4(),
    userId,
    name:        data.name        || 'My Bot',
    symbol:      data.symbol      || 'NQ',
    accountId:   data.accountId   || null,
    broker:      data.broker      || 'topstepx',
    qty:         data.qty         ?? 1,
    status:      'stopped',
    // Engine params
    windowSize:          data.windowSize          ?? 20,
    deltaThreshold:      data.deltaThreshold       ?? 250,
    imbalanceThreshold:  data.imbalanceThreshold   ?? 0.62,
    absorptionMinVol:    data.absorptionMinVol      ?? 1000,
    momentumPeriod:      data.momentumPeriod        ?? 5,
    minConfidence:       data.minConfidence         ?? 60,
    cooldownBars:        data.cooldownBars          ?? 3,
    // Trend + ATR regime
    trendPeriod:         data.trendPeriod           ?? 10,
    atrPeriod:           data.atrPeriod             ?? 10,
    minAtrTicks:         data.minAtrTicks           ?? 3,
    maxAtrTicks:         data.maxAtrTicks           ?? 120,
    // Risk / reward (enforced 2:1 by default)
    riskRewardRatio:     rr,
    slTicks,
    tpTicks,
    maxDailyLoss:        data.maxDailyLoss          ?? 500,
    maxDailyTrades:      data.maxDailyTrades        ?? 10,
    maxConsecLosses:     data.maxConsecLosses        ?? 3,  // circuit-breaker
    // ── Win-rate / drawdown protection ───────────────────────────────────
    minConfluenceGate:       data.minConfluenceGate       ?? 4,    // require ≥4 OF components agreeing
    winRateCheckMinTrades:   data.winRateCheckMinTrades   ?? 10,   // check win rate after N live trades
    minWinRate:              data.minWinRate              ?? 0.40, // pause if win rate drops below 40%
    maxSessionDrawdownTicks: data.maxSessionDrawdownTicks ?? null, // null = auto (5 × SL)
    // ── Session time filter ───────────────────────────────────────────────
    sessionFilter:       data.sessionFilter         ?? true,    // RTH-only by default
    tradingWindowStart:  data.tradingWindowStart     ?? '08:45', // CT 24h
    tradingWindowEnd:    data.tradingWindowEnd       ?? '14:45', // CT 24h
    // ── Claude AI ─────────────────────────────────────────────────────────
    claudeEnabled:       data.claudeEnabled         ?? false, // opt-in per bot
    // ── GEX / Key Level AI Trading ────────────────────────────────────────
    gexEnabled:          data.gexEnabled            ?? true,  // GEX driven trades enabled by default
    gexProximityTicks:   data.gexProximityTicks      ?? 6,    // ticks from key level to trigger analysis
    gexCooldownBars:     data.gexCooldownBars        ?? 10,   // min bars between GEX analyses
    gexMinConfidence:    data.gexMinConfidence        ?? 70,   // min Claude confidence to execute GEX trade
    gexRefreshBars:      data.gexRefreshBars          ?? 60,   // bars between GEX level recomputation
    // ── Strategy type ─────────────────────────────────────────────────────
    // 'orderflow' (default) = multi-factor vote engine
    // 'toptick'             = Top Tick Exhaustion (delta divergence at extremes)
    strategyType:        data.strategyType          || 'orderflow',
    // ── Top Tick Exhaustion params (only used when strategyType='toptick') ─
    ttLookbackBars:      data.ttLookbackBars        ?? 10,   // N-bar high/low window
    ttDivLookback:       data.ttDivLookback         ?? 5,    // bars to measure cumDelta shift
    ttMinDivMagnitude:   data.ttMinDivMagnitude     ?? 50,   // min cumDelta shift to confirm divergence
    ttExhaustionRatio:   data.ttExhaustionRatio     ?? 0.65, // delta shrink ratio for exhaustion gate
    ttVolumeClimaxRatio: data.ttVolumeClimaxRatio   ?? 1.5,  // vol spike multiplier for climax bonus
    simulationMode:      data.simulationMode        ?? false,
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
  };
  db.get('autotrader_bots').push(bot).write();
  return bot;
}

function getBots(userId) {
  return db.get('autotrader_bots').filter({ userId }).value();
}

function getBot(botId) {
  return db.get('autotrader_bots').find({ id: botId }).value();
}

function deleteBot(botId) {
  stopBot(botId);
  db.get('autotrader_bots').remove({ id: botId }).write();
}

// ─── Runner lifecycle ─────────────────────────────────────────────────────────

async function startBot(botId) {
  const bot = getBot(botId);
  if (!bot) throw new Error('Bot not found');
  if (runners.has(botId)) throw new Error('Bot already running');

  // ── Engine selection based on strategy type ─────────────────────────────
  // 'toptick' = Top Tick Exhaustion (delta divergence at price extremes)
  // default   = Order Flow Engine   (multi-factor vote: delta, imbalance, absorption, EMA)
  let engine;
  if (bot.strategyType === 'toptick') {
    engine = new TopTickEngine({
      lookbackBars:      bot.ttLookbackBars      ?? 10,
      divLookback:       bot.ttDivLookback       ?? 5,
      minDivMagnitude:   bot.ttMinDivMagnitude   ?? 50,
      exhaustionRatio:   bot.ttExhaustionRatio   ?? 0.65,
      absorptionMinVol:  bot.absorptionMinVol    ?? 800,
      volumeClimaxRatio: bot.ttVolumeClimaxRatio ?? 1.5,
      minConfidence:     bot.minConfidence       ?? 60,
      cooldownBars:      bot.cooldownBars        ?? 5,
      atrPeriod:         bot.atrPeriod           ?? 10,
      minAtrTicks:       bot.minAtrTicks         ?? 3,
      maxAtrTicks:       bot.maxAtrTicks         ?? 120,
      riskRewardRatio:   bot.riskRewardRatio     || 2.0,
      minWarmupBars:     bot.minWarmupBars        ?? 30,
      minSignalVolume:   bot.minSignalVolume      ?? 200,
    });
    logger.info(`[autoTrader] Bot "${bot.name}" using TopTickEngine (exhaustion strategy)`);
  } else {
    engine = new OrderFlowEngine({
      windowSize:         bot.windowSize,
      deltaThreshold:     bot.deltaThreshold,
      imbalanceThreshold: bot.imbalanceThreshold,
      absorptionMinVol:   bot.absorptionMinVol,
      momentumPeriod:     bot.momentumPeriod,
      minConfidence:      bot.minConfidence,
      cooldownBars:       bot.cooldownBars,
      // v2: trend + regime
      trendPeriod:        bot.trendPeriod  || 10,
      atrPeriod:          bot.atrPeriod    || 10,
      minAtrTicks:        bot.minAtrTicks  ?? 4,
      maxAtrTicks:        bot.maxAtrTicks  ?? 100,
      riskRewardRatio:    bot.riskRewardRatio || 2.0,
      // v3: high-win-rate gates
      minConfluence:       bot.minConfluenceGate     ?? 4,
      minWarmupBars:       bot.minWarmupBars          ?? 30,
      minSignalVolume:     bot.minSignalVolume         ?? 200,
      requireTripleLock:   bot.requireTripleLock       ?? true,
    });
  }

  const stats = {
    signals: 0, trades: 0,
    wins: 0, losses: 0,
    consecLosses: 0,          // consecutive loss circuit-breaker counter
    pnl: 0,                   // estimated session P&L in ticks
    estimatedPnlUsd: 0,       // approximate USD (ticks × tickValue)
    dailyLoss: 0, dailyTrades: 0,
    barCount: 0,              // total bars ingested (used for periodic Claude analysis)
    lastClaudeAnalysis: null, // most recent proactive Claude order flow read
    sessionPeakPnl: 0,        // highest P&L this session (for drawdown guard)
    // ── GEX stats ──────────────────────────────────────────────────────────
    gexLevels:         null,  // current computed GEX key levels
    lastGEXBar:        0,     // barCount when GEX analysis last ran (cooldown)
    lastGEXRefreshBar: 0,     // barCount when GEX levels were last refreshed
    lastGEXAnalysis:   null,  // most recent Claude GEX analysis result
    gexTrades:         0,     // trades triggered by GEX analysis
    // ── Multi-timeframe (5-min) state ──────────────────────────────────────
    mtfBarBuffer: [],         // buffer of 1-min bars accumulating into next 5-min bar
    mtfBars5m:    [],         // rolling window of completed 5-min bars (max 50 = ~4h)
    mtf5EmaTrend: 'neutral',  // 'bull' | 'bear' | 'neutral' — latest 5-min EMA direction
    // ── Win-rate feedback loop ────────────────────────────────────────────
    recentOutcomes: [],       // last 20 trade outcomes { direction, confidence, regime, outcome, timestamp }
  };

  // How often (in bars) to trigger proactive Claude order flow analysis
  // When Claude is enabled on the bot, every CLAUDE_OF_INTERVAL bars Claude reads the tape
  const CLAUDE_OF_INTERVAL = config.orderFlow.claudeOfBarsInterval;

  // ── GEX helpers ────────────────────────────────────────────────────────────

  /**
   * (Re)compute GEX levels from the engine's accumulated bars.
   * Always tries to top-up with fresh history from the TopStepX API first,
   * falling back to whatever bars the engine has already accumulated.
   */
  async function _refreshGEXLevels() {
    const symState = engine.symbolState[bot.symbol];
    let bars = symState?.bars ? [...symState.bars] : [];

    // Try to fetch a richer slice of history from the TopStepX account
    const account = db.get('accounts').find({ id: bot.accountId }).value();
    if (account && account.userName && account.apiKey && !_isPlaceholder(account.apiKey)) {
      try {
        const historyCfg = {
          userName:  account.userName,
          apiKey:    account.apiKey,
          accountId: account.accountId,
          sim:       account.sim ?? false,
        };

        // Resolve contractId via the feed if already connected, otherwise look it up
        let contractId = feed?.contractId || null;
        if (!contractId) {
          const contracts = await getContracts(historyCfg, bot.symbol);
          contractId = contracts[0]?.id;
        }

        if (contractId) {
          const histBars = await getHistoricalBars(historyCfg, contractId, { limit: 400 });
          if (histBars.length > bars.length) {
            bars = histBars;
            logger.info(`[autoTrader:GEX] Fetched ${histBars.length} history bars for ${bot.symbol} (${bot.name})`);
          }
        }
      } catch (err) {
        logger.warn(`[autoTrader:GEX] History fetch failed for "${bot.name}": ${err.message} — using engine bars`);
      }
    }

    if (bars.length >= 30) {
      const tickSize = parseFloat(bot.tickSize || config.orderFlow.tickSize);
      stats.gexLevels = computeGEXLevels(bars, { tickSize });
      stats.lastGEXRefreshBar = stats.barCount;
      if (stats.gexLevels) {
        logger.info(
          `[autoTrader:GEX] Levels refreshed for "${bot.name}" — ` +
          `POC:${stats.gexLevels.poc} VAH:${stats.gexLevels.vah} VAL:${stats.gexLevels.val} ` +
          `[${stats.gexLevels.keyLevels.length} key levels from ${bars.length} bars]`
        );
      }
    } else {
      logger.debug(`[autoTrader:GEX] Not enough bars (${bars.length}) for GEX computation yet`);
    }
  }

  /**
   * Run Claude's GEX level analysis and, if a high-confidence setup is returned,
   * execute the trade via the normal order path.
   */
  async function _runGEXAnalysis(currentPrice, symState) {
    if (!stats.gexLevels) return;
    if (!bot.claudeEnabled || !config.claude.enabled) return;

    // Cooldown check — don't spam the AI every bar
    if (stats.barCount - stats.lastGEXBar < (bot.gexCooldownBars || 10)) return;

    const nearbyLevels = getNearbyLevels(
      currentPrice,
      stats.gexLevels.keyLevels,
      bot.gexProximityTicks || 6,
      parseFloat(bot.tickSize || config.orderFlow.tickSize)
    );

    if (nearbyLevels.length === 0) return; // price not near any key level

    stats.lastGEXBar = stats.barCount;

    logger.info(
      `[autoTrader:GEX] "${bot.name}" price ${currentPrice} near ${nearbyLevels.length} key level(s): ` +
      nearbyLevels.map(l => `${l.label} @ ${l.price}`).join(', ')
    );

    try {
      const liveMetrics = engine.getMetrics(bot.symbol) || {};
      const liveBars    = (symState?.bars || []).slice(-12);

      const gexAnalysis = await claudeAI.analyzeGEXLevels(
        bot.symbol,
        currentPrice,
        stats.gexLevels,
        liveBars,
        liveMetrics,
        bot
      );

      stats.lastGEXAnalysis = { ...gexAnalysis, triggeredAt: new Date().toISOString(), nearPrice: currentPrice };

      // Persist to signal log for dashboard visibility
      db.get('autotrader_signals').push({
        id:         uuidv4(),
        botId:      botId,
        userId:     bot.userId,
        symbol:     bot.symbol,
        side:       gexAnalysis.tradeSetups?.[gexAnalysis.bestSetupIndex ?? 0]?.direction || 'NEUTRAL',
        confidence: gexAnalysis.biasStrength,
        reasons:    gexAnalysis.keyObservations || [],
        metrics:    liveMetrics,
        status:     'gex_analysis',
        blockedReason: gexAnalysis.dangerFlags?.length ? gexAnalysis.dangerFlags.join('; ') : null,
        order:      null,
        aiAnalysis: gexAnalysis,
        timestamp:  new Date().toISOString(),
      }).write();

      // ── Execute the best trade setup if confidence meets threshold ──────
      const bestIdx = gexAnalysis.bestSetupIndex;
      if (
        bestIdx != null &&
        gexAnalysis.tradeSetups?.[bestIdx] &&
        gexAnalysis.tradeSetups[bestIdx].confidence >= (bot.gexMinConfidence || 70) &&
        gexAnalysis.dangerFlags?.length === 0 &&
        ['BULLISH', 'BEARISH'].includes(gexAnalysis.bias)
      ) {
        const setup = gexAnalysis.tradeSetups[bestIdx];
        const syntheticSignal = {
          symbol:     bot.symbol,
          signal:     setup.direction,
          confidence: setup.confidence,
          reasons:    [
            `GEX: ${setup.gexLevelUsed || 'key level'}`,
            setup.rationale?.slice(0, 80) || '',
          ].filter(Boolean),
          metrics:    liveMetrics,
          recentBars: liveBars.map(b => ({
            t: b.time, o: b.open, h: b.high, l: b.low, c: b.close,
            vol: b.volume, askVol: Math.round(b.askVol || 0),
            bidVol: Math.round(b.bidVol || 0),
            delta: Math.round(b.delta || 0),
            imb: Math.round(((b.imbalance ?? 0.5)) * 100) / 100,
            abs: b.absorption ? 1 : 0,
            atr: Math.round((b.atr || 0) * 100) / 100,
          })),
          _gexTriggered: true,
          _gexLevel:     setup.gexLevelUsed,
        };

        logger.info(
          `[autoTrader:GEX] "${bot.name}" executing ${setup.direction} from GEX level ` +
          `(${setup.gexLevelUsed}) — AI conf:${setup.confidence}% bias:${gexAnalysis.bias}`
        );
        stats.gexTrades++;
        await _handleSignal(bot, syntheticSignal, stats);
      }
    } catch (err) {
      logger.warn(`[autoTrader:GEX] Analysis error for "${bot.name}": ${err.message}`);
    }
  }

  engine.on('signal', async (result) => {
    if (result.signal === 'HOLD') return;
    await _handleSignal(bot, result, stats);
  });

  // Shared bar handler — called on every ingested bar regardless of mode
  const _onBar = async (bar) => {
    engine.ingest(bar);
    stats.barCount++;

    const symState   = engine.symbolState[bot.symbol];
    const latestBar  = symState?.bars?.[symState.bars.length - 1];
    const currentPrice = latestBar?.close ?? bar.close;

    // ── Periodic GEX level refresh ──────────────────────────────────────────
    const gexRefreshInterval = bot.gexRefreshBars || 60;
    if (
      bot.gexEnabled &&
      stats.barCount - stats.lastGEXRefreshBar >= gexRefreshInterval
    ) {
      // Fire-and-forget refresh — don't block bar processing
      _refreshGEXLevels().catch(err =>
        logger.warn(`[autoTrader:GEX] Refresh error: ${err.message}`)
      );
    }

    // ── GEX key level proximity check → Claude trade ───────────────────────
    if (bot.gexEnabled && stats.gexLevels && currentPrice) {
      _runGEXAnalysis(currentPrice, symState).catch(err =>
        logger.warn(`[autoTrader:GEX] Proximity check error: ${err.message}`)
      );
    }

    // Proactive Claude order flow analysis every N bars (when Claude is enabled)
    if (
      bot.claudeEnabled &&
      config.claude.enabled &&
      stats.barCount % CLAUDE_OF_INTERVAL === 0
    ) {
      const liveBars = symState?.bars || [];
      if (liveBars.length >= 5) {
        try {
          const analysis = await claudeAI.analyzeOrderFlow(bot.symbol, liveBars, bot, stats.recentOutcomes);
          stats.lastClaudeAnalysis = { ...analysis, timestamp: new Date().toISOString() };
          logger.info(
            `[autoTrader] Claude OF read "${bot.name}" ${bot.symbol}: ` +
            `${analysis.direction} @ ${analysis.confidence}% — ${analysis.keyAlert || analysis.reasoning?.slice(0, 60)}`
          );
          // Persist the proactive analysis as a signal log entry for the dashboard
          db.get('autotrader_signals').push({
            id:        uuidv4(),
            botId:     botId,
            userId:    bot.userId,
            symbol:    bot.symbol,
            side:      analysis.direction,
            confidence: analysis.confidence,
            reasons:   analysis.volumeObservations || [],
            metrics:   {},
            status:    'claude_analysis',
            blockedReason: null,
            order:     null,
            aiAnalysis: analysis,
            timestamp: new Date().toISOString(),
          }).write();

          // ── Claude-initiated trade ────────────────────────────────────────
          // When Claude spots a high-conviction setup proactively, it sets
          // shouldTrade:true. Execute via the normal signal handler so all
          // risk rules (session filter, circuit breakers, daily limits) apply.
          if (
            analysis.shouldTrade &&
            analysis.tradeSetup &&
            analysis.tradeSetup.confidence >= 80 &&
            ['BUY', 'SELL'].includes(analysis.tradeSetup.direction)
          ) {
            const setup = analysis.tradeSetup;
            const syntheticSignal = {
              symbol:      bot.symbol,
              signal:      setup.direction,
              confidence:  setup.confidence,
              confluences: 99, // bypass confluence gate — Claude already applied it
              reasons:     setup.reasonsToTrade || [`Claude initiated: ${analysis.reasoning?.slice(0, 60)}`],
              metrics:     {},
              recentBars:  liveBars.slice(-10).map(b => ({
                t: b.time, o: b.open, h: b.high, l: b.low, c: b.close,
                vol: b.volume, askVol: Math.round(b.askVol || 0),
                bidVol: Math.round(b.bidVol || 0),
                delta: Math.round(b.delta || 0),
                imb: Math.round((b.imbalance ?? 0.5) * 100) / 100,
                abs: b.absorption ? 1 : 0,
                atr: Math.round((b.atr || 0) * 100) / 100,
              })),
              _claudeInitiated: true,
            };
            logger.info(
              `[autoTrader] Claude-initiated ${setup.direction} on "${bot.name}" ` +
              `(conf:${setup.confidence}% urgency:${setup.urgency || 'NOW'})`
            );
            await _handleSignal(bot, syntheticSignal, stats);
          }
        } catch (err) {
          logger.warn(`[autoTrader] Proactive Claude analysis failed (${bot.name}): ${err.message}`);
        }
      }
    }

    // ── 5-min bar aggregation (multi-timeframe trend) ───────────────────────
    stats.mtfBarBuffer.push(bar);
    if (stats.mtfBarBuffer.length >= 5) {
      const group = stats.mtfBarBuffer.splice(0, 5);
      const bar5m = {
        open:   group[0].open   || group[0].close,
        high:   Math.max(...group.map(b => b.high  || b.close)),
        low:    Math.min(...group.map(b => b.low   || b.close)),
        close:  group[group.length - 1].close,
        volume: group.reduce((s, b) => s + (b.volume || 0), 0),
        askVol: group.reduce((s, b) => s + (b.askVol || 0), 0),
        bidVol: group.reduce((s, b) => s + (b.bidVol || 0), 0),
      };
      stats.mtfBars5m.push(bar5m);
      if (stats.mtfBars5m.length > 50) stats.mtfBars5m.shift(); // keep ~4h

      // Compute 14-period EMA on 5-min closes to get a trend direction
      const closes = stats.mtfBars5m.map(b => b.close);
      if (closes.length >= 5) {
        const period = Math.min(14, closes.length);
        const k      = 2 / (period + 1);
        let ema      = closes.slice(0, period).reduce((a, c) => a + c, 0) / period;
        for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
        const latest = closes[closes.length - 1];
        if      (latest > ema * 1.0002) stats.mtf5EmaTrend = 'bull';
        else if (latest < ema * 0.9998) stats.mtf5EmaTrend = 'bear';
        else                             stats.mtf5EmaTrend = 'neutral';
      }
    }
  }; // end _onBar

  let intervalId = null;
  let feed       = null;

  if (bot.simulationMode) {
    // ── Simulation mode: synthetic tick data for demo / testing ─────────────
    let price = 21000 + Math.random() * 500;
    intervalId = setInterval(() => {
      price += (Math.random() - 0.49) * 8;
      const vol       = Math.floor(Math.random() * 800) + 200;
      const imbalance = 0.4 + Math.random() * 0.2;
      _onBar({
        symbol: bot.symbol,
        close:  price,
        open:   price - (Math.random() - 0.5) * 4,
        high:   price + Math.random() * 3,
        low:    price - Math.random() * 3,
        volume: vol,
        askVol: Math.floor(vol * imbalance),
        bidVol: Math.floor(vol * (1 - imbalance)),
      });
    }, 3000);

  } else if (['topstep', 'topstepx'].includes((bot.broker || '').toLowerCase())) {
    // ── Live mode: prefer TopStepX native feed using the stored account creds ──
    //
    // Priority order:
    //   1. TopStepXMarketFeed  — uses the account's userName + apiKey (no extra creds needed)
    //   2. TradovateMarketFeed — only if TRADOVATE_USERNAME + PASSWORD are set in .env
    //   3. Manual feed         — operator pushes bars to /autotrader/:id/feed
    //
    const account = db.get('accounts').find({ id: bot.accountId }).value();

    const useTopStepXFeed = account && account.userName && account.apiKey &&
      !_isPlaceholder(account.apiKey);

    const useTradovateFeed = !useTopStepXFeed &&
      !_isPlaceholder(config.tradovate.username) &&
      !_isPlaceholder(config.tradovate.password);

    if (useTopStepXFeed) {
      // ── Primary: TopStepX real-time SignalR feed (tick data → 1-min bars) ──
      // Falls back automatically to the polling feed if the SignalR hub is
      // unreachable (e.g. network restriction or API tier limitation).
      const feedCfg = {
        userName:  account.userName,
        apiKey:    account.apiKey,
        accountId: account.accountId,
        sim:       account.sim ?? false,
      };

      let realtimeFailed = false;
      const realtimeFeed = new TopStepXRealtimeFeed({
        symbol:   bot.symbol,
        cfg:      feedCfg,
        onBar:    _onBar,
        onError:  (err) => logger.warn(`[autoTrader] TopStepX RT feed error for bot ${botId}: ${err.message}`),
      });

      try {
        // Attempt real-time connection with a short timeout — if it fails we fall
        // through to the polling feed immediately without blocking bot startup.
        await Promise.race([
          realtimeFeed.connect(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('RT timeout')), 12_000)),
        ]);
        feed = realtimeFeed;
        logger.info(`[autoTrader] TopStepX REAL-TIME feed active for ${bot.symbol} (bot: ${botId})`);
      } catch (err) {
        realtimeFailed = true;
        logger.warn(`[autoTrader] Real-time feed unavailable (${err.message}) — falling back to polling feed`);
        realtimeFeed.disconnect();
      }

      if (realtimeFailed) {
        // ── Fallback: TopStepX polling feed (30-second bars) ─────────────────
        feed = new TopStepXMarketFeed({
          symbol:       bot.symbol,
          cfg:          feedCfg,
          onBar:        _onBar,
          onError:      (err) => logger.error(`[autoTrader] TopStepX feed error for bot ${botId}: ${err.message}`),
          pollInterval: config.orderFlow.topstepxPollIntervalMs,
        });
        feed.connect();
        logger.info(`[autoTrader] TopStepX polling feed starting for ${bot.symbol} (bot: ${botId})`);
      }

    } else if (useTradovateFeed) {
      // ── Fallback: Tradovate WebSocket (requires .env TRADOVATE_USERNAME/PASSWORD) ──
      const mdCfg = {
        username:   config.tradovate.username,
        password:   config.tradovate.password,
        appId:      config.tradovate.appId,
        appVersion: config.tradovate.appVersion,
        sim:        bot.sim ?? false,
      };
      feed = new TradovateMarketFeed({
        symbol:  bot.symbol,
        cfg:     mdCfg,
        onBar:   _onBar,
        onError: (err) => logger.error(`[autoTrader] Tradovate feed error for bot ${botId}: ${err.message}`),
      });
      feed.connect();
      logger.info(`[autoTrader] Tradovate WebSocket feed starting for ${bot.symbol} (bot: ${botId})`);

    } else {
      // ── No credentials available: manual feed mode ────────────────────────
      logger.warn(
        `[autoTrader] Bot "${bot.name}" (${botId}): no market data feed configured.\n` +
        '  Option A (recommended): connect a TopStepX account in the Accounts section.\n' +
        '  Option B: add TRADOVATE_USERNAME + TRADOVATE_PASSWORD to .env.\n' +
        '  Option C: push bars manually to POST /autotrader/bots/:id/feed'
      );
    }
  }

  runners.set(botId, { engine, intervalId, feed, stats, startedAt: new Date().toISOString() });
  db.get('autotrader_bots').find({ id: botId }).assign({ status: 'running' }).write();
  logger.info(`[autoTrader] Bot "${bot.name}" (${botId}) started`);

  // ── Bootstrap GEX levels asynchronously after startup ────────────────────
  // Fetch historical bars from TopStepX API to seed the volume profile.
  // This runs in the background so it doesn't delay the bot start response.
  if (bot.gexEnabled) {
    setImmediate(() => {
      _refreshGEXLevels().catch(err =>
        logger.warn(`[autoTrader:GEX] Initial level bootstrap failed for "${bot.name}": ${err.message}`)
      );
    });
  }

  // Report which feed is active
  const feedType = bot.simulationMode ? 'simulation'
    : feed instanceof TopStepXRealtimeFeed ? 'topstepx_realtime'
    : feed instanceof TopStepXMarketFeed   ? 'topstepx_native'
    : feed instanceof TradovateMarketFeed  ? 'tradovate_websocket'
    : 'manual';

  return { status: 'running', simulationMode: bot.simulationMode, liveMarketData: !!feed, feedType };
}

function stopBot(botId) {
  const runner = runners.get(botId);
  if (runner) {
    if (runner.intervalId) clearInterval(runner.intervalId);
    if (runner.feed)       runner.feed.disconnect();
    runner.engine.removeAllListeners();
    runners.delete(botId);
  }
  db.get('autotrader_bots').find({ id: botId }).assign({ status: 'stopped' }).write();
  logger.info(`[autoTrader] Bot ${botId} stopped`);
}

/**
 * Feed a single market data bar/tick to a running bot.
 * Called by POST /autotrader/:botId/feed from external data provider.
 */
function feedData(botId, payload) {
  const runner = runners.get(botId);
  if (!runner) throw new Error('Bot is not running');
  const result = runner.engine.ingest(payload);
  return result; // null if no signal yet
}

function getBotStatus(botId) {
  const bot    = getBot(botId);
  const runner = runners.get(botId);
  if (!bot) return null;
  const s = runner?.stats || null;
  return {
    ...bot,
    live: !!runner,
    stats: s ? {
      ...s,
      winRate: s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0,
      // Expose a lightweight GEX summary (not the full level array to keep response small)
      gexSummary: s.gexLevels ? {
        poc:         s.gexLevels.poc,
        vah:         s.gexLevels.vah,
        val:         s.gexLevels.val,
        vwap:        s.gexLevels.vwap,
        sessionHigh: s.gexLevels.sessionHigh,
        sessionLow:  s.gexLevels.sessionLow,
        keyLevelCount: s.gexLevels.keyLevels?.length || 0,
        computedAt:  s.gexLevels.computedAt,
      } : null,
    } : null,
    startedAt: runner?.startedAt || null,
    metrics:   runner?.engine?.getMetrics(bot.symbol) || null,
    lastClaudeAnalysis: runner?.stats?.lastClaudeAnalysis || null,
    lastGEXAnalysis:    runner?.stats?.lastGEXAnalysis    || null,
  };
}

function getAllStatuses(userId) {
  return getBots(userId).map(b => getBotStatus(b.id));
}

// ─── Session time filter ──────────────────────────────────────────────────────
/**
 * Returns true when the current UTC time falls inside a valid trading window.
 *
 * Equity index futures edge is concentrated in Regular Trading Hours (RTH):
 *   CME RTH = 08:30–15:15 Central Time  (13:30–20:15 UTC in CDT, 14:30–21:15 UTC in CST)
 *
 * We skip the first 15 min after RTH open (news reaction / spread wide) and the
 * last 30 min before RTH close (position squaring, thin liquidity).
 * Effective trading window: 08:45–14:45 CT  (safe conservative window, ~6 hrs).
 *
 * bot.tradingWindowStart / bot.tradingWindowEnd override in "HH:MM CT" 24h format.
 * Set bot.sessionFilter = false to disable entirely.
 */
function _isInTradingWindow(bot) {
  if (bot.sessionFilter === false) return true;

  const now     = new Date();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();
  const utcMins = utcHour * 60 + utcMin;

  // Parse "HH:MM" string into UTC minutes, accounting for CT offset.
  // CT = UTC-5 (CST) or UTC-6 (CDT). We use UTC-5 (conservative — matches the
  // narrower window so we never accidentally trade outside RTH).
  const CT_OFFSET_MIN = 5 * 60; // UTC-5

  function ctToUtcMins(ctStr) {
    const [h, m] = (ctStr || '').split(':').map(Number);
    if (isNaN(h)) return null;
    return (h * 60 + (m || 0) + CT_OFFSET_MIN) % (24 * 60);
  }

  const windowStart = ctToUtcMins(bot.tradingWindowStart) ?? (8 * 60 + 45 + CT_OFFSET_MIN) % (24 * 60);  // 08:45 CT default
  const windowEnd   = ctToUtcMins(bot.tradingWindowEnd)   ?? (14 * 60 + 45 + CT_OFFSET_MIN) % (24 * 60); // 14:45 CT default

  if (windowStart < windowEnd) {
    return utcMins >= windowStart && utcMins < windowEnd;
  }
  // Handle midnight wrap
  return utcMins >= windowStart || utcMins < windowEnd;
}

// ─── Signal → Order execution ─────────────────────────────────────────────────

async function _handleSignal(bot, signal, stats) {
  // ── Multi-timeframe trend filter (5-min EMA) ─────────────────────────────
  // Block signals that go strongly against the 5-min EMA trend.
  // Claude-initiated signals and GEX signals bypass this — they already did
  // their own multi-factor analysis.
  if (!signal._claudeInitiated && !signal._gexTriggered) {
    const mtfTrend  = stats?.mtf5EmaTrend || 'neutral';
    const signalDir = signal.signal === 'BUY' ? 'bull' : 'bear';
    if (mtfTrend !== 'neutral' && signalDir !== mtfTrend) {
      _logSignal(bot, signal, 'blocked',
        `Counter-trend on 5-min timeframe (5m EMA trend: ${mtfTrend}, signal: ${signal.signal})`
      );
      return;
    }
  }

  // ── Session time filter ───────────────────────────────────────────────────
  if (!_isInTradingWindow(bot)) {
    _logSignal(bot, signal, 'blocked', 'Outside trading window (RTH only 08:45–14:45 CT)');
    return;
  }

  // ── Minimum confluence gate ───────────────────────────────────────────────
  // Require the signal to have strong multi-factor backing from the engine.
  const minConf = bot.minConfluenceGate ?? 4;
  if ((signal.confluences ?? 99) < minConf) {
    _logSignal(bot, signal, 'blocked', `Insufficient confluences (${signal.confluences ?? '?'}/${minConf})`);
    return;
  }

  // ── Win-rate circuit breaker ──────────────────────────────────────────────
  // After enough live trades, if the win rate has dropped below the threshold
  // pause and log — prevents a broken/changing market from draining the account.
  const minTradesForWRCheck = bot.winRateCheckMinTrades ?? 10;
  const minWinRate          = bot.minWinRate           ?? 0.40; // stop at 40% — significantly below target 70%
  if (stats.trades >= minTradesForWRCheck) {
    const liveWinRate = stats.trades > 0 ? stats.wins / stats.trades : 1;
    if (liveWinRate < minWinRate) {
      _logSignal(bot, signal, 'blocked',
        `Win rate circuit breaker: ${Math.round(liveWinRate * 100)}% < ${Math.round(minWinRate * 100)}% ` +
        `(${stats.wins}W/${stats.losses}L on ${stats.trades} trades) — manual review required`
      );
      return;
    }
  }

  // ── Session drawdown guard ────────────────────────────────────────────────
  // Stop trading for the day if session P&L has dropped more than maxSessionDrawdownTicks
  // below the session's peak. Protects the account from a bad run.
  const peakPnl = stats.sessionPeakPnl ?? 0;
  stats.sessionPeakPnl = Math.max(peakPnl, stats.pnl);
  const drawdownFromPeak = stats.sessionPeakPnl - stats.pnl;
  const maxDrawdown = bot.maxSessionDrawdownTicks ?? (bot.slTicks * 5); // default: 5× SL
  if (drawdownFromPeak >= maxDrawdown) {
    _logSignal(bot, signal, 'blocked',
      `Session drawdown limit hit: −${drawdownFromPeak} ticks from peak ` +
      `(max ${maxDrawdown} ticks) — stopped for the session`
    );
    return;
  }

  // ── Hard daily circuit breakers ───────────────────────────────────────────
  if (stats.dailyTrades >= bot.maxDailyTrades) {
    _logSignal(bot, signal, 'blocked', 'Max daily trades reached');
    return;
  }
  if (stats.dailyLoss >= bot.maxDailyLoss) {
    _logSignal(bot, signal, 'blocked', 'Max daily loss reached');
    return;
  }
  if (bot.maxConsecLosses && stats.consecLosses >= bot.maxConsecLosses) {
    _logSignal(bot, signal, 'blocked', `Consecutive loss limit (${bot.maxConsecLosses}) hit — bot paused`);
    return;
  }

  // ── Claude AI second-opinion filter ─────────────────────────────────────
  // Enabled when: CLAUDE_ENABLED=true in .env AND bot has claudeEnabled:true
  // AND engine confidence >= CLAUDE_MIN_ENGINE_CONFIDENCE threshold
  const claudeGlobalEnabled = config.claude.enabled;
  const claudeBotEnabled    = bot.claudeEnabled ?? false;
  if (claudeGlobalEnabled && claudeBotEnabled &&
      signal.confidence >= config.claude.minEngineConfidence) {
    try {
      const indicators   = db.get('indicators').filter({ userId: bot.userId }).value().slice(0, 10);
      const recentTrades = stats.recentOutcomes.length >= 3
        ? stats.recentOutcomes
        : db.get('trade_log').filter({ userId: bot.userId }).value().slice(-10);
      const aiResult = await claudeAI.validateSignal(signal, bot, indicators, recentTrades);

      const AI_MIN_CONFIDENCE = 72; // must meet this to approve — aligns with 70%+ WR target
      if (!aiResult.approved || aiResult.aiConfidence < AI_MIN_CONFIDENCE) {
        const reason = aiResult.approved
          ? `Claude AI aiConfidence ${aiResult.aiConfidence}% < required ${AI_MIN_CONFIDENCE}% (dir: ${aiResult.aiDirection})`
          : `Claude AI rejected: ${aiResult.reasoning} (AI conf: ${aiResult.aiConfidence}%, AI dir: ${aiResult.aiDirection})`;
        _logSignal(bot, signal, 'blocked', reason);
        logger.info(`[autoTrader] Bot "${bot.name}" signal BLOCKED by Claude AI`);
        return;
      }
      // Log AI approval and attach to signal for trade log
      signal._aiValidation = {
        approved:     aiResult.approved,
        aiConfidence: aiResult.aiConfidence,
        aiDirection:  aiResult.aiDirection,
        reasoning:    aiResult.reasoning,
      };
      logger.info(`[autoTrader] Bot "${bot.name}" signal APPROVED by Claude AI (conf: ${aiResult.aiConfidence}%)`);
    } catch (err) {
      // Non-fatal: if AI errors out, the original engine signal proceeds
      logger.warn(`[autoTrader] Claude AI validation error (proceeding): ${err.message}`);
    }
  }

  // Find the account config to get broker credentials
  const account = db.get('accounts').find({ id: bot.accountId }).value();
  if (!account) {
    _logSignal(bot, signal, 'blocked', 'No account linked');
    return;
  }

  const brokerConfig = {
    userName:  account.userName,
    username:  account.userName,   // some adapters expect lowercase
    apiKey:    account.apiKey,
    secretKey: account.secretKey,
    apiSecret: account.secretKey,  // Lucid Markets uses apiSecret
    accountId: account.accountId,
    sim:       account.sim,
  };

  // ── 2:1 enforcement: tpTicks is always slTicks × riskRewardRatio ─────────
  const slTicks = bot.slTicks || 12;
  const rr      = bot.riskRewardRatio || 2.0;
  const tpTicks = Math.round(slTicks * rr);

  const order = {
    action:    signal.signal.toLowerCase(), // 'buy' or 'sell'
    ticker:    bot.symbol,
    qty:       bot.qty,
    orderType: 'market',
    slTicks,
    tpTicks,
    riskRewardRatio: rr,
    signal:    `OF:${signal.confidence}% RR:${rr} regime:${signal.metrics?.regime||'?'} [${signal.reasons.join(', ')}]`,
    comment:   `AutoTrader:${bot.name}`,
  };

  let brokerResponse = null;
  let logStatus = 'open';

  try {
    if (bot.simulationMode) {
      // Simulate outcome based on confidence probability
      // Higher confidence = higher win probability, scaled to be realistic
      const winProb = 0.35 + (signal.confidence / 100) * 0.35; // 35%-70% range
      const won = Math.random() < winProb;
      brokerResponse = {
        simulated: true,
        outcome:   won ? 'win' : 'loss',
        pnlTicks:  won ? tpTicks : -slTicks,
      };

      // Track win/loss + P&L ticks
      if (won) {
        stats.wins++;
        stats.consecLosses = 0;
        stats.pnl += tpTicks;
      } else {
        stats.losses++;
        stats.consecLosses++;
        stats.pnl -= slTicks;
        stats.dailyLoss += slTicks; // rough daily loss in ticks
      }
      logStatus = won ? 'win' : 'loss';
    } else {
      brokerResponse = await executeOrder(bot.broker, order, brokerConfig);
    }
    stats.trades++;
    stats.dailyTrades++;
    logger.info(`[autoTrader] "${bot.name}" ${order.action} ${order.qty} ${bot.symbol} SL:${slTicks}t TP:${tpTicks}t (${rr}:1) conf:${signal.confidence}% regime:${signal.metrics?.regime||'?'}`);
  } catch (err) {
    logStatus = 'failed';
    logger.error(`[autoTrader] "${bot.name}" order failed: ${err.message}`);
  }

  // Record outcome in rolling history for Claude's win-rate feedback loop
  stats.recentOutcomes.push({
    direction:  order ? order.action.toUpperCase() : signal.signal.toUpperCase(),
    confidence: signal.confidence,
    regime:     signal.metrics?.regime || 'unknown',
    outcome:    logStatus,
    timestamp:  new Date().toISOString(),
  });
  if (stats.recentOutcomes.length > 20) stats.recentOutcomes.shift();

  stats.signals++;
  _logSignal(bot, signal, logStatus, null, order, brokerResponse);
}

function _logSignal(bot, signal, status, blockedReason = null, order = null, brokerResponse = null) {
  const record = {
    id:            uuidv4(),
    botId:         bot.id,
    userId:        bot.userId,
    symbol:        bot.symbol,
    side:          signal.signal,
    confidence:    signal.confidence,
    reasons:       signal.reasons,
    metrics:       signal.metrics,
    status,
    blockedReason: blockedReason || null,
    order:         order || null,
    brokerResponse:brokerResponse || null,
    timestamp:     new Date().toISOString(),
  };
  db.get('autotrader_signals').push(record).write();

  // Also write to trade_log if an order was placed
  if (order && status === 'open') {
    db.get('trade_log').push({
      id:          uuidv4(),
      userId:      bot.userId,
      webhookId:   null,
      broker:      bot.broker,
      brokerId:    brokerResponse?.orderId || null,
      symbol:      bot.symbol,
      side:        order.action,
      qty:         order.qty,
      entryPrice:  null,
      slTicks:     order.slTicks,
      tpTicks:     order.tpTicks,
      orderType:   order.orderType,
      signal:      order.signal,
      status:      'open',
      pnl:         null,
      openedAt:    new Date().toISOString(),
      closedAt:    null,
    }).write();
  }
}

function getSignals(userId, botId, limit = 100) {
  let q = db.get('autotrader_signals').filter({ userId });
  if (botId) q = q.filter({ botId });
  return q.value().slice(-limit).reverse();
}

/**
 * Return the full GEX key levels for a running bot.
 * Used by the dashboard route to render the level map.
 */
function getGEXLevels(botId) {
  const runner = runners.get(botId);
  return runner?.stats?.gexLevels || null;
}

module.exports = {
  saveBot, getBots, getBot, deleteBot,
  startBot, stopBot, feedData,
  getBotStatus, getAllStatuses,
  getSignals, getGEXLevels,
};
