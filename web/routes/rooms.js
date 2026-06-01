'use strict';

const express = require('express');
const rooms = require('../../rooms');
const bot = require('../../bot');
const audit = require('../audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware');
const { log } = require('../../log');

const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const WEBLINK_MODES = ['none', 'allowlist'];
const USER_ID_RE = /^\d{17,20}$/;

const router = express.Router();
router.use(requireAuth);

function liveClientOrNull() {
  const client = bot.getClient();
  if (!client || typeof client.isReady !== 'function' || !client.isReady()) return null;
  return client;
}

router.get('/', async (req, res, next) => {
  try {
    const summary = rooms.summary();
    const list = Object.keys(summary).sort().map(name => {
      const members = rooms.getRoomMembers(name);
      return {
        name,
        channels: members.length,
        guilds: new Set(members.map(m => m.guildId)).size,
      };
    });
    const flash = await req.consumeFlash();
    res.render('rooms', {
      title: 'Rooms',
      session: req.session,
      rooms: list,
      flash,
    });
  } catch (e) { next(e); }
});

router.get('/:room', async (req, res, next) => {
  try {
    const roomName = String(req.params.room || '').toLowerCase();
    if (!ROOM_NAME_RE.test(roomName)) {
      return res.status(404).render('error', { title: 'Not found', message: `Room "${roomName}" not found.`, session: req.session });
    }
    const members = rooms.getRoomMembers(roomName);
    if (members.length === 0) {
      return res.status(404).render('error', { title: 'Not found', message: `Room "${roomName}" has no members or does not exist.`, session: req.session });
    }
    const sorted = [...members].sort((a, b) =>
      (a.guildName || '').localeCompare(b.guildName || '') ||
      (a.channelName || '').localeCompare(b.channelName || '')
    );
    const [rules, bannedUsers, badwordConfig, mentionMode] = await Promise.all([
      rooms.getRoomRules(roomName),
      rooms.getBannedUsers(roomName),
      rooms.getBadwordConfig(roomName),
      rooms.getMentionMode(roomName),
    ]);
    const flash = await req.consumeFlash();
    res.render('room-detail', {
      title: `Room: ${roomName}`,
      session: req.session,
      room: roomName,
      members: sorted,
      rules: rules || '',
      rulesMax: rooms.ROOM_RULES_MAX,
      bannedUsers,
      badwordConfig,
      mentionMode,
      flash,
    });
  } catch (e) { next(e); }
});

