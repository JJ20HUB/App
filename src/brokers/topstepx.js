'use strict';
/**
 * topstepx.js  –  TopstepX broker adapter
 *
 * TopstepX uses the ProjectX Gateway API (api.topstepx.com).
 *
 * Auth flow:
 *   POST /api/Auth/loginKey  { userName, apiKey }  →  { token }
 *   Token valid 24 h; cached and refreshed automatically.
 *
 * brokerConfig keys:
 *   {
 *     userName:  'your_topstepx_username',
 *     apiKey:    'your_api_key',            // from TopstepX settings
 *     accountId: 12345,                     // numeric account ID
 *     sim:       false                      // true → demo gateway
 *   }
 */

const axios = require('axios');
const logger = require('../utils/logger');

const LIVE_BASE = 'https://api.topstepx.com';
const DEMO_BASE = 'https://gateway-api-demo.s2f.projectx.com';

// ProjectX Gateway error codes
const ERROR_CODES = {
  0:  'Success',
  1:  'Unknown error',
  2:  'Login required / session expired',
  3:  'Invalid credentials — check your username and API key',
  4:  'Account not found',
  5:  'Insufficient permissions',
  6:  'Feature not available on this account',
  7:  'Too many requests — rate limited',
  8:  'Server error — try again later',
};

function apiError(context, data) {
  const msg = data.errorMessage
    || ERROR_CODES[data.errorCode]
    || `Error code ${data.errorCode}`;
  return new Error(`[TopstepX] ${context}: ${msg}`);
}

// In-memory token cache keyed by userName
const tokenCache = {};

function getBaseUrl(cfg) {
  return cfg.sim ? DEMO_BASE : LIVE_BASE;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
async function getToken(cfg) {
  const key = `${cfg.userName}:${cfg.sim ? 'demo' : 'live'}`;
  const cached = tokenCache[key];

  // Reuse token if still valid (with 5-min buffer)
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }

  const base = getBaseUrl(cfg);
  const res  = await axios.post(`${base}/api/Auth/loginKey`, {
    userName: cfg.userName,
    apiKey:   cfg.apiKey,
  });

  if (!res.data.success) {
    throw apiError('Authentication failed', res.data);
  }

  tokenCache[key] = {
    token:     res.data.token,
    expiresAt: Date.now() + 23 * 60 * 60 * 1000, // ~23 h
  };

  logger.info(`[TopstepX] Authenticated user ${cfg.userName}`);
  return res.data.token;
}

function authHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

// ── Order type mapping ────────────────────────────────────────────────────────
//  1=Limit  2=Market  3=StopLimit  4=Stop  5=TrailingStop
function resolveOrderType(order) {
  const ot = (order.orderType || 'market').toLowerCase();
  if (ot === 'limit')                      return 1;
  if (ot === 'stop' || ot === 'stop_market') return 4;
  if (ot === 'stop_limit')                 return 3;
  return 2; // market default
}

// side: 0=Buy  1=Sell
function resolveSide(action) {
  const a = (action || '').toLowerCase();
  if (a === 'buy' || a === 'long')  return 0;
  return 1; // sell / close
}

// ── Place Order ───────────────────────────────────────────────────────────────
/**
 * @param {object} order   – normalised order from alertParser
 *   { action, ticker, qty, price, orderType, comment, sl, tp, slTicks, tpTicks }
 * @param {object} cfg     – brokerConfig from webhook record
 */
async function placeOrder(order, cfg) {
  const token = await getToken(cfg);
  const base  = getBaseUrl(cfg);

  const side      = resolveSide(order.action);
  const orderType = resolveOrderType(order);
  const isLimit   = orderType === 1;
  const isStop    = orderType === 3 || orderType === 4;

  const body = {
    accountId:  parseInt(cfg.accountId, 10) || cfg.accountId,
    contractId: order.ticker,         // e.g. "CON.F.US.MES.M26" — must be TopstepX contract ID, not TradingView ticker
    type:       orderType,
    side,
    size:       order.qty,
    limitPrice: isLimit ? (order.price || null) : null,
    stopPrice:  isStop  ? (order.price || null) : null,
    customTag:  order.comment || null,
  };

  // Stop-loss bracket (ticks or price)
  if (order.slTicks) {
    body.stopLossBracket = { ticks: parseInt(order.slTicks, 10), type: 1 };
  } else if (order.sl) {
    body.stopLossBracket = { price: parseFloat(order.sl), type: 2 };
  }

  // Take-profit bracket (ticks or price)
  if (order.tpTicks) {
    body.takeProfitBracket = { ticks: parseInt(order.tpTicks, 10), type: 1 };
  } else if (order.tp) {
    body.takeProfitBracket = { price: parseFloat(order.tp), type: 2 };
  }

  logger.info(`[TopstepX] Placing order: ${JSON.stringify(body)}`);
  const res = await axios.post(`${base}/api/Order/place`, body, {
    headers: authHeaders(token),
  });

  if (!res.data.success) {
    throw apiError('Order placement failed', res.data);
  }

  logger.info(`[TopstepX] Order placed, orderId=${res.data.orderId}`);
  return res.data;
}

