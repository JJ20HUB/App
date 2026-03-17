'use strict';
/**
 * topstepxRealtimeFeed.js
 *
 * TopstepX Real-time Market Data via ProjectX Gateway SignalR Hub.
 *
 * Replaces the 30-second polling feed with true ~real-time tick data by
 * subscribing to the ProjectX Gateway SignalR hub. Individual trades are
 * aggregated into 1-minute OHLCV bars (with bid/ask volume split) that
 * feed directly into the OrderFlowEngine — identical bar shape to the
 * polling feed so it is a drop-in replacement.
 *
 * Hub endpoints:
 *   Live:  https://gateway-rtc.s2f.projectx.com/hubs/market-data
 *   Demo:  https://gateway-rtc-demo.s2f.projectx.com/hubs/market-data
 *
 * Auth:  Bearer token obtained from POST /api/Auth/loginKey (same as broker adapter)
 *
 * Subscriptions (invoked on hub after connect):
 *   SubscribeContractTrades(contractId)  → server pushes GatewayTrade events
 *   SubscribeContractQuotes(contractId)  → server pushes GatewayQuote events
 *
 * Trade event shape (GatewayTrade):
 *   { contractId, price, size, aggressorSide: 'Buy'|'Sell', timestamp }
 *
 * Quote event shape (GatewayQuote):
 *   { contractId, bid, ask, bidSize, askSize, last, timestamp }
 *
 * Bar shape emitted to onBar:
 *   { symbol, time, open, high, low, close, volume, askVol, bidVol }
 *
 * Falls back gracefully — if SignalR connection fails on startup the
 * autoTraderService will use TopStepXMarketFeed (polling) instead.
 */

const signalR = require('@microsoft/signalr');
const { getToken, getContracts } = require('../brokers/topstepx');
const logger = require('../utils/logger');

const LIVE_HUB          = 'https://gateway-rtc.s2f.projectx.com/hubs/market-data';
const DEMO_HUB          = 'https://gateway-rtc-demo.s2f.projectx.com/hubs/market-data';
const BAR_INTERVAL_MS   = 60_000;   // emit 1-min bars
const MIN_BACKOFF_MS    = 5_000;
const MAX_BACKOFF_MS    = 60_000;
const CONNECT_TIMEOUT   = 15_000;   // give up after 15s if hub unreachable