router.post('/:room/prune', requireRole('admin'), requireCsrf, async (req, res, next) => {
  const roomName = String(req.params.room || '').toLowerCase();
  try {
    if (!ROOM_NAME_RE.test(roomName)) {
      await res.flash({ error: 'Invalid room name.' });
      return res.redirect('/rooms');
    }
    const client = liveClientOrNull();
    if (!client) {
      await res.flash({ error: 'Bot is not connected to Discord yet. Try again in a moment.' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
    }
    const result = await rooms.pruneStale(client, { roomFilter: roomName });
    log('WebUI', `prune room=${roomName} checked=${result.checked} evicted=${result.evicted} skipped=${result.skipped} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'room.prune',
      details: { room: roomName, checked: result.checked, evicted: result.evicted, skipped: result.skipped },
    });
    await res.flash({
      ok: `Pruned ${result.evicted} of ${result.checked} channel(s) in "${roomName}" (${result.skipped} skipped due to transient errors).`,
      pruneDetails: result.details,
    });
    if (result.evicted >= result.checked && result.checked > 0) {
      return res.redirect('/rooms');
    }
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/:room/check', requireRole('admin'), requireCsrf, async (req, res, next) => {
  const roomName = String(req.params.room || '').toLowerCase();
  try {
    if (!ROOM_NAME_RE.test(roomName)) {
      await res.flash({ error: 'Invalid room name.' });
      return res.redirect('/rooms');
    }
    const client = liveClientOrNull();
    if (!client) {
      await res.flash({ error: 'Bot is not connected to Discord yet. Try again in a moment.' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
    }
    const results = await rooms.checkHealth(client, { roomFilter: roomName });
    const issueCount = results.filter(r => !r.ok).length;
    log('WebUI', `check-health room=${roomName} checked=${results.length} issues=${issueCount} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'room.check-health',
      details: { room: roomName, checked: results.length, issues: issueCount },
    });
    await res.flash({ checkDetails: results });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.get('/:room/weblink', requireRole('admin'), async (req, res, next) => {
  try {
    const roomName = String(req.params.room || '').toLowerCase();
    if (!ROOM_NAME_RE.test(roomName)) {
      return res.status(404).render('error', { title: 'Not found', message: `Room "${roomName}" not found.`, session: req.session });
    }
    if (rooms.getRoomMembers(roomName).length === 0) {
      return res.status(404).render('error', { title: 'Not found', message: `Room "${roomName}" has no members or does not exist.`, session: req.session });
    }
    const config = await rooms.getWeblinkConfig('room', roomName);
    const flash = await req.consumeFlash();
    res.render('room-weblink', {
      title: `Weblink: ${roomName}`,
      session: req.session,
      room: roomName,
      config,
      flash,
    });
  } catch (e) { next(e); }
});

async function ensureValidRoom(req, res) {
  const roomName = String(req.params.room || '').toLowerCase();
  if (!ROOM_NAME_RE.test(roomName)) {
    await res.flash({ error: 'Invalid room name.' });
    res.redirect('/rooms');
    return null;
  }
  if (rooms.getRoomMembers(roomName).length === 0) {
    await res.flash({ error: `Room "${roomName}" has no members or does not exist.` });
    res.redirect('/rooms');
    return null;
  }
  return roomName;
}

router.post('/:room/weblink/mode', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const mode = String(req.body.mode || '').trim();
    if (!WEBLINK_MODES.includes(mode)) {
      await res.flash({ error: 'Mode must be "none" or "allowlist".' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}/weblink`);
    }
    await rooms.setWeblinkMode('room', roomName, mode);
    log('WebUI', `weblink mode room=${roomName} mode=${mode} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'weblink.set-mode',
      details: { room: roomName, mode },
    });
    await res.flash({ ok: `Weblink mode for "${roomName}" set to "${mode}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}/weblink`);
  } catch (e) { next(e); }
});

router.post('/:room/weblink/add', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const domain = String(req.body.domain || '').trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) {
      await res.flash({ error: `Invalid domain "${domain}". Use formats like example.com or *.example.com.` });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}/weblink`);
    }
    await rooms.addToWeblinkList('room', roomName, domain);
    log('WebUI', `weblink add room=${roomName} domain=${domain} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'weblink.add-domain',
      details: { room: roomName, domain },
    });
    await res.flash({ ok: `Added "${domain}" to allowlist for room "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}/weblink`);
  } catch (e) { next(e); }
});

router.post('/:room/weblink/remove', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const domain = String(req.body.domain || '').trim().toLowerCase();
    if (!domain) {
      await res.flash({ error: 'Missing domain.' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}/weblink`);
    }
    await rooms.removeFromWeblinkList('room', roomName, domain);
    log('WebUI', `weblink remove room=${roomName} domain=${domain} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'weblink.remove-domain',
      details: { room: roomName, domain },
    });
    await res.flash({ ok: `Removed "${domain}" from allowlist for room "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}/weblink`);
  } catch (e) { next(e); }
});

router.post('/:room/weblink/clear', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    await rooms.clearWeblinkList('room', roomName);
    log('WebUI', `weblink clear room=${roomName} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'weblink.clear',
      details: { room: roomName },
    });
    await res.flash({ ok: `Cleared all domains from allowlist for room "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}/weblink`);
  } catch (e) { next(e); }
});

