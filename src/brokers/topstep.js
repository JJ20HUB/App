'use strict';
/**
 * topstep.js  (Topstep broker adapter)
 *
 * Topstep funded accounts execute via the Tradovate platform.
 * This adapter authenticates with Tradovate's REST API and places orders.
 *
 * Tradovate API docs: https://api.tradovate.com
 *
 * brokerConfig keys expected per webhook:
 *   {
 *     username:   'your_tradovate_username',
 *     password:   'your_tradovate_password',
 *     appId:      'your_app_id',        // from Tradovate developer portal
 *     appVersion: '1.0',
 *     accountId:  12345,                // numeric Tradovate account ID
 *     sim:        false                 // true → demo.tradovateapi.com
 *   }
 */

const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config');

// Token cache: keyed by username to avoid re-authenticating every request
const tokenCache = {};

function getBaseUrl(sim) {
  return sim
    ? 'https://demo.tradovateapi.com/v1'
    : 'https://live.tradovateapi.com/v1';
}

/**
 * Authenticate and return an access token.
 * Caches the token until 60 seconds before expiry.
 */
async function getAccessToken(cfg) {
  const cacheKey = `${cfg.username}:${cfg.sim ? 'sim' : 'live'}`;
  const cached = tokenCache[cacheKey];
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const baseUrl = getBaseUrl(cfg.sim);
  const payload = {
    name: cfg.username,
    password: cfg.password,
    appId: cfg.appId || config.tradovate.appId,
    appVersion: cfg.appVersion || config.tradovate.appVersion,
    clientId: cfg.clientId || cfg.appId || config.tradovate.appId,
  };

  const res = await axios.post(`${baseUrl}/auth/accesstokenrequest`, payload);
  const { accessToken, expirationTime } = res.data;

  tokenCache[cacheKey] = {
    accessToken,
    expiresAt: new Date(expirationTime).getTime(),
  };

  return accessToken;
}

/**
 * Place an order on Tradovate/Topstep.
 *
 * @param {object} order   - normalised order from alertParser
 * @param {object} cfg     - brokerConfig from the webhook record
 * @returns {object}       - Tradovate order response
 */
async function placeOrder(order, cfg) {
  const token = await getAccessToken(cfg);
  const baseUrl = getBaseUrl(cfg.sim);

  // Map normalised action → Tradovate buy/sell
  const actionMap = { buy: 'Buy', sell: 'Sell', close: 'Sell' };
  const tradovateAction = actionMap[order.action] || 'Buy';

  // Determine order type
  const isLimit = order.orderType === 'limit' && order.price != null;

  const body = {
    accountSpec: cfg.username,
    accountId: cfg.accountId,
    action: tradovateAction,
    symbol: order.ticker,
    orderQty: order.qty,
    orderType: isLimit ? 'Limit' : 'Market',
    ...(isLimit && { price: order.price }),
    timeInForce: 'DAY',
    isAutomated: true,
  };

  logger.info(`[Topstep] Placing order: ${JSON.stringify(body)}`);

  const res = await axios.post(`${baseUrl}/order/placeorder`, body, {
    headers: { Authorization: `Bearer ${token}` },
  });

  logger.info(`[Topstep] Response: ${JSON.stringify(res.data)}`);
  return res.data;
}

/**
 * List all accounts for the authenticated user.
 * Useful for discovering the numeric accountId.
 */
async function getAccounts(cfg) {
  const token = await getAccessToken(cfg);
  const baseUrl = getBaseUrl(cfg.sim);
  const res = await axios.get(`${baseUrl}/account/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Return an array of { id, name, nickname, active, ... }
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * List open positions for reconciliation.
 */
async function getPositions(cfg) {
  const token = await getAccessToken(cfg);
  const baseUrl = getBaseUrl(cfg.sim);
  const res = await axios.get(`${baseUrl}/position/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

module.exports = { placeOrder, getAccounts, getPositions };