class TopStepXRealtimeFeed {
  /**
   * @param {object}   opts
   * @param {string}   opts.symbol        – e.g. "NQ", "ES", "MES"
   * @param {object}   opts.cfg           – { userName, apiKey, accountId, sim }
   * @param {function} opts.onBar         – called with each completed 1-min bar
   * @param {function} [opts.onError]     – called on non-fatal errors
   */
  constructor({ symbol, cfg, onBar, onError }) {
    this.symbol     = symbol;
    this.cfg        = cfg;
    this.onBar      = onBar;
    this.onError    = onError || ((e) => logger.error(`[TSX:RT] ${e.message}`));
    this.contractId = null;
    this._conn      = null;
    this._closed    = false;
    this._backoff   = MIN_BACKOFF_MS;

    // Current 1-min bar being accumulated from ticks
    this._bar       = null;
    this._barTimer  = null;
    this._lastClose = null;
    this._lastBid   = null;
    this._lastAsk   = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async connect() {
    this._closed = false;
    logger.info(`[TSX:RT] Starting real-time feed for ${this.symbol} (user: ${this.cfg.userName})`);
    try {
      // Resolve contract ID exactly as polling feed does
      const contracts = await getContracts(this.cfg, this.symbol);
      if (!contracts.length) throw new Error(`No active contracts found for "${this.symbol}"`);
      this.contractId = contracts[0].id;
      logger.info(`[TSX:RT] Resolved ${this.symbol} → contractId: ${this.contractId}`);
      await this._connectHub();
    } catch (err) {
      logger.error(`[TSX:RT] Startup failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  disconnect() {
    this._closed = true;
    this._stopBarTimer();
    if (this._conn) {
      this._conn.stop().catch(() => {});
      this._conn = null;
    }
    logger.info(`[TSX:RT] Disconnected (${this.symbol})`);
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  async _connectHub() {
    const token  = await getToken(this.cfg);
    const hubUrl = this.cfg.sim ? DEMO_HUB : LIVE_HUB;

    const conn = new signalR.HubConnectionBuilder()
      .withUrl(hubUrl, {
        accessTokenFactory: () => token,
        transport: signalR.HttpTransportType.WebSockets,
      })
      .withAutomaticReconnect([1000, 3000, 10000, 30000, 60000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    // Register event handlers before starting
    conn.on('GatewayTrade', (data) => {
      try { this._onTrade(data); } catch (e) {
        logger.warn(`[TSX:RT] Trade handler error: ${e.message}`);
      }
    });

    conn.on('GatewayQuote', (data) => {
      try { this._onQuote(data); } catch (_e) {}
    });

    conn.onreconnecting(() => logger.warn(`[TSX:RT] SignalR reconnecting…`));
    conn.onreconnected(async () => {
      logger.info(`[TSX:RT] Reconnected — re-subscribing to ${this.contractId}`);
      await this._subscribe(conn);
    });
    conn.onclose((err) => {
      if (!this._closed) {
        logger.warn(`[TSX:RT] Connection closed (${err?.message || 'no reason'}) — retrying`);
        this._scheduleReconnect();
      }
    });

    // Race the connection attempt against a timeout so we don't hang the
    // autoTrader startup if the hub is unreachable
    await Promise.race([
      conn.start(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SignalR connect timeout')), CONNECT_TIMEOUT)
      ),
    ]);

    this._conn    = conn;
    this._backoff = MIN_BACKOFF_MS;
    logger.info(`[TSX:RT] Connected → ${hubUrl}`);

    await this._subscribe(conn);
    this._startBarTimer();
  }

  async _subscribe(conn) {
    if (!this.contractId || !conn) return;
    try {
      await conn.invoke('SubscribeContractTrades', this.contractId);
      await conn.invoke('SubscribeContractQuotes', this.contractId);
      logger.info(`[TSX:RT] Subscribed trades+quotes for contractId:${this.contractId} (${this.symbol})`);
    } catch (err) {
      logger.warn(`[TSX:RT] Subscription error: ${err.message}`);
    }
  }

  // ─── Tick processing ─────────────────────────────────────────────────────────

  /**
   * Called on each GatewayTrade push from the hub.
   * Accumulates into the current 1-min bar.
   */
  _onTrade(data) {
    const price  = parseFloat(data.price ?? data.lastPrice);
    const volume = parseInt(data.size ?? data.volume ?? 1, 10);
    if (!price || isNaN(price)) return;

    // Classify aggressor side: Buy = ask-lift (askVol), Sell = bid-hit (bidVol)
    // ProjectX sends aggressorSide as 'Buy' or 'Sell'; fallback: compare to quote
    const aggressorSide = data.aggressorSide ?? data.side;
    let isBuy;
    if (aggressorSide === 'Buy' || aggressorSide === 0) {
      isBuy = true;
    } else if (aggressorSide === 'Sell' || aggressorSide === 1) {
      isBuy = false;
    } else {
      // Fallback: classify vs. mid-quote
      const mid = this._lastAsk != null && this._lastBid != null
        ? (this._lastBid + this._lastAsk) / 2
        : null;
      isBuy = mid != null ? price >= mid : true;
    }

    if (!this._bar) {
      this._bar = {
        symbol:  this.symbol,
        time:    new Date().toISOString(),
        open:    price,
        high:    price,
        low:     price,
        close:   price,
        volume:  0,
        askVol:  0,
        bidVol:  0,
      };
    }

    this._bar.high   = Math.max(this._bar.high, price);
    this._bar.low    = Math.min(this._bar.low,  price);
    this._bar.close  = price;
    this._bar.volume += volume;

    if (isBuy) {
      this._bar.askVol += volume;
    } else {
      this._bar.bidVol += volume;
    }
  }

  _onQuote(data) {
    if (data.bid != null) this._lastBid = parseFloat(data.bid);
    if (data.ask != null) this._lastAsk = parseFloat(data.ask);
    if (data.last != null) this._lastClose = parseFloat(data.last);
  }

  // ─── Bar emission ─────────────────────────────────────────────────────────────

  _startBarTimer() {
    this._stopBarTimer();
    // Align the first close to the next whole minute boundary
    const msToNext = BAR_INTERVAL_MS - (Date.now() % BAR_INTERVAL_MS);
    this._alignTimeout = setTimeout(() => {
      this._closeBar();
      this._barTimer = setInterval(() => this._closeBar(), BAR_INTERVAL_MS);
    }, msToNext);
  }

  _stopBarTimer() {
    if (this._barTimer)   { clearInterval(this._barTimer);   this._barTimer   = null; }
    if (this._alignTimeout) { clearTimeout(this._alignTimeout); this._alignTimeout = null; }
  }

  _closeBar() {
    if (!this._bar || this._bar.volume === 0) {
      // No trades this minute — emit a flat zero-volume bar using last known price
      if (this._lastClose) {
        const flat = {
          symbol:  this.symbol,
          time:    new Date().toISOString(),
          open:    this._lastClose,
          high:    this._lastClose,
          low:     this._lastClose,
          close:   this._lastClose,
          volume:  0,
          askVol:  0,
          bidVol:  0,
        };
        this.onBar(flat);
      }
      this._bar = null;
      return;
    }

    const bar    = { ...this._bar };
    this._lastClose = bar.close;
    this._bar       = null;

    logger.debug(
      `[TSX:RT] 1m bar ${this.symbol} ${bar.time} C:${bar.close} ` +
      `Vol:${bar.volume} Ask:${bar.askVol} Bid:${bar.bidVol} ` +
      `Δ:${bar.askVol - bar.bidVol >= 0 ? '+' : ''}${bar.askVol - bar.bidVol}`
    );
    this.onBar(bar);
  }

  // ─── Reconnect logic ──────────────────────────────────────────────────────────

  _scheduleReconnect() {
    if (this._closed) return;
    const delay = Math.min(this._backoff, MAX_BACKOFF_MS);
    logger.info(`[TSX:RT] Retrying in ${delay / 1000}s…`);
    setTimeout(() => {
      if (!this._closed) {
        this._connectHub().catch(() => this._scheduleReconnect());
      }
    }, delay);
    this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_MS);
  }
}

module.exports = { TopStepXRealtimeFeed };
