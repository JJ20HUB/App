'use strict';
/**
 * tradovateMarketFeed.js
 *
 * Real-time Tradovate WebSocket market data feed.
 *
 * Connects to the Tradovate Market Data WebSocket, authenticates with a JWT
 * obtained from the existing topstep.js auth helper, then subscribes to
 * 1-minute OHLCV chart bars that include bid/offer volume split.
 *
 * Tradovate chart bars include:
 *   upVolume    – volume on upticks  (≈ buy aggressor / ask fills)
 *   downVolume  – volume on downticks (≈ sell aggressor / bid fills)
 *   offerVolume – volume executed at the offer (askVol)
 *   bidVolume   – volume executed at the bid   (bidVol)
 *
 * These map directly to what OrderFlowEngine.ingest() expects:
 *   { symbol, time, open, high, low, close, volume, askVol, bidVol }
 *
 * Wire protocol (Tradovate uses a custom text-frame format):
 *   Outgoing: "{endpoint}\n{requestId}\n\n{jsonBody}"
 *   Incoming: "o" (connected) | "h" (heartbeat) | "a[{e,d}]" (data) | "c"
 *
 * Heartbeat: server sends "h" every ~2.5 s. Client must reply with "[]" to
 * keep the connection alive — handled automatically by this class.
 *
 * Auth flow:
 *   1. Connect WebSocket
 *   2. Send  → authorize\n1\n\n{"token":"<access_token>"}
 *   3. Recv  ← a[{"e":"authorized","d":{"userId":...}}]
 *   4. Send  → md/subscribeChart\n2\n\n{...}
 *   5. Recv  ← a[{"e":"chart","d":{"charts":[{"bars":[...]}]}}]
 *
 * Env vars (set in .env):
 *   TRADOVATE_USERNAME  – Tradovate account username
 *   TRADOVATE_PASSWORD  – Tradovate account password
 *   TRADOVATE_APP_ID    – App ID from Tradovate developer portal
 *   TRADOVATE_APP_VERSION – (optional, defaults to "1.0")
 */

const WebSocket = require('ws');
const { getAccessToken } = require('../brokers/topstep');
const logger = require('../utils/logger');

const LIVE_MD_WS = 'wss://md.tradovateapi.com/v1/websocket';
const DEMO_MD_WS = 'wss://md.tradovateapi.com/v1/websocket'; // demo uses same MD endpoint

const HEARTBEAT_INTERVAL_MS = 2500;
const RECONNECT_DELAY_MS    = 5000;

class TradovateMarketFeed {
  /**
   * @param {object}   opts
   * @param {string}   opts.symbol   – e.g. "NQ", "ES", "MES"
   * @param {object}   opts.cfg      – broker config (username, password, appId, sim)
   * @param {function} opts.onBar    – called with each completed bar object
   * @param {function} [opts.onError]– called on non-fatal errors
   */
  constructor({ symbol, cfg, onBar, onError }) {
    this.symbol      = symbol;
    this.cfg         = cfg;
    this.onBar       = onBar;
    this.onError     = onError || ((e) => logger.error(`[TradovateMarketFeed] ${e.message}`));
    this.ws          = null;
    this.reqId       = 1;
    this.chartSubId  = null;
    this._heartbeat  = null;
    this._reconnect  = null;
    this._closed     = false;
    this._lastBarTs  = 0;     // ms timestamp of last forwarded bar (deduplication)
    this._wsUrl      = null;
    this._token      = null;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async connect() {
    this._closed = false;
    try {
      this._token  = await getAccessToken(this.cfg);
      this._wsUrl  = this.cfg.sim ? DEMO_MD_WS : LIVE_MD_WS;
      this._openSocket();
    } catch (err) {
      logger.error(`[TradovateMarketFeed] Auth failed for ${this.symbol}: ${err.message}`);
      this.onError(err);
    }
  }

  disconnect() {
    this._closed = true;
    this._clearTimers();
    if (this.chartSubId != null && this.ws?.readyState === WebSocket.OPEN) {
      this._send('md/cancelChart', { subscriptionId: this.chartSubId });
    }
    this.ws?.close();
    this.ws = null;
    logger.info(`[TradovateMarketFeed] Disconnected (${this.symbol})`);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _openSocket() {
    logger.info(`[TradovateMarketFeed] Connecting → ${this._wsUrl} [${this.symbol}]`);
    const ws = new WebSocket(this._wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      logger.info(`[TradovateMarketFeed] Connected — authorising`);
      this._send('authorize', { token: this._token });

      // Keep-alive: reply to server heartbeats
      this._heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('[]');
      }, HEARTBEAT_INTERVAL_MS);
    });

    ws.on('message', (data) => {
      try { this._onMessage(data.toString()); } catch (e) {
        logger.error(`[TradovateMarketFeed] Message handler error: ${e.message}`);
      }
    });

