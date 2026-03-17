'use strict';
/**
 * claudeAI.js
 *
 * Anthropic Claude AI integration for Apex Trading.
 *
 * Provides three core capabilities:
 *
 *  1. validateSignal(signal, botConfig, indicators, recentTrades)
 *     ─ Second-opinion filter on an OrderFlowEngine signal before order placement.
 *       Returns { approved, aiConfidence, aiDirection, reasoning, suggestedAdjustments }
 *
 *  2. analyzeMarket(symbol, bars, indicators, recentTrades)
 *     ─ Free-form market analysis for a given symbol + context.
 *       Returns { summary, bias, keyLevels, riskWarnings, tradeIdeas }
 *
 *  3. reviewBotConfig(botConfig)
 *     ─ Claude reviews a bot's risk/engine parameters and flags issues.
 *       Returns { assessment, warnings, suggestions }
 *
 * All methods gracefully degrade when the API key is missing or the API is
 * unreachable — they return a neutral/pass-through result so the engine
 * continues to function without AI.
 */

const Anthropic = require('@anthropic-ai/sdk');
const config    = require('../config');
const logger    = require('../utils/logger');

// ─── Client (lazy-init so missing key doesn't crash startup) ─────────────────

let _client    = null;
let _lastError = null;

function getClient() {
  if (!_client) {
    if (!config.claude.apiKey || config.claude.apiKey === 'your_anthropic_api_key_here') {
      return null;
    }
    _client = new Anthropic({ apiKey: config.claude.apiKey });
  }
  return _client;
}

// ─── Shared helper ────────────────────────────────────────────────────────────

async function _chat(systemPrompt, userContent, maxTokens = 512) {
  const client = getClient();
  if (!client) {
    logger.warn('[claudeAI] Skipping — ANTHROPIC_API_KEY not configured.');
    return null;
  }
  try {
    const msg = await client.messages.create({
      model:      config.claude.model,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userContent }],
    });
    return msg.content[0]?.text ?? null;
  } catch (err) {
    const hint = err.status === 400 && err.message && err.message.includes('credit')
      ? 'Insufficient Anthropic credits'
      : `API error ${err.status || ''}`;
    logger.error(`[claudeAI] ${hint}: ${err.message}`);
    _lastError = hint;
    return null;
  }
}

// ─── Safe JSON parse helper ───────────────────────────────────────────────────

function _parseJSON(text, fallback) {
  if (!text) return fallback;
  try {
    // Extract first JSON block if Claude wraps it in markdown fences
    const match = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/(\{[\s\S]*\})/);
    return JSON.parse(match ? match[1] : text);
  } catch {
    return fallback;
  }
}

// ─── 1. Signal Validation ─────────────────────────────────────────────────────

/**
 * Ask Claude to validate an OrderFlowEngine signal before it triggers a trade.
 *
 * @param {object} signal       - Full signal object from OrderFlowEngine (includes recentBars)
 * @param {object} botConfig    - Bot configuration (symbol, slTicks, tpTicks, rr…)
 * @param {Array}  indicators   - User's saved indicators for context
 * @param {Array}  recentTrades - Last N trades from the trade log
 * @returns {object} { approved, aiConfidence, aiDirection, reasoning, suggestedAdjustments }
 */
