'use strict';
/**
 * db.js
 * Flat-file JSON database using lowdb v1 (synchronous, CommonJS).
 * Stores users and webhooks between restarts.
 */

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Ensure the data directory exists
const dbDir = path.dirname(path.resolve(config.db.path));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const adapter = new FileSync(path.resolve(config.db.path));
const db = low(adapter);

// Default schema
db.defaults({
  users:     [],   // { id, username, email, passwordHash, createdAt }
  webhooks:  [],   // { id, token, userId, label, broker, brokerConfig, active, createdAt, lastTriggered }
  orders:    [],   // { id, webhookId, userId, broker, symbol, side, qty, price, status, raw, createdAt }
  accounts:  [],   // { id, userId, broker, label, userName, apiKey, accountId, sim, createdAt }
  trade_log: [],   // { id, userId, accountId, broker, symbol, side, qty, entryPrice, sl, tp, signal, status, pnl, openedAt, closedAt }
  autotrader_bots: [], // { id, userId, name, symbol, accountId, broker, qty, status, ... }
  indicators: [],  // { id, userId, name, description, ticker, alertTemplate, sourceCode, createdAt, updatedAt }
  autotrader_signals: [], // { id, botId, userId, symbol, side, confidence, reasons, metrics, status, timestamp }
}).write();

module.exports = db;
