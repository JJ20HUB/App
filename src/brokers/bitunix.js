'use strict';
/**
 * bitunix.js  –  Bitunix broker adapter (USDT-M Futures)
 *
 * Bitunix Futures REST API: https://fapi.bitunix.com
 *
 * Auth: HMAC-SHA256 double-hash
 *   1. digest  = SHA256(nonce + timestamp + apiKey + queryString + bodyString)
 *   2. sign    = HMAC-SHA256(digest, secretKey)  →  hex string
 *   Headers: api-key, sign, nonce, timestamp, Content-Type
 *
 * brokerConfig keys:
 *   {
 *     apiKey:    'your_bitunix_api_key',
 *     secretKey: 'your_bitunix_secret_key',
 *     marginCoin: 'USDT'          // optional, default USDT
 *   }
 *
 * NOTE: Bitunix uses symbol names like "BTCUSDT", "ETHUSDT" etc.
 */

const axios  = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const BASE_URL = 'https://fapi.bitunix.com';

// ── Signature helpers ─────────────────────────────────────────────────────────

function makeNonce(len = 8) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

/**
 * Build signed headers for a Bitunix request.
 * @param {string} apiKey
 * @param {string} secretKey
 * @param {string} queryString  – URL query string WITHOUT leading '?' ('' if none)
 * @param {string} bodyString   – JSON-stringified body ('' for GET)
 */
function buildHeaders(apiKey, secretKey, queryString = '', bodyString = '') {
  const nonce     = makeNonce();
  const timestamp = Date.now().toString();

  // Step 1: SHA-256 of the concatenation
  const prehash = nonce + timestamp + apiKey + queryString + bodyString;
  const digest  = crypto.createHash('sha256').update(prehash).digest('hex');

  // Step 2: HMAC-SHA-256 of the digest, keyed with secretKey
  const sign = crypto.createHmac('sha256', secretKey).update(digest).digest('hex');

  return {
    'Content-Type': 'application/json',
    'api-key':      apiKey,
    sign,
    nonce,
    timestamp,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkResponse(data, context) {
  // Bitunix returns { code: 0, msg: 'success', data: {...} } on success
  if (data.code !== 0) {
    throw new Error(`[Bitunix] ${context}: code ${data.code} – ${data.msg || 'Unknown error'}`);
  }
  return data.data;
}

// ── Place Order ───────────────────────────────────────────────────────────────
/**
 * @param {object} order – normalised order from alertParser
 *   { action, ticker, qty, price, orderType, sl, tp, slTicks, tpTicks, comment }
 * @param {object} cfg   – brokerConfig from webhook record
 */
async function placeOrder(order, cfg) {
  if (!cfg.apiKey || !cfg.secretKey) {
    throw new Error('[Bitunix] apiKey and secretKey are required in brokerConfig.');
  }

  // Bitunix side: BUY | SELL
  const sideMap = { buy: 'BUY', long: 'BUY', sell: 'SELL', short: 'SELL', close: 'SELL' };
  const side = sideMap[(order.action || '').toLowerCase()] || 'BUY';

  // tradeSide: OPEN (new position) | CLOSE (reduce/close)
  const tradeSide = (order.action || '').toLowerCase() === 'close' ? 'CLOSE' : 'OPEN';

  // orderType: MARKET | LIMIT
  const isLimit   = (order.orderType || 'market').toLowerCase() === 'limit' && order.price != null;
  const orderType = isLimit ? 'LIMIT' : 'MARKET';

  const body = {
    symbol:     order.ticker,
    side,
    tradeSide,
    orderType,
    qty:        String(order.qty),
    marginCoin: cfg.marginCoin || 'USDT',
    ...(isLimit && { price: String(order.price) }),
    effect:     'GTC',
    clientId:   order.comment || undefined,
  };

  // Stop-loss / Take-profit (price-based; Bitunix uses preset TP/SL on order)
  if (order.sl != null)  body.presetStopLossPrice     = String(order.sl);
  if (order.tp != null)  body.presetTakeProfitPrice   = String(order.tp);

  const bodyString = JSON.stringify(body);
  const path       = '/api/v1/futures/trade/place_order';
  const headers    = buildHeaders(cfg.apiKey, cfg.secretKey, '', bodyString);

  logger.info(`[Bitunix] Placing order: ${bodyString}`);

  const res = await axios.post(`${BASE_URL}${path}`, body, { headers });
  const result = checkResponse(res.data, 'place_order');

  logger.info(`[Bitunix] Order response: ${JSON.stringify(result)}`);
  return result;
}

// ── Get Accounts (balance list) ───────────────────────────────────────────────
/**
 * Used by the accounts page to verify credentials and show balance.
 * Returns an array normalised to { id, name, balance }.
 */
async function getAccounts(cfg) {
  if (!cfg.apiKey || !cfg.secretKey) {
    throw new Error('[Bitunix] apiKey and secretKey are required.');
  }

  const path    = '/api/v1/futures/account';
  const headers = buildHeaders(cfg.apiKey, cfg.secretKey, '', '');

  const res    = await axios.get(`${BASE_URL}${path}`, { headers });
  const result = checkResponse(res.data, 'account');

  // result is an array of margin-coin account objects
  const accounts = Array.isArray(result) ? result : [result];
  return accounts.map(a => ({
    id:      a.marginCoin || 'USDT',
    name:    `Bitunix ${a.marginCoin || 'USDT'} Account`,
    balance: a.available ?? a.equity ?? null,
  }));
}

// ── Get Positions ─────────────────────────────────────────────────────────────
async function getPositions(cfg) {
  if (!cfg.apiKey || !cfg.secretKey) {
    throw new Error('[Bitunix] apiKey and secretKey are required.');
  }

  const path    = '/api/v1/futures/position/get_pending_positions';
  const headers = buildHeaders(cfg.apiKey, cfg.secretKey, '', '');

  const res    = await axios.get(`${BASE_URL}${path}`, { headers });
  return checkResponse(res.data, 'positions');
}

module.exports = { placeOrder, getAccounts, getPositions };
