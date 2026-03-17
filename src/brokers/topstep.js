'use strict';
/**
 * topstep.js  –  Tradovate authentication helper
 *
 * Provides getAccessToken() used by the live Tradovate WebSocket market data
 * feed (services/tradovateMarketFeed.js).
 *
 * Order execution for TopstepX/Topstep accounts routes through the ProjectX
 * Gateway API — see brokers/topstepx.js (aliased as 'topstep' in brokers/index.js).
 *
 * cfg keys required: { username, password, appId?, appVersion?, sim? }
 */

const axios  = require('axios');
const logger = require('../utils/logger');
const config = require('../config');

// Token cache keyed by "username:mode" to avoid re-authenticating every request
const tokenCache = {};

function getBaseUrl(sim) {
  return sim
    ? 'https://demo.tradovateapi.com/v1'
    : 'https://live.tradovateapi.com/v1';
}

/**
 * Authenticate with Tradovate and return a cached access token.
 * Token is reused until 60 seconds before expiry.
 */
async function getAccessToken(cfg) {
  const cacheKey = `${cfg.username}:${cfg.sim ? 'sim' : 'live'}`;
  const cached   = tokenCache[cacheKey];
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const baseUrl = getBaseUrl(cfg.sim);
  const res = await axios.post(`${baseUrl}/auth/accesstokenrequest`, {
    name:       cfg.username,
    password:   cfg.password,
    appId:      cfg.appId      || config.tradovate.appId,
    appVersion: cfg.appVersion || config.tradovate.appVersion,
    clientId:   cfg.clientId   || cfg.appId || config.tradovate.appId,
  });

  const { accessToken, expirationTime } = res.data;
  tokenCache[cacheKey] = {
    accessToken,
    expiresAt: new Date(expirationTime).getTime(),
  };

  logger.info(`[Tradovate] Authenticated: ${cfg.username}`);
  return accessToken;
}

module.exports = { getAccessToken };