async function validateSignal(signal, botConfig, indicators = [], recentTrades = []) {
  const SYSTEM = `You are a senior prop-firm risk manager and elite algorithmic futures trader.
Your ONLY job is to approve or reject signals coming out of an order-flow engine that targets a
70%+ win rate. You must be extremely selective — HOLD is your default answer.

CORE MANDATE:
- This system targets a 70%+ win rate. If you are not highly confident, you reject.
- Approve roughly 1 in 3 signals the engine generates, not more.
- A missed trade costs nothing. A bad trade costs real capital.
- "Good enough" is NOT good enough. Only approve genuinely exceptional setups.

APPROVAL REQUIRES ALL of the following (hard gate — missing any = HOLD):
1. SUSTAINED tape pressure: ≥3 consecutive bars where askVol > bidVol (for BUY) or bidVol > askVol
   (for SELL). A single large delta bar without follow-through is noise, NOT a signal.
2. AGREEMENT: delta, cumDelta, AND imbalance must all point the same direction. Divergence = HOLD.
3. NO price/delta divergence: if price is making new highs but cumDelta is flat or declining
   (for BUY) or price making new lows but cumDelta rising (for SELL) — that is divergence, HOLD.
4. CLEAN regime: ATR must be in a healthy range (not near zero = dead; not >3× average = chaotic).
   In a choppy or wide-range regime, default to HOLD.
5. ABSORPTION present (preferred) or strong momentum AND confluence score ≥ 4 components.
6. Engine confidence ≥ 70 AND your own aiConfidence ≥ 72. Below that — always HOLD.

AUTOMATIC REJECTION (any single one triggers HOLD):
- Mixed tape: buy bars and sell bars alternating with no clear dominance
- First 2 bars of any signal burst (spike, no follow-through)
- Engine confidence < 68
- Regime is "ultra-low ATR" or "extremely high ATR" (erratic)
- Signal is counter to a clearly established EMA trend on the tape
- Recent trade log shows ≥ 2 consecutive losses (cooling-off period)

RESPONSE SCHEMA — respond ONLY with this exact JSON (no prose before or after):
{
  "approved": boolean,
  "aiConfidence": number (0-100),
  "aiDirection": "BUY" | "SELL" | "HOLD",
  "reasoning": string (2-4 sentences, cite the specific tape evidence that drove your decision),
  "suggestedAdjustments": {
    "slTicks": number | null,
    "tpTicks": number | null,
    "skipReason": string | null
  }
}

If you approve, aiConfidence MUST be ≥ 72. If you cannot justify ≥ 72, set approved: false.`;

  // Support both the legacy trade_log format and the new recentOutcomes format
  const completedOutcomes = recentTrades.filter(t => t.outcome === 'win' || t.outcome === 'loss');
  const outcomeWins       = completedOutcomes.filter(t => t.outcome === 'win').length;
  const recentWinRate     = completedOutcomes.length >= 3
    ? Math.round((outcomeWins / completedOutcomes.length) * 100)
    : null;
  const recentSummary = recentTrades.slice(-8).map(t =>
    t.outcome
      ? `[${t.outcome.toUpperCase().padEnd(4)}] ${t.direction} conf:${t.confidence}% regime:${t.regime || '?'} @ ${t.timestamp?.slice(0, 16) || '?'}`
      : `${(t.action || t.side || '?').toUpperCase()} ${t.ticker || t.symbol || '?'} — ${t.status ?? 'unknown'}`
  ).join('\n') || 'No recent trades';

  const indicatorSummary = indicators.slice(0, 5).map(i =>
    `${i.name}${i.ticker ? ` (${i.ticker})` : ''}${i.description ? ': ' + i.description : ''}`
  ).join('\n') || 'No indicators configured';

  // Format raw bar tape for Claude to read — key order flow fields per bar
  const barTape = (signal.recentBars || []).map((b, i) =>
    `  ${String(i + 1).padStart(2)}. t:${b.t}  O:${b.o} H:${b.h} L:${b.l} C:${b.c}  ` +
    `Vol:${b.vol}  Ask:${b.askVol} Bid:${b.bidVol}  Δ:${b.delta >= 0 ? '+' : ''}${b.delta}  ` +
    `Imb:${b.imb}  ATR:${b.atr}${b.abs ? '  [ABSORPTION]' : ''}`
  ).join('\n') || '  No tape data available';

  const USER = `
SIGNAL FROM ORDER FLOW ENGINE:
  Symbol:        ${signal.symbol}
  Direction:     ${signal.signal}
  Confidence:    ${signal.confidence}%
  Confluences:   ${signal.confluences ?? 'N/A'} of 6 components agreeing
  Reasons:       ${(signal.reasons || []).join(' | ')}

ENGINE METRICS:
  Delta:       ${signal.metrics?.delta}
  Cum. Delta:  ${signal.metrics?.cumDelta}
  Imbalance:   ${signal.metrics?.imbalance}
  Absorption:  ${signal.metrics?.absorption} bars
  Momentum:    ${signal.metrics?.momentum}
  EMA Slope:   ${signal.metrics?.emaDiff} (trend: ${signal.metrics?.trend})
  ATR:         ${signal.metrics?.atr} ticks (regime: ${signal.metrics?.regime})
  Buy Score:   ${signal.metrics?.buyScore}  |  Sell Score: ${signal.metrics?.sellScore}

LIVE ORDER FLOW TAPE (${signal.recentBars?.length || 0} bars, newest last):
${barTape}

BOT RISK CONFIG:
  SL Ticks:   ${botConfig.slTicks}
  TP Ticks:   ${botConfig.tpTicks}
  R:R Ratio:  ${botConfig.riskRewardRatio}
  Qty:        ${botConfig.qty} contracts
  Broker:     ${botConfig.broker}

ACTIVE INDICATORS:
${indicatorSummary}

RECENT TRADE HISTORY (newest last):
${recentSummary}
${recentWinRate != null ? `Current session win rate: ${recentWinRate}% (${outcomeWins}/${completedOutcomes.length})${recentWinRate < 50 ? ' ⚠️ WIN RATE BELOW 50% — be extra selective' : recentWinRate >= 70 ? ' ✅ Win rate healthy' : ' ⚡ Win rate in range'}` : 'Win rate: insufficient data yet'}

TASK: Read the tape bar by bar. Does it show SUSTAINED, UNAMBIGUOUS pressure in the ${signal.signal} direction across ≥3 consecutive bars? Do all three core metrics (delta, cumDelta, imbalance) agree? Is the regime healthy? Only approve if this is a genuinely high-probability setup that belongs in a 70%+ win-rate system. When in doubt, HOLD. Respond with JSON only.`.trim();

  const raw = await _chat(SYSTEM, USER, 500);
  const fallback = {
    approved:     true,   // pass-through on failure so the bot keeps running
    aiConfidence: signal.confidence,
    aiDirection:  signal.signal,
    reasoning:    'AI validation unavailable — engine signal passed through.',
    suggestedAdjustments: { slTicks: null, tpTicks: null, skipReason: null },
  };

  const result = _parseJSON(raw, fallback);
  logger.info(`[claudeAI] Signal ${signal.signal} ${signal.symbol}: approved=${result.approved}, aiConf=${result.aiConfidence}%`);
  return result;
}

