'use strict';
/**
 * ai.js  (routes)
 *
 * REST endpoints that expose Claude AI capabilities directly to the frontend / API consumers.
 *
 * GET  /ai/status                   — Check if Claude is configured & model info
 * POST /ai/analyze                  — Full market analysis for a symbol
 * POST /ai/signal-review            — Review a specific OrderFlowEngine signal object
 * POST /ai/bot-review/:botId        — Claude reviews a saved bot's risk config
 * POST /ai/indicator-insight        — Strategy advice combining user indicators + order flow
 */

const express       = require('express');
const authMiddleware = require('../middleware/auth');
const claudeAI      = require('../services/claudeAI');
const db            = require('../models/db');
const config        = require('../config');
const logger        = require('../utils/logger');

const router = express.Router();
router.use(authMiddleware);

// ── GET /ai/status ────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    configured:   claudeAI.isConfigured(),
    globalEnabled: config.claude.enabled,
    model:        config.claude.model,
    minEngineConfidence: config.claude.minEngineConfidence,
    message: claudeAI.isConfigured()
      ? 'Claude AI is ready. Set CLAUDE_ENABLED=true in .env and claudeEnabled:true on a bot to activate live signal filtering.'
      : 'Add your ANTHROPIC_API_KEY to .env to enable Claude AI.',
  });
});

// ── POST /ai/analyze ──────────────────────────────────────────────────────────
// Body: { symbol, bars?: OHLCV[] }
router.post('/analyze', async (req, res) => {
  const { symbol, bars = [] } = req.body;
  if (!symbol) return res.status(400).json({ error: '"symbol" is required.' });

  const indicators   = db.get('indicators').filter({ userId: req.user.id }).value();
  const recentTrades = db.get('trade_log').filter({ userId: req.user.id }).value().slice(-20);

  logger.info(`[ai] Market analysis requested: ${symbol} by ${req.user.username}`);

  try {
    const analysis = await claudeAI.analyzeMarket(symbol, bars, indicators, recentTrades);
    return res.json({ symbol, analysis, generatedAt: new Date().toISOString() });
  } catch (err) {
    logger.error(`[ai] analyzeMarket error: ${err.message}`);
    return res.status(500).json({ error: 'AI analysis failed.', detail: err.message });
  }
});

// ── POST /ai/signal-review ────────────────────────────────────────────────────
// Body: { signal: <OrderFlowEngine signal object>, botId?: string }
router.post('/signal-review', async (req, res) => {
  const { signal, botId } = req.body;
  if (!signal || !signal.signal) {
    return res.status(400).json({ error: '"signal" object with a "signal" field is required.' });
  }

  // Load bot config for context (or use a generic placeholder)
  let botConfig = { slTicks: 12, tpTicks: 24, riskRewardRatio: 2, qty: 1, broker: 'unknown' };
  if (botId) {
    const bot = db.get('autotrader_bots').find({ id: botId, userId: req.user.id }).value();
    if (bot) botConfig = bot;
  }

  const indicators   = db.get('indicators').filter({ userId: req.user.id }).value();
  const recentTrades = db.get('trade_log').filter({ userId: req.user.id }).value().slice(-10);

  logger.info(`[ai] Signal review: ${signal.signal} ${signal.symbol} conf:${signal.confidence}% by ${req.user.username}`);

  try {
    const review = await claudeAI.validateSignal(signal, botConfig, indicators, recentTrades);
    return res.json({ signal, review, generatedAt: new Date().toISOString() });
  } catch (err) {
    logger.error(`[ai] validateSignal error: ${err.message}`);
    return res.status(500).json({ error: 'Signal review failed.', detail: err.message });
  }
});

// ── POST /ai/bot-review/:botId ────────────────────────────────────────────────
router.post('/bot-review/:botId', async (req, res) => {
  const bot = db.get('autotrader_bots').find({ id: req.params.botId, userId: req.user.id }).value();
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });

  logger.info(`[ai] Bot review: "${bot.name}" (${bot.id}) by ${req.user.username}`);

  try {
    const review = await claudeAI.reviewBotConfig(bot);
    return res.json({ bot: { id: bot.id, name: bot.name }, review, generatedAt: new Date().toISOString() });
  } catch (err) {
    logger.error(`[ai] reviewBotConfig error: ${err.message}`);
    return res.status(500).json({ error: 'Bot review failed.', detail: err.message });
  }
});

// ── POST /ai/indicator-insight ────────────────────────────────────────────────
// Body: { symbol?: string }
router.post('/indicator-insight', async (req, res) => {
  const { symbol = '' } = req.body;
  const indicators = db.get('indicators').filter({ userId: req.user.id }).value();

  if (!indicators.length) {
    return res.status(400).json({
      error: 'No indicators found. Create indicators first via POST /indicators.',
    });
  }

  logger.info(`[ai] Indicator insight: ${indicators.length} indicators, symbol="${symbol}" by ${req.user.username}`);

  try {
    const insight = await claudeAI.indicatorInsight(indicators, symbol);
    return res.json({ indicatorCount: indicators.length, symbol, insight, generatedAt: new Date().toISOString() });
  } catch (err) {
    logger.error(`[ai] indicatorInsight error: ${err.message}`);
    return res.status(500).json({ error: 'Indicator insight failed.', detail: err.message });
  }
});

module.exports = router;
