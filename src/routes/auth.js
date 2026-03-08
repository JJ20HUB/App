'use strict';
/**
 * auth.js  (routes)
 * POST /auth/register          - create account
 * POST /auth/login             - get JWT
 * GET  /auth/discord           - redirect to Discord OAuth
 * GET  /auth/discord/callback  - Discord OAuth callback
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const db     = require('../models/db');
const config = require('../config');
const logger = require('../utils/logger');

const router = express.Router();

// ── Register ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const exists = db.get('users').find((u) => u.email === email || u.username === username).value();
    if (exists) {
      return res.status(409).json({ error: 'Username or email already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      id: uuidv4(),
      username,
      email,
      passwordHash,
      createdAt: new Date().toISOString(),
    };

    db.get('users').push(user).write();
    logger.info(`[auth] New user registered: ${username} (${email})`);

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    return res.status(201).json({ message: 'Account created.', token });
  } catch (err) {
    logger.error(`[auth/register] ${err.message}`);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const user = db.get('users').find({ email }).value();
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    logger.info(`[auth] User logged in: ${user.username}`);
    return res.json({ token, username: user.username, email: user.email });
  } catch (err) {
    logger.error(`[auth/login] ${err.message}`);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// ── Discord OAuth – Step 1: redirect to Discord ───────────────────────────────
router.get('/discord', (req, res) => {
  const { clientId, redirectUri } = config.discord;
  if (!clientId || clientId === 'your_discord_client_id') {
    return res.status(501).send(
      '<h2>Discord OAuth not configured</h2>' +
      '<p>Set <code>DISCORD_CLIENT_ID</code>, <code>DISCORD_CLIENT_SECRET</code>, and ' +
      '<code>DISCORD_REDIRECT_URI</code> in your <code>.env</code> file, then restart the server.</p>'
    );
  }
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'identify email',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ── Discord OAuth – Step 2: exchange code for token, upsert user ──────────────
router.get('/discord/callback', async (req, res) => {
  const { code, error } = req.query;
  const { clientId, clientSecret, redirectUri } = config.discord;

  if (error) {
    logger.warn(`[auth/discord] OAuth cancelled: ${error}`);
    return res.redirect('/?discord_error=' + encodeURIComponent(error));
  }
  if (!code) {
    return res.redirect('/?discord_error=no_code');
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;

    // Fetch Discord user info
    const profileRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const { id: discordId, username: discordUsername, email: discordEmail, discriminator } = profileRes.data;

    // Build a display name (new system: no discriminator; old: user#1234)
    const displayName = discriminator && discriminator !== '0'
      ? `${discordUsername}#${discriminator}`
      : discordUsername;

    // Upsert: find existing user by discordId or email
    let user = db.get('users').find({ discordId }).value();
    if (!user && discordEmail) {
      user = db.get('users').find({ email: discordEmail }).value();
    }

    if (user) {
      // Attach discordId to existing account if not already set
      if (!user.discordId) {
        db.get('users').find({ id: user.id }).assign({ discordId }).write();
        user.discordId = discordId;
      }
      logger.info(`[auth/discord] Existing user signed in: ${user.username}`);
    } else {
      // Create new account from Discord profile
      const baseUsername = displayName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30);
      let safeUsername = baseUsername;
      let suffix = 1;
      while (db.get('users').find({ username: safeUsername }).value()) {
        safeUsername = `${baseUsername}_${suffix++}`;
      }
      user = {
        id:           uuidv4(),
        username:     safeUsername,
        email:        discordEmail || `${discordId}@discord.invalid`,
        passwordHash: null,   // Discord accounts have no local password
        discordId,
        createdAt:    new Date().toISOString(),
      };
      db.get('users').push(user).write();
      logger.info(`[auth/discord] New user created via Discord: ${user.username}`);
    }

    // Issue JWT
    const jwtToken = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    // Redirect to frontend with token embedded in the URL fragment
    const payload = encodeURIComponent(JSON.stringify({ token: jwtToken, username: user.username, email: user.email }));
    res.redirect(`/?discord_session=${payload}`);

  } catch (err) {
    logger.error(`[auth/discord/callback] ${err.message}`);
    res.redirect('/?discord_error=' + encodeURIComponent('Authentication failed. Please try again.'));
  }
});

module.exports = router;
