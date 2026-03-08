'use strict';
/**
 * user.js  (routes)
 * Protected routes for the authenticated user's profile and order history.
 *
 * GET  /user/me          - get profile
 * GET  /user/orders      - get order history
 */

const express = require('express');
const authMiddleware = require('../middleware/auth');
const orderService = require('../services/orderService');
const db = require('../models/db');

const router = express.Router();
router.use(authMiddleware);

// ── Profile ───────────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found.' });

  return res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
  });
});

// ── Order history ─────────────────────────────────────────────────────────────
router.get('/orders', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const orders = orderService.getUserOrders(req.user.id, limit);
  return res.json({ orders, count: orders.length });
});

// ── Daily stats ───────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const stats = orderService.getDailyStats(req.user.id);
  return res.json(stats);
});

// ── Trade Settings ────────────────────────────────────────────────────────────
const DEFAULT_TRADE_SETTINGS = {
  dailyProfitTarget: null,
  dailyLossLimit: null,
  defaultTpTicks: null,
  defaultSlTicks: null,
  maxDailyTrades: null,
  defaultContracts: null,
};

router.get('/trade-settings', (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found.' });
  return res.json({ tradeSettings: { ...DEFAULT_TRADE_SETTINGS, ...(user.tradeSettings || {}) } });
});

router.put('/trade-settings', (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const allowed = ['dailyProfitTarget', 'dailyLossLimit', 'defaultTpTicks', 'defaultSlTicks', 'maxDailyTrades', 'defaultContracts'];
  const incoming = req.body || {};
  const current = user.tradeSettings || {};

  const updated = { ...current };
  allowed.forEach((key) => {
    if (key in incoming) {
      const v = incoming[key];
      // Accept null to clear a value; otherwise expect a positive number
      if (v === null || v === '') {
        updated[key] = null;
      } else {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0) {
          return res.status(400).json({ error: `"${key}" must be a non-negative number or null.` });
        }
        updated[key] = n;
      }
    }
  });

  db.get('users').find({ id: req.user.id }).assign({ tradeSettings: updated }).write();
  return res.json({ tradeSettings: updated });
});

module.exports = router;
