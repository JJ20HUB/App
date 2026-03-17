'use strict';
/**
 * routes/autotrader.js
 * REST API for the Order Flow Auto-Trader feature.
 *
 * All routes require JWT auth (via middleware/auth).
 *
 * GET    /autotrader/bots              – list user's bots
 * POST   /autotrader/bots              – create bot
 * PUT    /autotrader/bots/:id          – update bot config
 * DELETE /autotrader/bots/:id          – delete bot
 * GET    /autotrader/bots/:id/status   – get live status + metrics
 * POST   /autotrader/bots/:id/start    – start bot
 * POST   /autotrader/bots/:id/stop     – stop bot
 * POST   /autotrader/bots/:id/feed     – push market data bar (from data provider)
 * GET    /autotrader/signals           – recent signal log (all bots)
 * GET    /autotrader/signals/:botId    – signal log for one bot
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const svc    = require('../services/autoTraderService');

router.use(auth);

// ── Bot CRUD ──────────────────────────────────────────────────────────────────

router.get('/bots', (req, res) => {
  const bots = svc.getAllStatuses(req.user.id);
  res.json({ bots });
});

router.post('/bots', (req, res) => {
  try {
    const bot = svc.saveBot(req.user.id, req.body);
    res.status(201).json({ bot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/bots/:id', (req, res) => {
  const existing = svc.getBot(req.params.id);
  if (!existing || existing.userId !== req.user.id)
    return res.status(404).json({ error: 'Bot not found' });
  try {
    const bot = svc.saveBot(req.user.id, { ...req.body, id: req.params.id });
    res.json({ bot });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/bots/:id', (req, res) => {
  const existing = svc.getBot(req.params.id);
  if (!existing || existing.userId !== req.user.id)
    return res.status(404).json({ error: 'Bot not found' });
  svc.deleteBot(req.params.id);
  res.json({ success: true });
});

// ── Live status ───────────────────────────────────────────────────────────────

router.get('/bots/:id/status', (req, res) => {
  const status = svc.getBotStatus(req.params.id);
  if (!status || status.userId !== req.user.id)
    return res.status(404).json({ error: 'Bot not found' });
  res.json({ status });
});

// ── Start / stop ──────────────────────────────────────────────────────────────

router.post('/bots/:id/start', async (req, res) => {
  const bot = svc.getBot(req.params.id);
  if (!bot || bot.userId !== req.user.id)
    return res.status(404).json({ error: 'Bot not found' });
  try {
    const result = await svc.startBot(req.params.id);
    res.json({ ...result, botId: req.params.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/bots/:id/stop', (req, res) => {
  const bot = svc.getBot(req.params.id);
  if (!bot || bot.userId !== req.user.id)
    return res.status(404).json({ error: 'Bot not found' });
  svc.stopBot(req.params.id);
  res.json({ status: 'stopped', botId: req.params.id });
});

// ── Data feed endpoint — called by external market data providers ─────────────
// POST /autotrader/bots/:id/feed  { symbol, close, volume, askVol, bidVol, ... }

router.post('/bots/:id/feed', (req, res) => {
  const bot = svc.getBot(req.params.id);
  if (!bot || bot.userId !== req.user.id)
    return res.status(404).json({ error: 'Bot not found' });
  try {
    const signal = svc.feedData(req.params.id, req.body);
    res.json({ signal: signal || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Signal log ────────────────────────────────────────────────────────────────

router.get('/signals', (req, res) => {
  const signals = svc.getSignals(req.user.id, null, 200);
  res.json({ signals });
});

router.get('/signals/:botId', (req, res) => {
  const bot = svc.getBot(req.params.botId);
  if (!bot || bot.userId !== req.user.id)
    return res.status(404).json({ error: 'Bot not found' });
  const signals = svc.getSignals(req.user.id, req.params.botId, 200);
  res.json({ signals });
});

// ── GEX Key Level routes ──────────────────────────────────────────────────────

/**
 * GET /autotrader/bots/:id/gex
 * Returns the current GEX key levels for a running bot.
 * Used by the dashboard to render the level map on the chart.
 */
router.get('/bots/:id/gex', (req, res) => {
  const bot = svc.getBot(req.params.id);
  if (!bot || bot.userId !== req.user.id)
    return res.status(404).json({ error: 'Bot not found' });
  const levels = svc.getGEXLevels(req.params.id);
  if (!levels) {
    return res.status(202).json({
      message: bot.gexEnabled
        ? 'GEX levels not yet computed — bot may still be loading historical data'
        : 'GEX analysis is not enabled on this bot (set gexEnabled:true)',
      gexLevels: null,
    });
  }
  res.json({ gexLevels: levels });
});

/**
 * GET /autotrader/bots/:id/gex/analysis
 * Returns the most recent Claude GEX analysis result for a running bot.
 */
router.get('/bots/:id/gex/analysis', (req, res) => {
  const bot = svc.getBot(req.params.id);
  if (!bot || bot.userId !== req.user.id)
    return res.status(404).json({ error: 'Bot not found' });
  const status = svc.getBotStatus(req.params.id);
  res.json({
    lastGEXAnalysis: status?.lastGEXAnalysis || null,
    gexSummary:      status?.stats?.gexSummary || null,
  });
});

module.exports = router;
