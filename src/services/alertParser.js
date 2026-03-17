'use strict';
/**
 * alertParser.js
 * Parses incoming TradingView webhook payloads into a normalised order object.
 *
 * ─── TRADINGVIEW ALERT MESSAGE FORMAT ───────────────────────────────────────
 * In TradingView, set the alert message body to JSON, for example:
 *
 *   {
 *     "action":   "{{strategy.order.action}}",   // "buy" | "sell"
 *     "ticker":   "{{ticker}}",                  // e.g. "ESH2026"
 *     "price":    {{close}},                     // execution price hint
 *     "qty":      {{strategy.order.contracts}},  // number of contracts/lots
 *     "comment":  "{{strategy.order.comment}}"   // optional label
 *   }
 *
 * The parser also supports a simpler plain-text format:
 *   "buy ES 2"  →  { action: 'buy', ticker: 'ES', qty: 2 }
 *
 * ────────────────────────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');

const VALID_ACTIONS = new Set(['buy', 'sell', 'long', 'short', 'close', 'flat']);

/**
 * Normalise action strings to standard "buy" / "sell" / "close".
 */
function normaliseAction(raw) {
  const a = (raw || '').toLowerCase().trim();
  if (a === 'buy' || a === 'long') return 'buy';
  if (a === 'sell' || a === 'short') return 'sell';
  if (a === 'close' || a === 'flat' || a === 'exit') return 'close';
  return null;
}

/**
 * Parse a TradingView webhook body into a normalised order.
 *
 * Accepts:
 *   - JSON string / object
 *   - Plain-text "action ticker qty" format
 *
 * Returns: { action, ticker, qty, price, orderType, comment } or throws.
 */
function parseAlert(body) {
  let parsed;

  // ── 1. Try JSON ─────────────────────────────────────────────────────────
  if (typeof body === 'object' && body !== null) {
    parsed = body;
  } else if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        throw new Error(`Invalid JSON payload: ${e.message}`);
      }
    } else {
      // ── 2. Plain-text fallback: "buy ES 2" ─────────────────────────────
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) {
        throw new Error('Plain-text alert must be: <action> <ticker> [qty]');
      }
      parsed = {
        action: parts[0],
        ticker: parts[1],
        qty: parts[2] ? parseFloat(parts[2]) : 1,
      };
    }
  } else {
    throw new Error('Unsupported alert body type.');
  }

  // ── 3. Validate & normalise ──────────────────────────────────────────────
  const action = normaliseAction(parsed.action);
  if (!action) {
    throw new Error(
      `Unknown action "${parsed.action}". Valid: buy, sell, long, short, close, flat.`
    );
  }

  const ticker = (parsed.ticker || parsed.symbol || '').toString().toUpperCase().trim();
  if (!ticker) {
    throw new Error('Alert missing "ticker" or "symbol" field.');
  }

  const rawQty = parsed.qty ?? parsed.contracts ?? parsed.size ?? null;
  const qty = rawQty !== null ? parseFloat(rawQty) : null;
  if (qty !== null && (isNaN(qty) || qty <= 0)) {
    throw new Error(`Invalid quantity: "${parsed.qty}".`);
  }

  const price     = parsed.price     ? parseFloat(parsed.price)     : null;
  const sl        = parsed.sl         ? parseFloat(parsed.sl)         : null;
  const tp        = parsed.tp         ? parseFloat(parsed.tp)         : null;
  const slTicks   = parsed.slTicks    ? parseInt(parsed.slTicks, 10)  : null;
  const tpTicks   = parsed.tpTicks    ? parseInt(parsed.tpTicks, 10)  : null;
  const orderType = parsed.orderType  || (price ? 'limit' : 'market');
  const comment   = parsed.comment    || parsed.strategy || '';
  const signal    = parsed.signal     || parsed.indicator || '';

  const order = { action, ticker, qty, price, orderType, comment, signal, sl, tp, slTicks, tpTicks, _qtyFromAlert: qty !== null };
  logger.debug(`[alertParser] Parsed alert → ${JSON.stringify(order)}`);
  return order;
}

module.exports = { parseAlert };
