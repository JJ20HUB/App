'use strict';

require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 80,
  env: process.env.NODE_ENV || 'development',

  jwt: {
    secret: process.env.JWT_SECRET || 'dev_secret_change_in_production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  tradovate: {
    baseUrl: process.env.TRADOVATE_BASE_URL || 'https://demo.tradovateapi.com',
    appId: process.env.TRADOVATE_APP_ID || '',
    appVersion: process.env.TRADOVATE_APP_VERSION || '1.0',
  },

  lucid: {
    baseUrl: process.env.LUCID_BASE_URL || 'https://api.lucidmarkets.com',
    apiVersion: process.env.LUCID_API_VERSION || 'v1',
  },

  db: {
    path: process.env.DB_PATH || './data/db.json',
  },

  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost',

  discord: {
    clientId:     process.env.DISCORD_CLIENT_ID     || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    redirectUri:  process.env.DISCORD_REDIRECT_URI  || 'http://localhost:3000/auth/discord/callback',
  },

  webhookRateLimit: parseInt(process.env.WEBHOOK_RATE_LIMIT, 10) || 60,
};