// ─── 2. Market Analysis ───────────────────────────────────────────────────────

/**
 * Ask Claude for a structured market analysis on a symbol.
 *
 * @param {string} symbol       - e.g. 'NQ', 'ES'
 * @param {Array}  bars         - Recent OHLCV bars (last 20-50)
 * @param {Array}  indicators   - User's saved indicators
 * @param {Array}  recentTrades - Recent trade log entries
 * @returns {object} { summary, bias, keyLevels, riskWarnings, tradeIdeas }
 */
async function analyzeMarket(symbol, bars = [], indicators = [], recentTrades = []) {
  const SYSTEM = `You are a professional futures market analyst specialising in order flow, 
price action, and algorithmic trading for equity index futures (NQ, ES, MES, MNQ, YM).
Provide structured, actionable analysis for an automated trading system. Be concise and data-driven.

Respond ONLY with valid JSON:
{
  "summary": string,
  "bias": "BULLISH" | "BEARISH" | "NEUTRAL" | "CHOPPY",
  "keyLevels": { "support": number[], "resistance": number[] },
  "riskWarnings": string[],
  "tradeIdeas": [
    {
      "direction": "BUY" | "SELL",
      "entry": string,
      "target": string,
      "stop": string,
      "rationale": string
    }
  ]
}`;

  const barSummary = bars.slice(-10).map(b =>
    `O:${b.open} H:${b.high} L:${b.low} C:${b.close} Vol:${b.volume} Δ:${b.delta ?? '?'}`
  ).join('\n') || 'No bar data available';

  const indicatorSummary = indicators.map(i =>
    `• ${i.name}${i.ticker ? ` [${i.ticker}]` : ''}: ${i.description || 'no description'}`
  ).join('\n') || 'None configured';

  const tradeSummary = recentTrades.slice(-10).map(t =>
    `${t.createdAt?.slice(0,16)} ${t.action?.toUpperCase()} ${t.ticker} ${t.qty}ct — ${t.status}`
  ).join('\n') || 'No recent trades';

  const USER = `
SYMBOL: ${symbol}
TIMESTAMP: ${new Date().toISOString()}

RECENT BARS (newest last):
${barSummary}

USER INDICATORS:
${indicatorSummary}

RECENT TRADE LOG:
${tradeSummary}

Provide your market analysis in JSON.`.trim();

  const raw  = await _chat(SYSTEM, USER, 700);
  const reason = _lastError || 'service offline';
  const fallback = {
    summary:      `AI analysis unavailable — ${reason}.`,
    bias:         'NEUTRAL',
    keyLevels:    { support: [], resistance: [] },
    riskWarnings: [`Golden Arc AI not responding (${reason}) — manual review recommended.`],
    tradeIdeas:   [],
  };
  return _parseJSON(raw, fallback);
}

// ─── 3. Bot Config Review ─────────────────────────────────────────────────────

