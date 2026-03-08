'use strict';
/**
 * accounts.js  (routes)
 *
 * GET    /accounts            - list connected accounts
 * POST   /accounts            - connect a new account
 * DELETE /accounts/:id        - remove an account
 * GET    /accounts/:id/test   - test connection (fetch live accounts from broker)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');
const db = require('../models/db');
const { BROKERS, supportedBrokers } = require('../brokers');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authMiddleware);

// ── Lookup accounts from broker credentials (no saved account needed) ──────────
// POST /accounts/lookup  { broker, userName, apiKey, sim }
// Returns the list of accounts from the broker so the user can find their ID.
router.post('/lookup', async (req, res) => {
  const { broker, userName, apiKey, password, appId, appVersion, sim } = req.body;

  if (!broker) return res.status(400).json({ error: '"broker" is required.' });
  if (!supportedBrokers.includes(broker.toLowerCase())) {
    return res.status(400).json({ error: `Unsupported broker: ${broker}. Choose: ${supportedBrokers.join(', ')}` });
  }

  const adapter = BROKERS[broker.toLowerCase()];
  if (!adapter || typeof adapter.getAccounts !== 'function') {
    return res.status(400).json({ error: `Account lookup is not supported for broker "${broker}".` });
  }

  try {
    const cfg = { userName, apiKey, password, appId, appVersion, sim: !!sim };
    // topstep (Tradovate) uses username/password fields
    if (cfg.userName && !cfg.username) cfg.username = cfg.userName;
    const accounts = await adapter.getAccounts(cfg);
    return res.json({ accounts });
  } catch (err) {
    logger.error(`[accounts/lookup] ${err.message}`);
    return res.status(502).json({ error: err.message });
  }
});

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const accounts = db.get('accounts').filter({ userId: req.user.id }).value();
  // Redact secrets
  const safe = accounts.map(a => ({
    id:        a.id,
    broker:    a.broker,
    label:     a.label,
    userName:  a.userName,
    accountId: a.accountId,
    sim:       a.sim,
    createdAt: a.createdAt,
    hasApiKey: !!a.apiKey,
  }));
  return res.json({ accounts: safe });
});

// ── Connect ───────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { broker, label, userName, apiKey, accountId, sim } = req.body;

  if (!broker) {
    return res.status(400).json({ error: '"broker" is required.' });
  }
  // Auto-generate label from broker + username if not provided
  const resolvedLabel = (label || '').trim() || `${broker} – ${userName || 'account'}`;
  if (!supportedBrokers.includes(broker.toLowerCase())) {
    return res.status(400).json({ error: `Unsupported broker: ${broker}. Choose: ${supportedBrokers.join(', ')}` });
  }

  const record = {
    id:        uuidv4(),
    userId:    req.user.id,
    broker:    broker.toLowerCase(),
    label:     resolvedLabel,
    userName:  userName  || '',
    apiKey:    apiKey    || '',
    accountId: accountId || '',
    sim:       !!sim,
    createdAt: new Date().toISOString(),
  };

  db.get('accounts').push(record).write();
  logger.info(`[accounts] Connected ${broker} account "${label}" for user ${req.user.username}`);

  return res.status(201).json({
    message: 'Account connected.',
    account: { id: record.id, broker: record.broker, label: record.label, accountId: record.accountId },
  });
});

// ── Test connection ───────────────────────────────────────────────────────────
router.get('/:id/test', async (req, res) => {
  const account = db.get('accounts').find({ id: req.params.id, userId: req.user.id }).value();
  if (!account) return res.status(404).json({ error: 'Account not found.' });

  const broker = BROKERS[account.broker];
  if (!broker) return res.status(400).json({ error: `No adapter for broker: ${account.broker}` });

  try {
    let result;
    if (typeof broker.getAccounts === 'function') {
      result = await broker.getAccounts({
        userName:  account.userName,
        username:  account.userName,   // Tradovate uses lowercase 'username'
        apiKey:    account.apiKey,
        password:  account.password,
        appId:     account.appId,
        appVersion: account.appVersion,
        accountId: account.accountId,
        sim:       account.sim,
      });
      return res.json({
        success: true,
        message: `Found ${result.length} account(s).`,
        accounts: result,   // full list so user can see their account IDs
      });
    } else {
      result = { message: 'Connection test not supported for this broker.' };
    }
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`[accounts/test] ${err.message}`);
    return res.status(502).json({ error: err.message });
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const account = db.get('accounts').find({ id: req.params.id, userId: req.user.id }).value();
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  db.get('accounts').remove({ id: req.params.id }).write();
  return res.json({ message: 'Account removed.' });
});

module.exports = router;
