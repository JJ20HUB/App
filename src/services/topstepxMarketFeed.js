'use strict';
/**
 * topstepxMarketFeed.js
 *
 * TopStepX Native Market Data Feed
 * ──────────────────────────────────────────────────────────────────────────────
 * Provides real-time 1-minute OHLCV bars (with bid/ask volume split) for an
 * active TopStepX account, using ONLY the credentials already stored in the
 * accounts table: { userName, apiKey, accountId, sim }.
 *
 * No separate Tradovate username/password required.
 *
 * Data source:
 *   TopStepX ProjectX Gateway  →  POST /api/History/retrieve
 *
 * Design:
 *   1. On connect(), resolve the contract ID for the bot's symbol
 *      via GET /api/Contract/search.
 *   2. Fetch the last 300 bars as historical seed (feeds engine + GEX analyzer).
 *   3. Poll the history endpoint every `pollInterval` ms (default 30 s) for
 *      bars newer than the last seen timestamp.
 *   4. Deduplicate by timestamp — never emit the same bar twice.
 *   5. Auto-reconnect on errors with exponential back-off (max 60 s).
 *
 * Interface mirrors TradovateMarketFeed so it's a drop-in replacement:
 *   new TopStepXMarketFeed({ symbol, cfg, onBar, onError })
 *   feed.connect()     → async, starts polling
 *   feed.disconnect()  → stops polling
 *   feed.contractId    → resolved contract ID (available after connect)
 *
 * Bar shape emitted to onBar (compatible with OrderFlowEngine.ingest):
 *   { symbol, time, open, high, low, close, volume, askVol, bidVol }
 */

const { getHistoricalBars, getContracts } = require('../brokers/topstepx');
const logger = require('../utils/logger');

const DEFAULT_POLL_INTERVAL_MS = 30_000;   // 30-second polling
const INITIAL_HISTORY_BARS     = 300;       // bars to fetch on startup
const MAX_BACKOFF_MS           = 60_000;    // max retry delay
const MIN_BACKOFF_MS           = 5_000;     // initial retry delay

