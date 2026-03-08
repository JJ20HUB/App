'use strict';
/**
 * server.js  –  Apex Trading – Automated Order Routing
 *
 * Entry point. Starts the Express server on port 80 (or process.env.PORT).
 * All TradingView webhooks are received here and routed to Topstep / Lucid.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const logger = require('./utils/logger');

// ── Routes ────────────────────────────────────────────────────────────────────
const authRoutes     = require('./routes/auth');
const webhookRoutes  = require('./routes/webhooks');
const userRoutes     = require('./routes/user');
const accountRoutes      = require('./routes/accounts');
const tradelogRoutes     = require('./routes/tradelog');
const autotraderRoutes   = require('./routes/autotrader');
const indicatorRoutes    = require('./routes/indicators');

const app = express();

// ── Security & parsing middleware ─────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// ── Serve the frontend (static files from /public) ────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// Parse JSON bodies — TradingView sends application/json alerts
app.use(express.json({ type: ['application/json', 'text/plain'] }));

// Also accept plain-text bodies (some TradingView setups send text/plain)
app.use((req, res, next) => {
  if (typeof req.body === 'string') {
    // leave as-is; alertParser handles plain-text
  }
  next();
});

// HTTP request logger
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/', webhookRoutes);        // includes public POST /webhook/:token
app.use('/user', userRoutes);
app.use('/accounts',    accountRoutes);
app.use('/tradelog',    tradelogRoutes);
app.use('/autotrader',  autotraderRoutes);
app.use('/indicators',  indicatorRoutes);

// ── SPA catch-all: serve index.html for all non-API GET requests ─────────────
app.get('*', (req, res, next) => {
  const apiPaths = ['/auth', '/webhooks', '/webhook/', '/user', '/accounts', '/tradelog', '/autotrader', '/indicators', '/health'];
  if (apiPaths.some(p => req.path.startsWith(p))) return next();
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error(`Unhandled error: ${err.stack || err.message}`);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(config.port, '0.0.0.0', () => {
  logger.info(`
╔══════════════════════════════════════════════════════╗
║       Apex Trading – Online                        ║
╠══════════════════════════════════════════════════════╣
║  Port          : ${String(config.port).padEnd(34)}║
║  Environment   : ${String(config.env).padEnd(34)}║
║  Public URL    : ${String(config.publicBaseUrl).padEnd(34)}║
║  Brokers       : TopstepX, Lucid Markets            ║
╚══════════════════════════════════════════════════════╝
  `.trim());
});

module.exports = app;