/**
 * Ask Claude to review a bot's risk parameters from a professional standpoint.
 *
 * @param {object} botConfig - Full bot config object
 * @returns {object} { assessment, riskRating, warnings, suggestions }
 */
async function reviewBotConfig(botConfig) {
  const SYSTEM = `You are a professional risk manager for a proprietary trading firm specialising 
in algorithmic futures trading. Review an automated trading bot's configuration for risk hygiene, 
parameter quality, and potential failure modes.

Respond ONLY with valid JSON:
{
  "assessment": string (2-3 sentence overview),
  "riskRating": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "warnings": string[],
  "suggestions": string[]
}`;

  const USER = `
BOT CONFIGURATION TO REVIEW:
${JSON.stringify({
  name:               botConfig.name,
  symbol:             botConfig.symbol,
  broker:             botConfig.broker,
  qty:                botConfig.qty,
  slTicks:            botConfig.slTicks,
  tpTicks:            botConfig.tpTicks,
  riskRewardRatio:    botConfig.riskRewardRatio,
  maxDailyLoss:       botConfig.maxDailyLoss,
  maxDailyTrades:     botConfig.maxDailyTrades,
  maxConsecLosses:    botConfig.maxConsecLosses,
  minConfidence:      botConfig.minConfidence,
  windowSize:         botConfig.windowSize,
  deltaThreshold:     botConfig.deltaThreshold,
  imbalanceThreshold: botConfig.imbalanceThreshold,
  minAtrTicks:        botConfig.minAtrTicks,
  maxAtrTicks:        botConfig.maxAtrTicks,
  simulationMode:     botConfig.simulationMode,
}, null, 2)}

Review this bot configuration and identify any risk concerns. Respond with JSON only.`.trim();

  const raw = await _chat(SYSTEM, USER, 500);
  if (raw) return _parseJSON(raw, _localBotAudit(botConfig));
  // AI unavailable — run local rule-based audit
  return _localBotAudit(botConfig);
}

/**
 * Local rule-based bot risk audit — runs when AI is unavailable.
 * Inspects R:R, stop/target sizing, daily loss limits, and circuit breakers.
 */
function _localBotAudit(bot) {
  const warnings    = [];
  const suggestions = [];

  const rr  = parseFloat(bot.riskRewardRatio) || 0;
  const sl  = parseFloat(bot.slTicks)         || 0;
  const tp  = parseFloat(bot.tpTicks)         || 0;
  const dl  = parseFloat(bot.maxDailyLoss)    || 0;
  const dt  = parseInt(bot.maxDailyTrades)    || 0;
  const cl  = parseInt(bot.maxConsecLosses)   || 0;
  const mc  = parseFloat(bot.minConfidence)   || 0;
  const qty = parseInt(bot.qty)               || 1;
  const sim = bot.simulationMode;

  // R:R check
  if (rr < 1.5) {
    warnings.push(`R:R ratio is ${rr} — minimum recommended is 1.5:1.`);
    suggestions.push('Increase riskRewardRatio to at least 1.5 to ensure profitability even with a 40% win rate.');
  }
  if (tp && sl && (tp / sl) < rr - 0.1) {
    warnings.push(`TP/SL tick ratio (${tp}/${sl} = ${(tp/sl).toFixed(1)}) does not match stated R:R of ${rr}.`);
    suggestions.push(`Set tpTicks to at least ${Math.round(sl * rr)} to match your R:R ratio.`);
  }

  // Stop-loss size
  if (sl < 4) {
    warnings.push(`Stop-loss of ${sl} ticks is very tight — likely to be stopped out by noise.`);
    suggestions.push('Use a minimum stop of 6–8 ticks on index futures to survive normal bid/ask spread and slippage.');
  }

  // Daily loss limit
  if (!dl || dl <= 0) {
    warnings.push('No maxDailyLoss set — bot has no daily drawdown protection.');
    suggestions.push('Set maxDailyLoss to at least 2–3× your per-trade stop-loss value.');
  } else if (qty > 1 && dl < sl * qty * 2) {
    warnings.push(`maxDailyLoss of $${dl} may be too low for ${qty} contracts at ${sl} ticks SL.`);
  }

  // Trade frequency
  if (dt > 20) {
    warnings.push(`maxDailyTrades of ${dt} is high — overtrading risk increases drawdown probability.`);
    suggestions.push('Consider limiting to 8–12 trades/day to maintain signal quality and reduce commission drag.');
  }

  // Consecutive loss limit
  if (!cl || cl > 5) {
    warnings.push(`maxConsecLosses of ${cl || 'unlimited'} offers weak protection against loss streaks.`);
    suggestions.push('Set maxConsecLosses to 3 to pause trading after a losing streak and reassess market conditions.');
  }

  // Confidence threshold
  if (mc < 55) {
    warnings.push(`minConfidence of ${mc}% is low — bot will trade marginal setups.`);
    suggestions.push('Raise minConfidence to at least 60% to filter out low-quality signals.');
  }

  // Sim mode warning
  if (sim) {
    suggestions.push('Bot is in simulation mode — no real orders will be placed. Set simulationMode: false for live trading.');
  }

  // Determine risk rating
  const criticalCount = warnings.filter(w =>
    w.includes('no') || w.includes('unlimited') || w.includes('R:R')
  ).length;
  let riskRating = 'LOW';
  if (warnings.length >= 4 || criticalCount >= 2) riskRating = 'HIGH';
  else if (warnings.length >= 2 || criticalCount >= 1) riskRating = 'MEDIUM';

  // Overall assessment
  const aiNote = _lastError && _lastError.includes('credit')
    ? ' (Golden Arc AI offline — add credits at console.anthropic.com to enable deep AI review)'
    : ' (Golden Arc AI offline — local rule check only)';

  const assessment = warnings.length === 0
    ? `Bot configuration looks solid${aiNote}. R:R, circuit breakers, and sizing all pass basic checks.`
    : `Found ${warnings.length} concern${warnings.length > 1 ? 's' : ''} in bot configuration${aiNote}. Review warnings below before going live.`;

  if (suggestions.length === 0) {
    suggestions.push('Configuration passes all local rule checks. Top up Anthropic credits for a full AI deep-dive.');
  }

  return { assessment, riskRating, warnings, suggestions };
}

