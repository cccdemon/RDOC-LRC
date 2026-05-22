'use strict';

const path = require('path');
const express = require('express');

const session = require('./session');
const oauth = require('./oauth');
const users = require('./users');
const { log, logErr } = require('../log');

function requireAuth(req, res, next) {
  if (!req.session) return res.redirect(`/login?to=${encodeURIComponent(req.originalUrl)}`);
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session) return res.redirect(`/login?to=${encodeURIComponent(req.originalUrl)}`);
    if (role === 'admin' && req.session.role !== 'admin') {
      return res.status(403).render('error', { title: 'Forbidden', message: 'Admin role required for this page.', session: req.session });
    }
    next();
  };
}

function mountWeb(app, redis) {
  const cfg = {
    clientId: process.env.DISCORD_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_OAUTH_CLIENT_SECRET || '',
    publicUrl: (process.env.WEB_PUBLIC_URL || '').replace(/\/+$/, ''),
    bootstrapAdminId: process.env.RDOC_BOOTSTRAP_ADMIN_ID || '',
  };

  if (!cfg.clientId || !cfg.clientSecret || !cfg.publicUrl) {
    log('WebUI', 'Disabled (DISCORD_OAUTH_CLIENT_ID, DISCORD_OAUTH_CLIENT_SECRET, and WEB_PUBLIC_URL must all be set)');
    return false;
  }

  const redirectUri = `${cfg.publicUrl}/auth/callback`;

  users.init(redis);
  oauth.init({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri }, redis);

  if (cfg.bootstrapAdminId) {
    users.bootstrapAdmin(cfg.bootstrapAdminId)
      .then(created => { if (created) log('WebUI', `bootstrap admin granted to ${cfg.bootstrapAdminId}`); })
      .catch(e => logErr('WebUI', `bootstrapAdmin failed: ${e.message}`));
  }

  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(session.sessionMiddleware(redis));

  app.get('/login', (req, res) => {
    if (req.session) return res.redirect('/');
    res.render('login', {
      title: 'Sign in',
      error: req.query.error ? String(req.query.error) : null,
      to: req.query.to ? String(req.query.to) : '/',
      session: null,
    });
  });

  app.get('/auth/start', async (req, res, next) => {
    try {
      const url = await oauth.startFlow(req.query.to ? String(req.query.to) : '/');
      res.redirect(url);
    } catch (e) {
      logErr('WebUI', `startFlow: ${e.message}`);
      res.redirect('/login?error=oauth_start_failed');
    }
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      const code = req.query.code ? String(req.query.code) : '';
      const state = req.query.state ? String(req.query.state) : '';
      const oauthError = req.query.error ? String(req.query.error) : '';
      if (oauthError) return res.redirect(`/login?error=${encodeURIComponent(oauthError)}`);
      if (!code || !state) return res.redirect('/login?error=missing_params');

      const returnTo = await oauth.consumeState(state);
      if (returnTo === null) return res.redirect('/login?error=invalid_state');

      const tokenResp = await oauth.exchangeCode(code);
      const me = await oauth.fetchMe(tokenResp.access_token);

      const user = await users.getUser(me.id);
      if (!user) {
        logErr('WebUI', `unauthorized login attempt: discordId=${me.id} username=${me.username}`);
        return res.status(403).render('error', {
          title: 'Not authorized',
          message: `Your Discord account "${me.username}" (ID ${me.id}) is not authorized to use this UI. Ask the admin to add you.`,
          session: null,
        });
      }

      await users.setUsername(me.id, me.username);
      await res.login({
        userId: me.id,
        username: me.username,
        role: user.role,
        loginAt: String(Date.now()),
      });
      log('WebUI', `login userId=${me.id} username=${me.username} role=${user.role}`);
      const safe = /^\/[^/].*/.test(returnTo) ? returnTo : '/';
      res.redirect(safe);
    } catch (e) {
      logErr('WebUI', `callback: ${e.message}`);
      res.redirect('/login?error=callback_failed');
    }
  });

  app.post('/logout', async (req, res) => {
    const uid = req.session?.userId;
    await res.logout();
    if (uid) log('WebUI', `logout userId=${uid}`);
    res.redirect('/login');
  });

  app.get('/', requireAuth, (req, res) => {
    res.render('dashboard', {
      title: 'Dashboard',
      session: req.session,
    });
  });

  app.use((err, req, res, next) => {
    logErr('WebUI', err.stack || err.message);
    if (res.headersSent) return next(err);
    res.status(500).render('error', { title: 'Error', message: 'Internal error.', session: req.session || null });
  });

  log('WebUI', `Mounted at ${cfg.publicUrl} (redirect ${redirectUri})`);
  return true;
}

module.exports = { mountWeb, requireAuth, requireRole };