class TopStepXMarketFeed {
  /**
   * @param {object}   opts
   * @param {string}   opts.symbol        – e.g. "NQ", "ES", "MES"
   * @param {object}   opts.cfg           – account config (userName, apiKey, accountId, sim)
   * @param {function} opts.onBar         – called with each new/completed bar
   * @param {function} [opts.onError]     – called on non-fatal errors
   * @param {number}   [opts.pollInterval]– ms between polls (default 30000)
   */
  constructor({ symbol, cfg, onBar, onError, pollInterval }) {
    this.symbol       = symbol;
    this.cfg          = cfg;
    this.onBar        = onBar;
    this.onError      = onError || ((e) => logger.error(`[TopStepXMarketFeed] ${e.message}`));
    this.pollInterval = pollInterval || DEFAULT_POLL_INTERVAL_MS;

    this.contractId   = null;
    this._timer       = null;
    this._closed      = false;
    this._lastBarTime = null;       // ISO string of last emitted bar
    this._seenTs      = new Set();  // deduplication by timestamp
    this._backoff     = MIN_BACKOFF_MS;
    this._consecutiveErrors = 0;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  async connect() {
    this._closed = false;
    logger.info(`[TopStepXMarketFeed] Starting for ${this.symbol} (user: ${this.cfg.userName})`);

    try {
      // Step 1 – Resolve contract ID
      await this._resolveContract();

      // Step 2 – Fetch initial history to seed the order flow engine and GEX
      await this._fetchHistory(INITIAL_HISTORY_BARS, true /* seedMode */);

      // Step 3 – Start polling
      this._schedulePoll(this.pollInterval);
      logger.info(`[TopStepXMarketFeed] Live polling started for ${this.symbol} (contract: ${this.contractId}) every ${this.pollInterval / 1000}s`);
    } catch (err) {
      logger.error(`[TopStepXMarketFeed] Connect failed for ${this.symbol}: ${err.message}`);
      this.onError(err);
      // Schedule a reconnect attempt
      if (!this._closed) {
        const delay = this._nextBackoff();
        logger.info(`[TopStepXMarketFeed] Retrying in ${delay / 1000}s…`);
        this._timer = setTimeout(() => this.connect(), delay);
      }
    }
  }

  disconnect() {
    this._closed = true;
    if (this._timer) {
      clearTimeout(this._timer);
      clearInterval(this._timer);
      this._timer = null;
    }
    logger.info(`[TopStepXMarketFeed] Disconnected (${this.symbol})`);
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  async _resolveContract() {
    const contracts = await getContracts(this.cfg, this.symbol);
    if (!contracts || contracts.length === 0) {
      throw new Error(`No active contracts found for symbol "${this.symbol}" on TopStepX`);
    }
    // Prefer the nearest-expiry contract (first result is usually the front month)
    this.contractId = contracts[0].id;
    logger.info(`[TopStepXMarketFeed] Resolved ${this.symbol} → contractId: ${this.contractId} (${contracts[0].name || ''})`);
  }

  /**
   * Fetch bars from TopStepX history API and emit each new one via onBar.
   * @param {number}  limit    – max bars to request
   * @param {boolean} seedMode – if true, emit ALL bars (initial history load)
   */
  async _fetchHistory(limit = 10, seedMode = false) {
    if (!this.contractId) return;

    const opts = {
      unit:       1,   // minute bars
      unitNumber: 1,   // 1-min
      limit,
    };

    // On incremental polls only request bars since the last seen time
    if (!seedMode && this._lastBarTime) {
      opts.startTime = this._lastBarTime;
    }

    const bars = await getHistoricalBars(this.cfg, this.contractId, opts);
    if (!bars || bars.length === 0) return;

    let newCount = 0;
    for (const bar of bars) {
      const ts = typeof bar.time === 'string' ? bar.time : new Date(bar.time).toISOString();

      // Skip bars we've already emitted
      if (this._seenTs.has(ts)) continue;
      this._seenTs.add(ts);

      // Update last bar time (keep as latest)
      if (!this._lastBarTime || ts > this._lastBarTime) {
        this._lastBarTime = ts;
      }

      // Normalise to what OrderFlowEngine.ingest expects
      const normalised = {
        symbol: this.symbol,
        time:   ts,
        open:   parseFloat(bar.open  || bar.o || bar.close),
        high:   parseFloat(bar.high  || bar.h || bar.close),
        low:    parseFloat(bar.low   || bar.l || bar.close),
        close:  parseFloat(bar.close || bar.c || 0),
        volume: parseFloat(bar.volume || bar.vol || 0),
        askVol: parseFloat(bar.askVol || 0),
        bidVol: parseFloat(bar.bidVol || 0),
      };

      this.onBar(normalised);
      newCount++;
    }

    // Prevent the seen-set from growing unboundedly (keep last 2000 entries)
    if (this._seenTs.size > 2000) {
      const arr = [...this._seenTs];
      this._seenTs = new Set(arr.slice(-1500));
    }

    if (seedMode) {
      logger.info(`[TopStepXMarketFeed] Seeded ${newCount} bars for ${this.symbol} (${this.cfg.userName})`);
    } else if (newCount > 0) {
      logger.debug(`[TopStepXMarketFeed] ${newCount} new bar(s) for ${this.symbol}`);
    }

    // Reset error counter on success
    this._consecutiveErrors = 0;
    this._backoff = MIN_BACKOFF_MS;
  }

  _schedulePoll(ms) {
    if (this._closed) return;
    this._timer = setTimeout(async () => {
      if (this._closed) return;
      try {
        await this._fetchHistory(15, false);
      } catch (err) {
        this._consecutiveErrors++;
        const delay = this._nextBackoff();
        logger.warn(
          `[TopStepXMarketFeed] Poll error #${this._consecutiveErrors} for ${this.symbol}: ` +
          `${err.message} — retrying in ${delay / 1000}s`
        );
        this.onError(err);
        // On repeated failures re-resolve the contract (token may have expired)
        if (this._consecutiveErrors >= 3) {
          logger.info(`[TopStepXMarketFeed] Re-authenticating for ${this.symbol}…`);
          try { await this._resolveContract(); } catch (_) {}
        }
        this._schedulePoll(delay);
        return;
      }
      this._schedulePoll(this.pollInterval);
    }, ms);
  }

  _nextBackoff() {
    const delay = Math.min(this._backoff, MAX_BACKOFF_MS);
    this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS);
    return delay;
  }
}

module.exports = { TopStepXMarketFeed };
