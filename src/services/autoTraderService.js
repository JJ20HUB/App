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
const { OrderFlowEngine } = require('./orderFlowEngine');
const { executeOrder }    = require('../brokers');
const db                  = require('../models/db');
const logger              = require('../utils/logger');

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
    // Feed
    dataFeedUrl:         data.dataFeedUrl           || '',
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

function startBot(botId) {
  const bot = getBot(botId);
  if (!bot) throw new Error('Bot not found');
  if (runners.has(botId)) throw new Error('Bot already running');

  const engine = new OrderFlowEngine({
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
    minAtrTicks:        bot.minAtrTicks  ?? 3,
    maxAtrTicks:        bot.maxAtrTicks  ?? 120,
    riskRewardRatio:    bot.riskRewardRatio || 2.0,
  });

  const stats = {
    signals: 0, trades: 0,
    wins: 0, losses: 0,
    consecLosses: 0,          // consecutive loss circuit-breaker counter
    pnl: 0,                   // estimated session P&L in ticks
    estimatedPnlUsd: 0,       // approximate USD (ticks × tickValue)
    dailyLoss: 0, dailyTrades: 0,
  };

  engine.on('signal', async (result) => {
    if (result.signal === 'HOLD') return;
    await _handleSignal(bot, result, stats);
  });

  let intervalId = null;

  // If simulation mode, generate synthetic tick data for demo/testing
  if (bot.simulationMode) {
    let price = 21000 + Math.random() * 500;
    intervalId = setInterval(() => {
      price += (Math.random() - 0.49) * 8; // slight upward bias
      const vol = Math.floor(Math.random() * 800) + 200;
      const imbalance = 0.4 + Math.random() * 0.2;
      engine.ingest({
        symbol:  bot.symbol,
        close:   price,
        open:    price - (Math.random() - 0.5) * 4,
        high:    price + Math.random() * 3,
        low:     price - Math.random() * 3,
        volume:  vol,
        askVol:  Math.floor(vol * imbalance),
        bidVol:  Math.floor(vol * (1 - imbalance)),
      });
    }, 3000); // new tick every 3 seconds in sim mode
  }

  runners.set(botId, { engine, intervalId, stats, startedAt: new Date().toISOString() });
  db.get('autotrader_bots').find({ id: botId }).assign({ status: 'running' }).write();
  logger.info(`[autoTrader] Bot "${bot.name}" (${botId}) started`);
  return { status: 'running', simulationMode: bot.simulationMode };
}

function stopBot(botId) {
  const runner = runners.get(botId);
  if (runner) {
    if (runner.intervalId) clearInterval(runner.intervalId);
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
    } : null,
    startedAt: runner?.startedAt || null,
    metrics:   runner?.engine?.getMetrics(bot.symbol) || null,
  };
}

function getAllStatuses(userId) {
  return getBots(userId).map(b => getBotStatus(b.id));
}

// ─── Signal → Order execution ─────────────────────────────────────────────────

async function _handleSignal(bot, signal, stats) {
  // ── Circuit breakers ─────────────────────────────────────────────────────
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

  // Find the account config to get broker credentials
  const account = db.get('accounts').find({ id: bot.accountId }).value();
  if (!account) {
    _logSignal(bot, signal, 'blocked', 'No account linked');
    return;
  }

  const brokerConfig = {
    userName:  account.userName,
    apiKey:    account.apiKey,
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

module.exports = {
  saveBot, getBots, getBot, deleteBot,
  startBot, stopBot, feedData,
  getBotStatus, getAllStatuses,
  getSignals,
};