    ws.on('error', (err) => {
      logger.error(`[TradovateMarketFeed] WS error: ${err.message}`);
      this.onError(err);
    });

    ws.on('close', (code, reason) => {
      logger.warn(`[TradovateMarketFeed] WS closed (${code}) — ${reason || 'no reason'}`);
      this._clearTimers();
      if (!this._closed) {
        logger.info(`[TradovateMarketFeed] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`);
        this._reconnect = setTimeout(async () => {
          // Re-auth in case token expired
          try { this._token = await getAccessToken(this.cfg); } catch (_) {}
          this._openSocket();
        }, RECONNECT_DELAY_MS);
      }
    });
  }

  _onMessage(raw) {
    if (raw === 'o') return;      // socket opened confirmation
    if (raw === 'h') return;      // heartbeat — heartbeatTimer replies
    if (raw[0] === 'c') return;   // close frame

    // Data frames: a[{e, d}, ...]
    if (raw[0] !== 'a') return;
    let events;
    try { events = JSON.parse(raw.slice(1)); } catch { return; }

    for (const evt of events) {
      switch (evt.e) {
        case 'authorized':
          logger.info(`[TradovateMarketFeed] Auth OK (userId=${evt.d?.userId}) — subscribing ${this.symbol}`);
          this._subscribeChart();
          break;

        case 'chart':
          this._handleChartEvent(evt.d);
          break;

        case 'error':
          logger.error(`[TradovateMarketFeed] API error: ${JSON.stringify(evt.d)}`);
          this.onError(new Error(evt.d?.message || 'Tradovate API error'));
          break;
      }
    }
  }

  _subscribeChart() {
    // Request the last 200 1-minute bars + live streaming updates.
    // withHistogram:true includes bidVolume / offerVolume per bar.
    this._send('md/subscribeChart', {
      symbol: this.symbol,
      chartDescription: {
        underlyingType:  'MinuteBar',
        elementSize:     1,
        elementSizeUnit: 'UnderlyingUnits',
        withHistogram:   true,
      },
      timeRange: {
        asFarAsTimestamp: new Date().toISOString(),
        asMuchAsElements: 200,
      },
    });
  }

  _handleChartEvent(d) {
    if (!d?.charts) return;

    for (const chart of d.charts) {
      // Store the subscription ID so we can cancel it on disconnect
      if (chart.id != null) this.chartSubId = chart.id;
      if (!Array.isArray(chart.bars) || chart.bars.length === 0) continue;

      // Tradovate sends historical bars on first event, then live partial/complete
      // updates. The last bar in any batch may be a still-forming partial bar.
      // Strategy:
      //   • Historical batches: forward all bars EXCEPT the very last (partial)
      //   • Live single-bar updates (td flag): forward when we see a NEW timestamp
      const isLiveUpdate = chart.td != null; // td = "tick data" live update marker

      const bars = chart.bars;
      // For historical batches emit everything except the last entry (partial live bar)
      const count = isLiveUpdate ? bars.length : Math.max(0, bars.length - 1);

      for (let i = 0; i < count; i++) {
        const b = bars[i];
        const ts = typeof b.timestamp === 'string'
          ? new Date(b.timestamp).getTime()
          : b.timestamp;

        // Skip bars we've already forwarded (dedup on reconnect)
        if (ts <= this._lastBarTs) continue;
        this._lastBarTs = ts;

        const bar = {
          symbol: this.symbol,
          time:   new Date(ts).toISOString(),
          open:   b.open,
          high:   b.high,
          low:    b.low,
          close:  b.close,
          // Total volume from up+down ticks
          volume: (b.upVolume   || 0) + (b.downVolume || 0),
          // Buy aggressor = volume executed at the offer (ask side)
          askVol: b.offerVolume || b.upVolume   || 0,
          // Sell aggressor = volume executed at the bid
          bidVol: b.bidVolume   || b.downVolume || 0,
          trades: (b.upTicks    || 0) + (b.downTicks  || 0),
        };

        logger.debug(
          `[TradovateMarketFeed] ${this.symbol} @ ${bar.time} ` +
          `O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} ` +
          `Vol=${bar.volume} Δ=${bar.askVol - bar.bidVol}`
        );

        try { this.onBar(bar); } catch (e) {
          logger.error(`[TradovateMarketFeed] onBar callback error: ${e.message}`);
        }
      }
    }
  }

  _send(endpoint, body) {
    const id    = this.reqId++;
    const frame = `${endpoint}\n${id}\n\n${JSON.stringify(body)}`;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    } else {
      logger.warn(`[TradovateMarketFeed] Cannot send — socket not open (${endpoint})`);
    }
  }

  _clearTimers() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
    if (this._reconnect) { clearTimeout(this._reconnect);  this._reconnect = null; }
  }
}

module.exports = { TradovateMarketFeed };
