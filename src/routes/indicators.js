'use strict';
/**
 * indicators.js  (routes)
 *
 * GET    /indicators           - list all indicators for the current user
 * POST   /indicators           - create a new indicator
 * PUT    /indicators/:id       - update an indicator
 * DELETE /indicators/:id       - delete an indicator
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');
const db = require('../models/db');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authMiddleware);

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const indicators = db.get('indicators').filter({ userId: req.user.id }).value();
  return res.json({ indicators });
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { name, description, ticker, alertTemplate, sourceCode } = req.body;
  if (!name) return res.status(400).json({ error: '"name" is required.' });

  const record = {
    id:            uuidv4(),
    userId:        req.user.id,
    name:          name.trim(),
    description:   (description || '').trim(),
    ticker:        (ticker || '').trim(),
    alertTemplate: alertTemplate || null,   // JSON object or string
    sourceCode:    (sourceCode || '').trim(),
    createdAt:     new Date().toISOString(),
    updatedAt:     new Date().toISOString(),
  };

  db.get('indicators').push(record).write();
  logger.info(`[indicators] Created indicator "${record.name}" for user ${req.user.username}`);
  return res.status(201).json({ indicator: record });
});

// ── Update ────────────────────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const indicator = db.get('indicators').find({ id: req.params.id, userId: req.user.id }).value();
  if (!indicator) return res.status(404).json({ error: 'Indicator not found.' });

  const { name, description, ticker, alertTemplate, sourceCode } = req.body;
  const updates = {
    ...(name          !== undefined && { name: name.trim() }),
    ...(description   !== undefined && { description: description.trim() }),
    ...(ticker        !== undefined && { ticker: ticker.trim() }),
    ...(alertTemplate !== undefined && { alertTemplate }),
    ...(sourceCode    !== undefined && { sourceCode: sourceCode.trim() }),
    updatedAt: new Date().toISOString(),
  };

  db.get('indicators').find({ id: req.params.id }).assign(updates).write();
  return res.json({ indicator: { ...indicator, ...updates } });
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const indicator = db.get('indicators').find({ id: req.params.id, userId: req.user.id }).value();
  if (!indicator) return res.status(404).json({ error: 'Indicator not found.' });
  db.get('indicators').remove({ id: req.params.id }).write();
  return res.json({ message: 'Indicator deleted.' });
});

module.exports = router;