// ─── 4. Indicator Insight ─────────────────────────────────────────────────────

/**
 * Ask Claude how a set of TradingView indicators should be combined with order
 * flow signals for a given market.
 *
 * @param {Array}  indicators - User's saved indicators
 * @param {string} symbol     - Trading symbol context
 * @returns {object} { strategy, entryRules, filterRules, alertTemplateHints }
 */
async function indicatorInsight(indicators, symbol = '') {
  const SYSTEM = `You are an algorithmic trading strategist with deep expertise in TradingView 
Pine Script indicators and order flow trading for equity index futures. 
Help a trader understand how to best combine their indicators with an order-flow engine that 
scores Delta, Cumulative Delta, Volume Imbalance, Absorption, Momentum, and EMA trend alignment.

Respond ONLY with valid JSON:
{
  "strategy": string,
  "entryRules": string[],
  "filterRules": string[],
  "alertTemplateHints": string[]
}`;

  const indicatorList = indicators.map((i, n) =>
    `${n + 1}. ${i.name}${i.ticker ? ` [${i.ticker}]` : ''}\n   ${i.description || 'No description'}\n   Alert template: ${JSON.stringify(i.alertTemplate) || 'Not set'}`
  ).join('\n\n');

  const USER = `
SYMBOL / MARKET: ${symbol || 'equity index futures (NQ/ES)'}

USER'S INDICATORS:
${indicatorList || 'No indicators saved yet.'}

How should these indicators be combined with an order-flow engine for best signal quality?
Respond with JSON only.`.trim();

  const raw = await _chat(SYSTEM, USER, 600);
  const fallback = {
    strategy:           'AI insight unavailable — configure ANTHROPIC_API_KEY to enable.',
    entryRules:         [],
    filterRules:        [],
    alertTemplateHints: [],
  };
  return _parseJSON(raw, fallback);
}

// ─── 5. Live Order Flow Analysis ─────────────────────────────────────────────

/**
 * Claude reads a live order flow tape and generates a proactive directional view.
 * Called periodically by the autoTraderService (every N bars) to give Claude
 * an independent read of the market independent of the engine's signal.
 *
 * When Claude detects a high-conviction setup (≥80 confidence + ≥3 confirming bars)
 * it sets shouldTrade:true and populates tradeSetup — the autoTrader will then
 * execute via the normal _handleSignal path without needing an engine signal.
 *
 * @param {string} symbol         - e.g. 'NQ', 'ES'
 * @param {Array}  bars           - Array of enriched bar objects from the engine
 * @param {object} botConfig      - Bot config for context (symbol, slTicks, etc.)
 * @param {Array}  recentOutcomes - Last N trade outcomes for win-rate context
 * @returns {object} { direction, confidence, reasoning, volumeObservations, keyAlert,
 *                     shouldTrade, tradeSetup }
 */
