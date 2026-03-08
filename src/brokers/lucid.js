'use strict';
/**
 * lucid.js  (Lucid Markets broker adapter)
 *
 * Lucid Markets REST API integration.
 *
 * brokerConfig keys expected per webhook:
 *   {
 *     apiKey:    'your_lucid_api_key',
 *     apiSecret: 'your_lucid_api_secret',
 *     accountId: 'ACC123456',
 *     baseUrl:   'https://api.lucidmarkets.com'   // optional override
 *   }
 *
 * Lucid Markets API reference: https://docs.lucidmarkets.com
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Build a signed request for Lucid's HMAC-authenticated endpoints.
 * Lucid uses:   Signature = HMAC-SHA256(timestamp + method + path + body, secret)
 */
function buildHeaders(cfg, method, path, bodyStr = '') {
  const timestamp = Date.now().toString();
  const prehash = `${timestamp}${method.toUpperCase()}${path}${bodyStr}`;
  const signature = crypto
    .createHmac('sha256', cfg.apiSecret)
    .update(prehash)
    .digest('hex');

  return {
    'Content-Type': 'application/json',
    'LM-API-KEY': cfg.apiKey,
    'LM-TIMESTAMP': timestamp,
    'LM-SIGNATURE': signature,
  };
}

function getBaseUrl(cfg) {
  return (cfg.baseUrl || config.lucid.baseUrl).replace(/\/$/, '');
}

/**
 * Place an order on Lucid Markets.
 *
 * @param {object} order   - normalised order from alertParser
 * @param {object} cfg     - brokerConfig from the webhook record
 * @returns {object}       - Lucid order response
 */
async function placeOrder(order, cfg) {
  const baseUrl = getBaseUrl(cfg);
  const path = `/v1/orders`;

  // Map our normalised action to Lucid's side field
  const sideMap = { buy: 'BUY', sell: 'SELL', close: 'SELL' };
  const side = sideMap[order.action] || 'BUY';

  const isLimit = order.orderType === 'limit' && order.price != null;

  const body = {
    accountId: cfg.accountId,
    symbol: order.ticker,
    side,
    quantity: order.qty,
    type: isLimit ? 'LIMIT' : 'MARKET',
    ...(isLimit && { price: order.price }),
    timeInForce: 'GTC',
    comment: order.comment || 'TradingView webhook',
  };

  const bodyStr = JSON.stringify(body);
  const headers = buildHeaders(cfg, 'POST', path, bodyStr);

  logger.info(`[Lucid] Placing order: ${bodyStr}`);

  const res = await axios.post(`${baseUrl}${path}`, body, { headers });

  logger.info(`[Lucid] Response: ${JSON.stringify(res.data)}`);
  return res.data;
}

/**
 * Get open positions from Lucid Markets.
 */
async function getPositions(cfg) {
  const baseUrl = getBaseUrl(cfg);
  const path = `/v1/positions?accountId=${cfg.accountId}`;
  const headers = buildHeaders(cfg, 'GET', path);

  const res = await axios.get(`${baseUrl}${path}`, { headers });
  return res.data;
}

/**
 * Get account info / balance.
 */
async function getAccount(cfg) {
  const baseUrl = getBaseUrl(cfg);
  const path = `/v1/accounts/${cfg.accountId}`;
  const headers = buildHeaders(cfg, 'GET', path);

  const res = await axios.get(`${baseUrl}${path}`, { headers });
  return res.data;
}

/**
 * List all accounts for the authenticated user.
 */
async function getAccounts(cfg) {
  const baseUrl = getBaseUrl(cfg);
  const path = `/v1/accounts`;
  const headers = buildHeaders(cfg, 'GET', path);

  const res = await axios.get(`${baseUrl}${path}`, { headers });
  const raw = res.data;
  // Lucid may return an array or { accounts: [...] }
  const list = Array.isArray(raw) ? raw : (raw.accounts || raw.data || []);
  return list.map(a => ({
    id:      a.id || a.accountId || a.account_id,
    name:    a.name || a.accountName || a.label || String(a.id || a.accountId),
    balance: a.balance ?? a.equity ?? null,
  }));
}

module.exports = { placeOrder, getPositions, getAccount, getAccounts };
