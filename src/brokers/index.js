'use strict';
/**
 * index.js  (broker factory)
 * Routes an order to the correct broker adapter based on the webhook config.
 */

const topstepx = require('./topstepx');
const lucid    = require('./lucid');
const bitunix  = require('./bitunix');
const logger = require('../utils/logger');

const BROKERS = {
  topstepx,
  topstep: topstepx,   // alias – both names route to the TopstepX adapter
  lucid,
  bitunix,
};

/**
 * Execute an order through the correct broker.
 *
 * @param {string} brokerName   - 'topstepx' | 'topstep' | 'lucid' | 'bitunix'
 * @param {object} order        - normalised order object from alertParser
 * @param {object} brokerConfig - per-user broker credentials stored in webhook
 * @returns {object}            - broker response
 */
async function executeOrder(brokerName, order, brokerConfig) {
  const broker = BROKERS[brokerName.toLowerCase()];
  if (!broker) {
    throw new Error(`Unsupported broker: "${brokerName}". Supported: ${Object.keys(BROKERS).join(', ')}`);
  }
  logger.info(`[BrokerRouter] Routing order to ${brokerName} | ${order.action} ${order.qty} ${order.ticker}`);
  return broker.placeOrder(order, brokerConfig);
}

/**
 * List of supported broker names.
 */
const supportedBrokers = Object.keys(BROKERS);

module.exports = { executeOrder, supportedBrokers, BROKERS };