async function analyzeOrderFlow(symbol, bars = [], botConfig = {}, recentOutcomes = []) {
  // Build win rate summary from recent outcomes
  const completedTrades = recentOutcomes.filter(t => t.outcome === 'win' || t.outcome === 'loss');
  const recentWins      = completedTrades.filter(t => t.outcome === 'win').length;
  const recentWinRate   = completedTrades.length >= 3
    ? Math.round((recentWins / completedTrades.length) * 100)
    : null;
  const outcomeSummary  = completedTrades.slice(-6).map(t =>
    `[${t.outcome.toUpperCase().padEnd(4)}] ${t.direction} conf:${t.confidence}% regime:${t.regime || '?'}`
  ).join('\n') || 'No recent outcomes';

  const SYSTEM = `You are a professional order flow analyst and futures trader. You specialise 
in reading raw volume data to identify institutional activity, absorption, imbalances, and 
trend continuation or reversal setups. You will be given a real-time bar-by-bar order flow tape.

Your job:
1. Identify the dominant order flow pattern (e.g. sustained bid absorption, aggressive ask lifting, delta divergence, etc.)
2. Determine the most likely directional bias for the next 1-5 bars
3. If you detect a GENUINELY HIGH-CONVICTION setup, set shouldTrade:true — this will trigger a real trade
4. Flag any high-conviction setups or warning signs
5. Be concise — this is a live system

RULES FOR shouldTrade:true (ALL must be met — no exceptions):
- confidence MUST be ≥ 80
- ≥ 3 consecutive bars with clear directional aggressor dominance (askVol > bidVol for BUY, or bidVol > askVol for SELL)
- No divergence: price direction and cumDelta must agree
- ATR regime is healthy (not near-zero choppy, not extreme runaway)
- If recent win rate is < 50%, require confidence ≥ 85 before setting shouldTrade:true
- When in doubt: shouldTrade:false. A missed trade costs nothing; a bad trade is permanent.

Respond ONLY with valid JSON:
{
  "direction": "BUY" | "SELL" | "NEUTRAL",
  "confidence": number (0-100),
  "reasoning": string (3-5 sentences),
  "volumeObservations": string[],
  "keyAlert": string | null,
  "shouldTrade": boolean,
  "tradeSetup": {
    "direction": "BUY" | "SELL",
    "confidence": number (0-100),
    "urgency": "NOW" | "NEXT_BAR" | "WAIT",
    "reasonsToTrade": string[]
  } | null
}`;

  const tape = bars.slice(-20).map((b, i) =>
    `  ${String(i + 1).padStart(2)}. ${b.time || b.t}  ` +
    `O:${b.open ?? b.o}  H:${b.high ?? b.h}  L:${b.low ?? b.l}  C:${b.close ?? b.c}  ` +
    `Vol:${b.volume ?? b.vol}  AskVol:${Math.round(b.askVol ?? b.askVol ?? 0)}  ` +
    `BidVol:${Math.round(b.bidVol ?? 0)}  Δ:${b.delta >= 0 ? '+' : ''}${Math.round(b.delta ?? 0)}  ` +
    `Imb:${Math.round((b.imbalance ?? b.imb ?? 0.5) * 100)}%  ` +
    `ATR:${Math.round((b.atr ?? 0) * 100) / 100}` +
    `${(b.absorption || b.abs) ? '  ★ABSORPTION' : ''}`
  ).join('\n') || '  No live data yet';

  const USER = `
SYMBOL: ${symbol}
TIMESTAMP: ${new Date().toISOString()}
BOT: ${botConfig.name || 'Unknown'} | SL:${botConfig.slTicks || '?'}t TP:${botConfig.tpTicks || '?'}t R:R ${botConfig.riskRewardRatio || 2}:1

LIVE ORDER FLOW TAPE (${bars.length} bars, newest last):
${tape}

RECENT TRADE OUTCOMES (for win rate context):
${outcomeSummary}
${recentWinRate != null ? `Session win rate: ${recentWinRate}% (${recentWins}/${completedTrades.length} trades)` : 'Win rate: insufficient data'}

Read this tape and give me your directional assessment. Only set shouldTrade:true if this is a genuine high-conviction setup meeting ALL the criteria above. Respond with JSON only.`.trim();

  const raw = await _chat(SYSTEM, USER, 550);
  const fallback = {
    direction:          'NEUTRAL',
    confidence:         0,
    reasoning:          'AI order flow analysis unavailable.',
    volumeObservations: [],
    keyAlert:           null,
    shouldTrade:        false,
    tradeSetup:         null,
  };
  const result = _parseJSON(raw, fallback);
  // Ensure shouldTrade is false if confidence is below threshold (defensive)
  if (result.shouldTrade && result.confidence < 80) result.shouldTrade = false;
  logger.info(
    `[claudeAI] Order flow analysis ${symbol}: ${result.direction} @ ${result.confidence}%` +
    (result.shouldTrade ? ` ⚡ INITIATING TRADE (${result.tradeSetup?.direction})` : '')
  );
  return result;
}

