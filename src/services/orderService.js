'use strict';
/**
 * orderService.js
 * Orchestrates the full flow: parse alert → execute via broker → log result.
 */

const { v4: uuidv4 } = require('uuid');
const { parseAlert } = require('./alertParser');
const { executeOrder } = require('../brokers');
const { touchWebhook } = require('./webhookService');
const db = require('../models/db');
const logger = require('../utils/logger');

/**
 * Process an incoming TradingView webhook payload end-to-end.
 *
 * @param {object} webhook  - Webhook record from DB (includes broker + brokerConfig)
 * @param {*}      rawBody  - Raw alert body (string or parsed JSON object)
 * @returns {object}        - { order, brokerResponse, orderId }
 */
async function processAlert(webhook, rawBody) {
  // 1. Parse the TradingView alert into a normalised order
  const order = parseAlert(rawBody);

  // 2. Enforce user trade settings (daily limits + default brackets)
  const user = db.get('users').find({ id: webhook.userId }).value();
  const settings = (user && user.tradeSettings) ? user.tradeSettings : {};

  if (settings.dailyProfitTarget != null || settings.dailyLossLimit != null) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    // Only count closed trades with a recorded PnL — open trades have pnl=null
    const todayPnl = db
      .get('trade_log')
      .filter({ userId: webhook.userId })
      .value()
      .filter(t => new Date(t.openedAt) >= todayStart && t.status === 'closed' && t.pnl != null)
      .reduce((sum, t) => sum + t.pnl, 0);

    if (settings.dailyProfitTarget != null && todayPnl >= settings.dailyProfitTarget) {
      throw new Error(
        `Daily profit target of $${settings.dailyProfitTarget} reached ($${todayPnl.toFixed(2)} today). No new trades until tomorrow.`
      );
    }
    if (settings.dailyLossLimit != null && todayPnl <= -Math.abs(settings.dailyLossLimit)) {
      throw new Error(
        `Daily loss limit of $${settings.dailyLossLimit} reached ($${todayPnl.toFixed(2)} today). No new trades until tomorrow.`
      );
    }
  }

  // Enforce max daily trade count
  if (settings.maxDailyTrades != null) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = db
      .get('trade_log')
      .filter({ userId: webhook.userId })
      .value()
      .filter(t => new Date(t.openedAt) >= todayStart).length;

    if (todayCount >= settings.maxDailyTrades) {
      throw new Error(
        `Daily trade limit of ${settings.maxDailyTrades} reached (${todayCount} trades today). No new trades until tomorrow.`
      );
    }
  }

  // Apply default TP/SL ticks and contract size from user settings when the alert doesn't specify them
  if (order) {
    if (order.tpTicks == null && settings.defaultTpTicks != null) {
      order.tpTicks = settings.defaultTpTicks;
    }
    if (order.slTicks == null && settings.defaultSlTicks != null) {
      order.slTicks = settings.defaultSlTicks;
    }
    // Use defaultContracts when the alert did not explicitly provide a quantity
    if (!order._qtyFromAlert && settings.defaultContracts != null) {
      order.qty = settings.defaultContracts;
    }
    // Final fallback: must have at least 1 contract
    if (order.qty == null || order.qty <= 0) {
      order.qty = 1;
    }
    delete order._qtyFromAlert;
  }

  // 3. Execute the order via the appropriate broker
  let brokerResponse;
  try {
    brokerResponse = await executeOrder(webhook.broker, order, webhook.brokerConfig);
  } catch (err) {
    // Log the failure and persist the failed order record
    saveOrder(webhook, order, rawBody, 'failed', null);
    saveTradeLog(webhook, order, null, 'failed');
    logger.error(`[orderService] Broker execution failed: ${err.message}`);
    throw err;
  }

  // 4. Persist the order record as filled/submitted
  const savedOrder = saveOrder(webhook, order, rawBody, 'submitted', brokerResponse);

  // 5. Write a trade log entry
  saveTradeLog(webhook, order, brokerResponse, 'open');

  // 6. Update the webhook's lastTriggered timestamp
  touchWebhook(webhook.token);

  logger.info(`[orderService] Order ${savedOrder.id} submitted via ${webhook.broker}`);
  return { order, brokerResponse, orderId: savedOrder.id };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function saveOrder(webhook, order, rawBody, status, brokerResponse) {
  const record = {
    id: uuidv4(),
    webhookId: webhook.id,
    userId: webhook.userId,
    broker: webhook.broker,
    symbol: order ? order.ticker : null,
    side: order ? order.action : null,
    qty: order ? order.qty : null,
    price: order ? order.price : null,
    orderType: order ? order.orderType : null,
    sl: order ? order.sl : null,
    tp: order ? order.tp : null,
    slTicks: order ? order.slTicks : null,
    tpTicks: order ? order.tpTicks : null,
    signal: order ? order.signal : null,
    status,
    brokerResponse: brokerResponse || null,
    raw: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
    createdAt: new Date().toISOString(),
  };

  db.get('orders').push(record).write();
  return record;
}

function saveTradeLog(webhook, order, brokerResponse, status) {
  if (!order) return;
  const brokerId = brokerResponse ? (brokerResponse.orderId || null) : null;
  const record = {
    id:          uuidv4(),
    userId:      webhook.userId,
    webhookId:   webhook.id,
    broker:      webhook.broker,
    brokerId,
    symbol:      order.ticker,
    side:        order.action,
    qty:         order.qty,
    entryPrice:  order.price,
    sl:          order.sl   || null,
    tp:          order.tp   || null,
    slTicks:     order.slTicks || null,
    tpTicks:     order.tpTicks || null,
    orderType:   order.orderType,
    signal:      order.signal  || order.comment || '',
    status,                          // 'open' | 'failed' | 'closed'
    pnl:         null,
    openedAt:    new Date().toISOString(),
    closedAt:    null,
  };
  db.get('trade_log').push(record).write();
  return record;
}

/**
 * Get order history for a user (most recent first, limited).
 */
function getUserOrders(userId, limit = 100) {
  return db
    .get('orders')
    .filter({ userId })
    .value()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

/**
 * Get trade log for a user (most recent first, limited).
 */
function getUserTradeLog(userId, limit = 200) {
  return db
    .get('trade_log')
    .filter({ userId })
    .value()
    .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt))
    .slice(0, limit);
}

/**
 * Daily summary stats for the dashboard.
 */
function getDailyStats(userId) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayTrades = db
    .get('trade_log')
    .filter({ userId })
    .value()
    .filter(t => new Date(t.openedAt) >= todayStart);

  const total   = todayTrades.length;
  const wins    = todayTrades.filter(t => t.pnl != null && t.pnl > 0).length;
  const losses  = todayTrades.filter(t => t.pnl != null && t.pnl < 0).length;
  const pnl     = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

  return { total, wins, losses, pnl: parseFloat(pnl.toFixed(2)), winRate };
}

module.exports = { processAlert, getUserOrders, getUserTradeLog, getDailyStats };