router.post('/:room/rules', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const raw = String(req.body.rules || '').replace(/\r\n/g, '\n').trim();
    if (raw.length > rooms.ROOM_RULES_MAX) {
      await res.flash({ error: `Rules too long (${raw.length} chars, max ${rooms.ROOM_RULES_MAX}).` });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
    }
    await rooms.setRoomRules(roomName, raw);
    log('WebUI', `rules ${raw ? 'set' : 'cleared'} room=${roomName} chars=${raw.length} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: raw ? 'rules.set' : 'rules.clear',
      details: { room: roomName, chars: raw.length },
    });
    await res.flash({ ok: raw
      ? `Rules updated for "${roomName}" (${raw.length} chars).`
      : `Rules cleared for "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/:room/rules/clear', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    await rooms.setRoomRules(roomName, null);
    log('WebUI', `rules cleared room=${roomName} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'rules.clear',
      details: { room: roomName },
    });
    await res.flash({ ok: `Rules cleared for "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/:room/mention-mode', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const mode = String(req.body.mode || '').trim();
    if (!rooms.MENTION_MODES.includes(mode)) {
      await res.flash({ error: 'Invalid mention mode.' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
    }
    await rooms.setMentionMode(roomName, mode);
    audit.append({ userId: req.session.userId, username: req.session.username, action: 'moderation.mention-mode', details: { room: roomName, mode } });
    await res.flash({ ok: `Mention mode for "${roomName}" set to "${mode}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/:room/bans/add', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const userId = String(req.body.userId || '').trim();
    if (!USER_ID_RE.test(userId)) {
      await res.flash({ error: 'Invalid Discord user ID.' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
    }
    await rooms.addBannedUser(roomName, userId);
    audit.append({ userId: req.session.userId, username: req.session.username, action: 'moderation.ban-user', details: { room: roomName, bannedUserId: userId } });
    await res.flash({ ok: `User ${userId} banned from relaying in "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/:room/bans/remove', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const userId = String(req.body.userId || '').trim();
    if (!userId) {
      await res.flash({ error: 'Missing Discord user ID.' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
    }
    await rooms.removeBannedUser(roomName, userId);
    audit.append({ userId: req.session.userId, username: req.session.username, action: 'moderation.unban-user', details: { room: roomName, bannedUserId: userId } });
    await res.flash({ ok: `User ${userId} unbanned in "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/:room/badwords/mode', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const mode = String(req.body.mode || '').trim();
    if (!rooms.BADWORD_MODES.includes(mode)) {
      await res.flash({ error: 'Invalid bad-word mode.' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
    }
    await rooms.setBadwordMode(roomName, mode);
    audit.append({ userId: req.session.userId, username: req.session.username, action: 'moderation.badword-mode', details: { room: roomName, mode } });
    await res.flash({ ok: `Bad-word mode for "${roomName}" set to "${mode}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/:room/badwords/add', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const word = String(req.body.word || '').trim();
    if (!word) {
      await res.flash({ error: 'Bad-word entry cannot be empty.' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
    }
    await rooms.addBadword(roomName, word);
    audit.append({ userId: req.session.userId, username: req.session.username, action: 'moderation.badword-add', details: { room: roomName } });
    await res.flash({ ok: `Bad-word entry added to "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/:room/badwords/remove', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    const word = String(req.body.word || '').trim();
    if (!word) {
      await res.flash({ error: 'Missing bad-word entry.' });
      return res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
    }
    await rooms.removeBadword(roomName, word);
    audit.append({ userId: req.session.userId, username: req.session.username, action: 'moderation.badword-remove', details: { room: roomName } });
    await res.flash({ ok: `Bad-word entry removed from "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/:room/badwords/clear', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const roomName = await ensureValidRoom(req, res);
    if (!roomName) return;
    await rooms.clearBadwords(roomName);
    audit.append({ userId: req.session.userId, username: req.session.username, action: 'moderation.badword-clear', details: { room: roomName } });
    await res.flash({ ok: `Bad-word list cleared for "${roomName}".` });
    res.redirect(`/rooms/${encodeURIComponent(roomName)}`);
  } catch (e) { next(e); }
});

router.post('/prune-all', requireRole('admin'), requireCsrf, async (req, res, next) => {
  try {
    const client = liveClientOrNull();
    if (!client) {
      await res.flash({ error: 'Bot is not connected to Discord yet. Try again in a moment.' });
      return res.redirect('/rooms');
    }
    const result = await rooms.pruneStale(client);
    log('WebUI', `prune all checked=${result.checked} evicted=${result.evicted} skipped=${result.skipped} by=${req.session.userId}`);
    audit.append({
      userId: req.session.userId, username: req.session.username,
      action: 'room.prune-all',
      details: { checked: result.checked, evicted: result.evicted, skipped: result.skipped },
    });
    await res.flash({
      ok: `Pruned ${result.evicted} of ${result.checked} channel(s) across all rooms (${result.skipped} skipped due to transient errors).`,
      pruneDetails: result.details,
    });
    res.redirect('/rooms');
  } catch (e) { next(e); }
});

module.exports = router;
