'use strict';
/**
 * webhooks.js  (routes)
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  AUTHENTICATED (requires Bearer JWT)                                    │
 * │  POST   /webhooks            - generate a new webhook                   │
 * │  GET    /webhooks            - list all webhooks for the current user    │
 * │  PUT    /webhooks/:id        - update webhook label / broker config      │
 * │  DELETE /webhooks/:id        - delete a webhook                         │
 * │                                                                         │
 * │  PUBLIC (no auth — called by TradingView)                               │
 * │  POST   /webhook/:token      - receive a TradingView alert & execute    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const webhookService = require('../services/webhookService');
const orderService  = require('../services/orderService');
const db            = require('../models/db');
const { supportedBrokers } = require('../brokers');
const config = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

// ── Rate limiter for the public webhook endpoint ──────────────────────────────
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,              // 1 minute window
  max: config.webhookRateLimit,     // default: 60 requests/min per token
  keyGenerator: (req) => req.params.token || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests – please slow down your alerts.' },
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC  –  TradingView alert receiver
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /webhook/:token
 *
 * TradingView sends an HTTP POST to this URL when an alert fires.
 * The webhook token in the URL identifies the user + broker.
 *
 * Supported body formats:
 *   1. JSON:  { "action": "buy", "ticker": "ES", "qty": 1, "price": 5250.00 }
 *   2. Text:  "buy ES 1"
 *
 * TradingView dynamic variables you can use in the alert message:
 *   {{strategy.order.action}}   → "buy" or "sell"
 *   {{ticker}}                  → symbol name
 *   {{close}}                   → bar close price
 *   {{strategy.order.contracts}} → position size
 */