// ─── 6. GEX Key Level Analysis + Trade Setup Generation ──────────────────────

/**
 * analyzeGEXLevels
 *
 * Claude receives the computed GEX / key levels (from gexAnalyzer.js) together
 * with current price and order flow context, then:
 *
 *  1. Identifies which key levels are most significant RIGHT NOW
 *  2. Predicts directional behaviour at each nearby level (bounce / break / pin)
 *  3. Generates concrete, executable trade setups (entry, stop, target)
 *  4. Flags any dangerous conditions (too choppy, news risk, conflicting signals)
 *
 * @param {string} symbol           – 'NQ' | 'ES' | 'MES' | 'MNQ' etc.
 * @param {number} currentPrice     – Latest close price from the live feed
 * @param {object} gexLevels        – Full output of gexAnalyzer.computeGEXLevels()
 * @param {Array}  recentBars       – Last 15 enriched bars from the engine
 * @param {object} orderFlowMetrics – engine.getMetrics() snapshot
 * @param {object} botConfig        – Bot risk config (slTicks, tpTicks, qty…)
 * @returns {object} GEXAnalysis result (see schema below)
 */
async function analyzeGEXLevels(symbol, currentPrice, gexLevels, recentBars = [], orderFlowMetrics = {}, botConfig = {}) {
  const SYSTEM = `You are an elite futures trader and market microstructure expert specialising 
in Gamma Exposure (GEX), volume profile analysis, and order flow. You will receive:

• Key structural price levels derived from volume profile, delta clusters, absorption zones, 
  and VWAP bands — these behave like GEX levels (magnetic pins and flip zones)
• Current price relative to those levels
• Live order flow tape showing how the market is actually trading INTO those levels
• Bot risk parameters

Your task:
1. Analyse the structure: which levels are acting as magnets (HVN, POC, absorption) vs. 
   acceleration zones (LVN, delta flip)?
2. Predict what will happen as price approaches the nearest levels based on the order flow 
   tape — is price being absorbed (reversal) or aggressively bid/lifted (continuation)?
3. Generate up to 3 specific, executable trade setups with exact entry context, 
   stop placement, and target
4. Flag any conditions that make trading dangerous right now

Think like a prop trader who reads order flow and gamma levels simultaneously.

Respond ONLY with valid JSON matching this exact schema:
{
  "bias": "BULLISH" | "BEARISH" | "NEUTRAL" | "CHOPPY",
  "biasStrength": number (0-100),
  "nearestLevel": {
    "price": number,
    "type": string,
    "label": string,
    "expectedBehavior": "PIN" | "BOUNCE" | "BREAK" | "MAGNET",
    "behaviorReasoning": string
  },
  "tradeSetups": [
    {
      "direction": "BUY" | "SELL",
      "confidence": number (0-100),
      "triggerCondition": string,
      "entryZone": string,
      "stopLevel": string,
      "targetLevel": string,
      "rationale": string,
      "gexLevelUsed": string
    }
  ],
  "keyObservations": string[],
  "dangerFlags": string[],
  "bestSetupIndex": number | null
}`;

  // Format key levels for Claude
  const levelList = (gexLevels?.keyLevels || []).map((l, i) => {
    const dist = currentPrice ? (l.price - currentPrice).toFixed(2) : '?';
    const sign = parseFloat(dist) > 0 ? '+' : '';
    return `  ${i + 1}. [${l.type.padEnd(16)}] $${l.price}  (${sign}${dist} from price)  str:${l.strength?.toFixed(1)}  — ${l.label}`;
  }).join('\n') || '  No levels computed yet';

  // Format recent tape
  const tape = recentBars.slice(-12).map((b, i) =>
    `  ${String(i + 1).padStart(2)}. C:${b.close ?? b.c}  Vol:${b.volume ?? b.vol}  ` +
    `AskVol:${b.askVol ?? 0}  BidVol:${b.bidVol ?? 0}  ` +
    `Δ:${(b.delta ?? 0) >= 0 ? '+' : ''}${Math.round(b.delta ?? 0)}  ` +
    `Imb:${Math.round(((b.imbalance ?? b.imb) ?? 0.5) * 100)}%` +
    `${(b.absorption || b.abs) ? '  ★ABS' : ''}`
  ).join('\n') || '  No tape data';

  const USER = `
SYMBOL: ${symbol}
CURRENT PRICE: ${currentPrice}
TIMESTAMP: ${new Date().toISOString()}

═══ GEX / KEY LEVELS (ranked by structural strength) ═══
${levelList}

VOLUME PROFILE:
  POC (Point of Control): ${gexLevels?.poc ?? 'N/A'}
  Value Area High:        ${gexLevels?.vah ?? 'N/A'}
  Value Area Low:         ${gexLevels?.val ?? 'N/A'}
  VWAP:                   ${gexLevels?.vwap ?? 'N/A'}
  VWAP ±1σ:               ${gexLevels?.vwapSD1L ?? 'N/A'} / ${gexLevels?.vwapSD1H ?? 'N/A'}
  VWAP ±2σ:               ${gexLevels?.vwapSD2L ?? 'N/A'} / ${gexLevels?.vwapSD2H ?? 'N/A'}
  Session High/Low:       ${gexLevels?.sessionHigh ?? 'N/A'} / ${gexLevels?.sessionLow ?? 'N/A'}

ACTIVE DELTA FLIP ZONES:
${(gexLevels?.deltaReversals || []).map(r =>
  `  • $${r.price}  ${r.direction === 'flip_buy' ? '↑ Buy Flip' : '↓ Sell Flip'}  cumDelta:${r.delta}`
).join('\n') || '  None detected'}

ABSORPTION ZONES:
${(gexLevels?.absorptionZones || []).map(z =>
  `  • $${z.price}  ${z.direction === 'buy' ? '↑ Buy-side' : '↓ Sell-side'} absorbed  Vol:${z.volume?.toLocaleString()}`
).join('\n') || '  None detected'}

═══ LIVE ORDER FLOW TAPE (12 bars, newest last) ═══
${tape}

ENGINE METRICS:
  Cum Delta:  ${orderFlowMetrics?.cumDelta ?? 'N/A'}
  ATR:        ${orderFlowMetrics?.atr ?? 'N/A'} ticks (regime: ${orderFlowMetrics?.regime ?? 'N/A'})
  EMA slope:  ${orderFlowMetrics?.emaDiff ?? 'N/A'}  (trend: ${orderFlowMetrics?.trend ?? 'N/A'})
  Imbalance:  ${orderFlowMetrics?.imbalance ?? 'N/A'}

BOT RISK CONFIG:
  SL Ticks:  ${botConfig.slTicks ?? 12}
  TP Ticks:  ${botConfig.tpTicks ?? 24}
  R:R:       ${botConfig.riskRewardRatio ?? 2}:1
  Qty:       ${botConfig.qty ?? 1} contracts

Based on the GEX key levels and live order flow, what is the highest-probability trade setup?
Respond with JSON only.`.trim();

  const raw = await _chat(SYSTEM, USER, 800);
  const fallback = {
    bias:             'NEUTRAL',
    biasStrength:     0,
    nearestLevel:     null,
    tradeSetups:      [],
    keyObservations:  ['GEX analysis unavailable — ANTHROPIC_API_KEY not configured.'],
    dangerFlags:      [],
    bestSetupIndex:   null,
  };
  const result = _parseJSON(raw, fallback);
  logger.info(
    `[claudeAI] GEX analysis ${symbol} @ ${currentPrice}: ` +
    `bias=${result.bias} str=${result.biasStrength}% ` +
    `setups=${result.tradeSetups?.length || 0} ` +
    `bestSetup=${result.bestSetupIndex != null ? result.tradeSetups?.[result.bestSetupIndex]?.direction : 'none'}`
  );
  return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  validateSignal,
  analyzeMarket,
  reviewBotConfig,
  indicatorInsight,
  analyzeOrderFlow,
  analyzeGEXLevels,
  isConfigured: () => !!(config.claude.apiKey && config.claude.apiKey !== 'your_anthropic_api_key_here'),
};
