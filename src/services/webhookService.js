'use strict';
/**
 * webhookService.js
 * Handles generation, storage, and validation of per-user webhook tokens.
 *
 * Each webhook URL format:
 *   POST  http://<host>/webhook/<token>
 *
 * Tokens are crypto-random UUIDs. Users can have multiple webhooks
 * (one per strategy/indicator).
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../models/db');
const config = require('../config');

/**
 * Create a new webhook for a user.
 * @param {string} userId
 * @param {string} label      - Human-readable name for this webhook/strategy
 * @param {string} broker     - 'topstep' | 'lucid'
 * @param {object} brokerConfig - broker credentials/settings (stored per webhook)
 * @returns {object} webhook record
 */
function createWebhook(userId, label, broker, brokerConfig = {}, linkedAccountId = null) {
  const token = uuidv4().replace(/-/g, ''); // 32-char hex token
  const webhook = {
    id: uuidv4(),
    token,
    userId,
    label,
    broker,
    brokerConfig,  // { apiKey, apiSecret, accountId, ... }
    linkedAccountId,  // ID of saved account record (credentials resolved at trigger time)
    active: true,
    createdAt: new Date().toISOString(),
    lastTriggered: null,
  };

  db.get('webhooks').push(webhook).write();
  return webhook;
}

/**
 * Get all webhooks belonging to a user.
 * @param {string} userId
 */
function getUserWebhooks(userId) {
  return db.get('webhooks').filter({ userId }).value();
}

/**
 * Find a webhook by its token.
 * @param {string} token
 */
function findByToken(token) {
  return db.get('webhooks').find({ token }).value();
}

/**
 * Delete / deactivate a webhook.
 * @param {string} webhookId
 * @param {string} userId     - ownership check
 */
function deleteWebhook(webhookId, userId) {
  const webhook = db.get('webhooks').find({ id: webhookId, userId }).value();
  if (!webhook) return false;
  db.get('webhooks').remove({ id: webhookId }).write();
  return true;
}

/**
 * Update a webhook's broker config (e.g. new API keys).
 */
function updateWebhook(webhookId, userId, updates) {
  const webhook = db.get('webhooks').find({ id: webhookId, userId }).value();
  if (!webhook) return null;
  const allowed = ['label', 'broker', 'brokerConfig', 'active', 'linkedAccountId'];
  allowed.forEach((key) => {
    if (updates[key] !== undefined) webhook[key] = updates[key];
  });
  db.get('webhooks').find({ id: webhookId }).assign(webhook).write();
  return webhook;
}

/**
 * Mark a webhook as triggered (updates lastTriggered timestamp).
 */
function touchWebhook(token) {
  db.get('webhooks')
    .find({ token })
    .assign({ lastTriggered: new Date().toISOString() })
    .write();
}

/**
 * Build the full public URL for a webhook token.
 * @param {string} token
 * @param {string} [base]  - Override base URL (e.g. derived from HTTP request host).
 *                          Falls back to config.publicBaseUrl if not supplied.
 */
function buildWebhookUrl(token, base) {
  const rootUrl = (base || config.publicBaseUrl).replace(/\/+$/, '');
  return `${rootUrl}/webhook/${token}`;
}

module.exports = {
  createWebhook,
  getUserWebhooks,
  findByToken,
  deleteWebhook,
  updateWebhook,
  touchWebhook,
  buildWebhookUrl,
};