router.post('/webhook/:token', webhookLimiter, async (req, res) => {
  const { token } = req.params;

  // 1. Lookup webhook record
  const webhook = webhookService.findByToken(token);
  if (!webhook) {
    logger.warn(`[webhook] Unknown token: ${token} from ${req.ip}`);
    return res.status(404).json({ error: 'Webhook not found.' });
  }
  if (!webhook.active) {
    return res.status(403).json({ error: 'Webhook is disabled.' });
  }

  // 2. If linked to a saved account, resolve fresh credentials from that account
  let effectiveWebhook = webhook;
  if (webhook.linkedAccountId) {
    const account = db.get('accounts').find({ id: webhook.linkedAccountId, userId: webhook.userId }).value();
    if (!account) {
      return res.status(502).json({ error: 'Linked account not found — please reconnect it in the Accounts tab.' });
    }
    effectiveWebhook = {
      ...webhook,
      broker: account.broker,
      brokerConfig: {
        userName:   account.userName,
        username:   account.userName,
        apiKey:     account.apiKey,
        secretKey:  account.secretKey,
        password:   account.password,
        appId:      account.appId,
        appVersion: account.appVersion,
        accountId:  account.accountId,
        sim:        account.sim,
      },
    };
  }

  // 3. Process the alert
  try {
    const rawBody = req.body;
    const result = await orderService.processAlert(effectiveWebhook, rawBody);
    return res.json({
      success: true,
      orderId: result.orderId,
      broker: effectiveWebhook.broker,
      order: result.order,
    });
  } catch (err) {
    logger.error(`[webhook] Processing error for token ${token}: ${err.message}`);
    return res.status(422).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTHENTICATED  –  webhook management
// ═══════════════════════════════════════════════════════════════════════════════

// Apply auth to all routes below
router.use(authMiddleware);

/**
 * POST /webhooks
 * Body: { label, broker, brokerConfig }
 * Creates a new webhook and returns the full webhook URL.
 *
 * Example brokerConfig for Topstep:
 *   {
 *     "username":  "my_tradovate_user",
 *     "password":  "my_tradovate_pass",
 *     "appId":     "my_app_id",
 *     "accountId": 123456,
 *     "sim":       false
 *   }
 *
 * Example brokerConfig for Lucid:
 *   {
 *     "apiKey":    "lm_key_xxxxx",
 *     "apiSecret": "lm_secret_xxxxx",
 *     "accountId": "ACC123456"
 *   }
 */
router.post('/webhooks', (req, res) => {
  try {
    const { label, broker, brokerConfig, linkedAccountId } = req.body;

    // Resolve broker + config from linked account if provided
    let resolvedBroker = broker;
    let resolvedBrokerConfig = brokerConfig || {};

    if (linkedAccountId) {
      const account = db.get('accounts').find({ id: linkedAccountId, userId: req.user.id }).value();
      if (!account) {
        return res.status(404).json({ error: 'Linked account not found.' });
      }
      resolvedBroker = account.broker;
      resolvedBrokerConfig = {}; // credentials resolved live at trigger time
    }

    if (!label || !resolvedBroker) {
      return res.status(400).json({ error: '"label" and a broker or linked account are required.' });
    }
    if (!supportedBrokers.includes(resolvedBroker.toLowerCase())) {
      return res.status(400).json({
        error: `Unsupported broker "${resolvedBroker}". Choose: ${supportedBrokers.join(', ')}`,
      });
    }

    const webhook = webhookService.createWebhook(
      req.user.id,
      label,
      resolvedBroker.toLowerCase(),
      resolvedBrokerConfig,
      linkedAccountId || null
    );

    const webhookUrl = webhookService.buildWebhookUrl(webhook.token, config.publicBaseUrl);

    logger.info(`[webhooks] Created webhook "${label}" for user ${req.user.username}`);

    return res.status(201).json({
      message: 'Webhook created.',
      webhook: {
        id: webhook.id,
        token: webhook.token,
        label: webhook.label,
        broker: webhook.broker,
        active: webhook.active,
        createdAt: webhook.createdAt,
        webhookUrl,
        // Paste this URL into TradingView → Alert → Notifications → Webhook URL
        tradingViewSetup: {
          webhookUrl,
          alertMessageFormat: {
            action: '{{strategy.order.action}}',
            ticker: '{{ticker}}',
            price: '{{close}}',
            qty: '{{strategy.order.contracts}}',
            comment: '{{strategy.order.comment}}',
          },
          note: 'Set your TradingView alert Webhook URL to the above webhookUrl, and paste the alertMessageFormat JSON into the alert message body.',
        },
      },
    });
  } catch (err) {
    logger.error(`[webhooks/create] ${err.message}`);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /webhooks
 * Returns all webhooks for the authenticated user (broker credentials redacted).
 */
router.get('/webhooks', (req, res) => {
  try {
    const webhooks = webhookService.getUserWebhooks(req.user.id);
    const safe = webhooks.map((w) => ({
      id: w.id,
      token: w.token,
      label: w.label,
      broker: w.broker,
      active: w.active,
      createdAt: w.createdAt,
      lastTriggered: w.lastTriggered,
      linkedAccountId: w.linkedAccountId || null,
      webhookUrl: webhookService.buildWebhookUrl(w.token, config.publicBaseUrl),
      // Only expose whether credentials are configured, not the actual values
      credentialsConfigured: !!(w.linkedAccountId || Object.keys(w.brokerConfig || {}).length > 0),
    }));
    return res.json({ webhooks: safe });
  } catch (err) {
    logger.error(`[webhooks/list] ${err.message}`);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * PUT /webhooks/:id
 * Update label, brokerConfig, or enabled/disabled status.
 */
router.put('/webhooks/:id', (req, res) => {
  try {
    const { label, broker, brokerConfig, active, linkedAccountId } = req.body;
    const updated = webhookService.updateWebhook(req.params.id, req.user.id, {
      label,
      broker: broker ? broker.toLowerCase() : undefined,
      brokerConfig,
      active,
      linkedAccountId,
    });
    if (!updated) {
      return res.status(404).json({ error: 'Webhook not found or not owned by you.' });
    }
    return res.json({ message: 'Webhook updated.', webhook: { id: updated.id, label: updated.label, broker: updated.broker, active: updated.active } });
  } catch (err) {
    logger.error(`[webhooks/update] ${err.message}`);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * DELETE /webhooks/:id
 */
router.delete('/webhooks/:id', (req, res) => {
  try {
    const deleted = webhookService.deleteWebhook(req.params.id, req.user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Webhook not found or not owned by you.' });
    }
    return res.json({ message: 'Webhook deleted.' });
  } catch (err) {
    logger.error(`[webhooks/delete] ${err.message}`);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
