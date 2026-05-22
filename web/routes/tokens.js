'use strict';

const express = require('express');
const tokens = require('../../tokens');
const rooms = require('../../rooms');
const audit = require('../audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware');
const { log } = require('../../log');

const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const GUILD_ID_RE = /^\d{17,20}$/;
const MAX_HOURS = 24 * 365;

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const list = await tokens.list();
    const flash = await req.consumeFlash();
    res.render('tokens', {
      title: 'Tokens',
      session: req.session,
      tokens: list,
      flash,
      federatedGuilds: rooms.listAllFederatedGuilds(),
    });
  } catch (e) { next(e); }
});

function parseHours(raw) {
  const n = parseInt(String(raw || '168'), 10);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_HOURS) return null;
  return n;
}

router.post('/create-join', requireCsrf, async (req, res, next) => {
  try {
    const room = String(req.body.room || '').toLowerCase().trim();
    const guildId = String(req.body.guildId || '').trim();
    const hours = parseHours(req.body.hours);

    if (!ROOM_NAME_RE.test(room)) {
      await res.flash({ error: 'Invalid room name (a-z, 0-9, dashes; 2-31 chars; must start with letter or digit).' });
      return res.redirect('/tokens');
    }
    if (guildId && !GUILD_ID_RE.test(guildId)) {
      await res.flash({ error: 'Invalid guild ID (expected 17-20 digits).' });
      return res.redirect('/tokens');
    }
    if (hours === null) {
      await res.flash({ error: `Expiry hours must be a positive integer up to ${MAX_HOURS}.` });
      return res.redirect('/tokens');
    }

    const result = await tokens.create({
      room,
      guildId: guildId || undefined,
      expiresInMs: hours * 3600 * 1000,
    });

    log('WebUI', `token create (join) room=${room} guildBind=${guildId || 'any'} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'token.create-join',
      details: { room, guildBind: guildId || null, hours, tokenPrefix: result.token.slice(0, 13) },
    });
    await res.flash({
      ok: 'Join token created. Copy it now — it will not be shown again.',
      newToken: result.token,
      newTokenDetails: {
        kind: 'join',
        room: result.room,
        guildId: result.guildId,
        expiresAt: result.expiresAt,
      },
    });
    res.redirect('/tokens');
  } catch (e) { next(e); }
});

router.post('/create-kick', requireCsrf, async (req, res, next) => {
  try {
    const room = String(req.body.room || '').toLowerCase().trim();
    const targetGuildId = String(req.body.targetGuildId || '').trim();
    const hours = parseHours(req.body.hours);

    if (!ROOM_NAME_RE.test(room)) {
      await res.flash({ error: 'Invalid room name.' });
      return res.redirect('/tokens');
    }
    if (!GUILD_ID_RE.test(targetGuildId)) {
      await res.flash({ error: 'Pick a target server from the dropdown.' });
      return res.redirect('/tokens');
    }
    if (hours === null) {
      await res.flash({ error: `Expiry hours must be a positive integer up to ${MAX_HOURS}.` });
      return res.redirect('/tokens');
    }

    const result = await tokens.createKick({
      room,
      targetGuildId,
      expiresInMs: hours * 3600 * 1000,
    });

    log('WebUI', `token create-kick room=${room} target=${targetGuildId} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'token.create-kick',
      details: { room, targetGuildId, hours, tokenPrefix: result.token.slice(0, 13) },
    });
    await res.flash({
      ok: 'Kick token created. Copy it now — it will not be shown again.',
      newToken: result.token,
      newTokenDetails: {
        kind: 'kick',
        room: result.room,
        targetGuildId: result.targetGuildId,
        expiresAt: result.expiresAt,
      },
    });
    res.redirect('/tokens');
  } catch (e) { next(e); }
});

router.post('/revoke', requireRole('admin'), requireCsrf, async (req, res, next) => {
  const prefix = String(req.body.prefix || '').trim();
  try {
    if (!prefix || prefix.length < 8) {
      await res.flash({ error: 'Token prefix must be at least 8 characters.' });
      return res.redirect('/tokens');
    }
    const result = await tokens.revoke(prefix);
    log('WebUI', `token revoke ${result.token.slice(0, 13)}... room=${result.room || '(unknown)'} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'token.revoke',
      details: { room: result.room || null, tokenPrefix: result.token.slice(0, 13) },
    });
    await res.flash({ ok: `Revoked token for room "${result.room || '(unknown)'}".` });
    res.redirect('/tokens');
  } catch (e) {
    if (['NO_MATCH', 'AMBIGUOUS', 'PREFIX_TOO_SHORT'].includes(e.code)) {
      await res.flash({ error: e.message });
      return res.redirect('/tokens');
    }
    next(e);
  }
});

module.exports = router;