// ── Account search ────────────────────────────────────────────────────────────
async function getAccounts(cfg) {
  const token = await getToken(cfg);
  const base  = getBaseUrl(cfg);
  const res   = await axios.post(`${base}/api/Account/search`,
    { onlyActiveAccounts: true },
    { headers: authHeaders(token) }
  );
  if (!res.data.success) throw apiError('Account search failed', res.data);
  return res.data.accounts || [];
}

// ── Contract search ───────────────────────────────────────────────────────────
// Topstep evaluation accounts always use live:false for contract searches
// even though the API base URL is api.topstepx.com (live gateway).
async function getContracts(cfg, searchText) {
  const token = await getToken(cfg);
  const base  = getBaseUrl(cfg);
  const res   = await axios.post(`${base}/api/Contract/search`,
    { live: false, searchText: searchText || '' },
    { headers: authHeaders(token) }
  );
  if (!res.data.success) throw apiError('Contract search failed', res.data);
  return (res.data.contracts || []).filter(c => c.activeContract);
}

// ── Open positions ────────────────────────────────────────────────────────────
async function getPositions(cfg) {
  const token = await getToken(cfg);
  const base  = getBaseUrl(cfg);
  const res   = await axios.post(`${base}/api/Position/searchOpen`,
    { accountId: parseInt(cfg.accountId, 10) || cfg.accountId },
    { headers: authHeaders(token) }
  );
  if (!res.data.success) throw apiError('Position search failed', res.data);
  return res.data.positions || [];
}

// ── Trade history ─────────────────────────────────────────────────────────────
async function getTrades(cfg, startTimestamp) {
  const token = await getToken(cfg);
  const base  = getBaseUrl(cfg);
  const start = startTimestamp || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res   = await axios.post(`${base}/api/Trade/search`,
    { accountId: parseInt(cfg.accountId, 10) || cfg.accountId, startTimestamp: start },
    { headers: authHeaders(token) }
  );
  if (!res.data.success) throw apiError('Trade search failed', res.data);
  return res.data.trades || [];
}

// ── Historical bars ───────────────────────────────────────────────────────────
/**
 * Fetch historical OHLCV + bid/ask volume bars from TopStepX history API.
 *
 * @param {object} cfg          – broker config ({ userName, apiKey, accountId, sim })
 * @param {string} contractId   – e.g. "CON.F.US.MES.M26"
 * @param {object} [opts]
 * @param {number} [opts.unit]       – bar unit: 1=Minute 2=Day 3=Week 4=Month (default 1)
 * @param {number} [opts.unitNumber] – bar size in that unit (default 1 → 1-min bars)
 * @param {number} [opts.limit]      – max bars to return (default 500)
 * @param {string} [opts.startTime]  – ISO string start (default: 8 h ago)
 * @param {string} [opts.endTime]    – ISO string end   (default: now)
 * @returns {Array} bars shaped as OrderFlowEngine.ingest() expects:
 *   { symbol, time, open, high, low, close, volume, askVol, bidVol }
 */
async function getHistoricalBars(cfg, contractId, opts = {}) {
  const token = await getToken(cfg);
  const base  = getBaseUrl(cfg);

  const unit       = opts.unit       ?? 1;  // 1 = Minute
  const unitNumber = opts.unitNumber ?? 1;  // 1-minute bars
  const limit      = opts.limit      ?? 500;
  const endTime    = opts.endTime    ?? new Date().toISOString();
  const startTime  = opts.startTime  ?? new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

  const res = await axios.post(
    `${base}/api/History/retrieve`,
    {
      contractId,
      live:        !cfg.sim,
      startTime,
      endTime,
      unit,
      unitNumber,
      limit,
    },
    { headers: authHeaders(token) }
  );

  if (!res.data.success) throw apiError('History retrieve failed', res.data);

  const rawBars = res.data.bars || [];
  return rawBars.map(b => ({
    symbol:  contractId,
    time:    b.timestamp || b.t,
    open:    b.open  || b.o,
    high:    b.high  || b.h,
    low:     b.low   || b.l,
    close:   b.close || b.c,
    volume:  b.volume       || b.vol || b.v || 0,
    // ProjectX history bars expose offer/bid volume split when available
    askVol:  b.offerVolume  || b.upVolume   || b.buyVolume  || Math.round((b.volume || 0) * 0.5),
    bidVol:  b.bidVolume    || b.downVolume || b.sellVolume || Math.round((b.volume || 0) * 0.5),
  }));
}

module.exports = { placeOrder, getAccounts, getContracts, getPositions, getTrades, getHistoricalBars };
