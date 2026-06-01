'use strict';

const path = require('path');
const express = require('express');

const session = require('./session');
const oauth = require('./oauth');
const users = require('./users');
const { requireAuth, requireRole, requireCsrf } = require('./middleware');
const audit = require('./audit');
const ratelimit = require('./ratelimit');
const tokensRouter = require('./routes/tokens');
const roomsRouter = require('./routes/rooms');
const createUsersRouter = require('./routes/users');
const auditRouter = require('./routes/audit');
const rooms = require('../rooms');
const tokensModule = require('../tokens');
const bot = require('../bot');
const { log, logErr } = require('../log');

function mountWeb(app, redis) {
  const cfg = {
    clientId: process.env.DISCORD_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_OAUTH_CLIENT_SECRET || '',
    publicUrl: (process.env.WEB_PUBLIC_URL || '').replace(/\/+$/, ''),
    bootstrapAdminId: process.env.RDOC_BOOTSTRAP_ADMIN_ID || '',
    appId: process.env.DISCORD_APP_ID || '',
  };

  if (!cfg.clientId || !cfg.clientSecret || !cfg.publicUrl) {
    log('WebUI', 'Disabled (DISCORD_OAUTH_CLIENT_ID, DISCORD_OAUTH_CLIENT_SECRET, and WEB_PUBLIC_URL must all be set)');
    return false;
  }

  const redirectUri = `${cfg.publicUrl}/auth/callback`;

  users.init(redis);
  audit.init(redis);
  ratelimit.init(redis);
  oauth.init({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri }, redis);

  const authLimiter = ratelimit.limit({ bucket: 'auth', max: 10, windowSec: 60 });

  if (cfg.bootstrapAdminId) {
    users.bootstrapAdmin(cfg.bootstrapAdminId)
      .then(created => { if (created) log('WebUI', `bootstrap admin granted to ${cfg.bootstrapAdminId}`); })
      .catch(e => logErr('WebUI', `bootstrapAdmin failed: ${e.message}`));
  }

  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
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

  app.get('/auth/start', authLimiter, async (req, res, next) => {
    try {
      const url = await oauth.startFlow(req.query.to ? String(req.query.to) : '/');
      res.redirect(url);
    } catch (e) {
      logErr('WebUI', `startFlow: ${e.message}`);
      res.redirect('/login?error=oauth_start_failed');
    }
  });

  app.get('/auth/callback', authLimiter, async (req, res) => {
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
        audit.append({ userId: me.id, username: me.username, action: 'auth.login.unauthorized', details: {} });
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
      audit.append({ userId: me.id, username: me.username, action: 'auth.login', details: { role: user.role } });
      const safe = /^\/[^/].*/.test(returnTo) ? returnTo : '/';
      res.redirect(safe);
    } catch (e) {
      logErr('WebUI', `callback: ${e.message}`);
      res.redirect('/login?error=callback_failed');
    }
  });

  app.post('/logout', requireCsrf, async (req, res) => {
    const uid = req.session?.userId;
    const uname = req.session?.username;
    await res.logout();
    if (uid) {
      log('WebUI', `logout userId=${uid}`);
      audit.append({ userId: uid, username: uname, action: 'auth.logout', details: {} });
    }
    res.redirect('/login');
  });

  app.get('/', requireAuth, async (req, res, next) => {
    try {
      const summary = rooms.summary();
      const roomNames = Object.keys(summary);
      const channelCount = roomNames.reduce((sum, name) => sum + summary[name], 0);
      const allTokens = await tokensModule.list();
      const botStatus = bot.getBotStatus();
      const inviteUrl = cfg.appId
        ? `https://discord.com/oauth2/authorize?client_id=${cfg.appId}&permissions=1065689115712&integration_type=0&scope=bot`
        : null;
      res.render('dashboard', {
        title: 'Dashboard',
        session: req.session,
        inviteUrl,
        stats: {
          botReady: botStatus.ready,
          guildCount: botStatus.guilds,
          roomCount: roomNames.length,
          channelCount,
          tokenCount: allTokens.length,
          joinTokens: allTokens.filter(t => t.kind === 'join').length,
          kickTokens: allTokens.filter(t => t.kind === 'kick').length,
        },
      });
    } catch (e) { next(e); }
  });

  app.use('/tokens', tokensRouter);
  app.use('/rooms', roomsRouter);
  app.use('/users', createUsersRouter(redis));
  app.use('/audit', auditRouter);

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Not found',
      message: `Page not found: ${req.originalUrl}`,
      session: req.session || null,
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

module.exports = { mountWeb, requireAuth, requireRole, requireCsrf };
