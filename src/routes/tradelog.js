'use strict';
/**
 * tradelog.js  (routes)
 *
 * GET  /tradelog              - all trade log entries for the user
 * GET  /tradelog/stats        - daily stats (winrate, PnL, trade count)
 * PUT  /tradelog/:id          - update a trade (e.g. set pnl/closedAt when closed)
 */

const express = require('express');
const authMiddleware = require('../middleware/auth');
const orderService = require('../services/orderService');
const db = require('../models/db');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authMiddleware);

// ── Full trade log ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit, 10)  || 200, 1000);
  const trades = orderService.getUserTradeLog(req.user.id, limit);
  return res.json({ trades, count: trades.length });
});

// ── Daily stats ────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const stats = orderService.getDailyStats(req.user.id);
  return res.json(stats);
});

// ── PnL summary  (total, monthly, weekly, daily breakdown) ────────────────────
router.get('/pnl-summary', (req, res) => {
  const trades = db.get('trade_log').filter({ userId: req.user.id }).value();

  const now        = new Date();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const weekStart  = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thirtyAgo  = new Date(); thirtyAgo.setDate(thirtyAgo.getDate() - 29); thirtyAgo.setHours(0, 0, 0, 0);

  const sum = arr => arr.reduce((s, t) => s + (t.pnl || 0), 0);

  const allPnl   = parseFloat(sum(trades).toFixed(2));
  const todayPnl = parseFloat(sum(trades.filter(t => new Date(t.openedAt) >= todayStart)).toFixed(2));
  const weekPnl  = parseFloat(sum(trades.filter(t => new Date(t.openedAt) >= weekStart)).toFixed(2));
  const monthPnl = parseFloat(sum(trades.filter(t => new Date(t.openedAt) >= monthStart)).toFixed(2));

  // Build per-day buckets for the last 30 days
  const daily = {};
  trades
    .filter(t => new Date(t.openedAt) >= thirtyAgo)
    .forEach(t => {
      const day = new Date(t.openedAt).toISOString().slice(0, 10);
      if (!daily[day]) daily[day] = { date: day, pnl: 0, trades: 0, wins: 0, losses: 0 };
      daily[day].pnl    += (t.pnl || 0);
      daily[day].trades += 1;
      if ((t.pnl || 0) > 0) daily[day].wins++;
      if ((t.pnl || 0) < 0) daily[day].losses++;
    });

  const dailyHistory = Object.values(daily)
    .map(d => ({ ...d, pnl: parseFloat(d.pnl.toFixed(2)) }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return res.json({ allPnl, todayPnl, weekPnl, monthPnl, dailyHistory });
});

// ── Update trade (close / set PnL) ────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const trade = db.get('trade_log').find({ id: req.params.id, userId: req.user.id }).value();
  if (!trade) return res.status(404).json({ error: 'Trade not found.' });

  const allowed = ['status', 'pnl', 'closedAt', 'exitPrice'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (updates.status === 'closed' && !updates.closedAt) {
    updates.closedAt = new Date().toISOString();
  }

  db.get('trade_log').find({ id: req.params.id }).assign(updates).write();
  return res.json({ message: 'Trade updated.', trade: { ...trade, ...updates } });
});

module.exports = router;
