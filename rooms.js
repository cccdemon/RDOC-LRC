'use strict';

const { WebhookClient } = require('discord.js');
const { log, logErr } = require('./log');

let redis = null;
const channelMap = new Map();
const roomMembers = new Map();
const webhookClients = new Map();

const K_ROOMS = 'rdoc:rooms';
const kRoomMembers = (room) => `rdoc:room:${room}:members`;
const kChannel = (channelId) => `rdoc:channel:${channelId}`;
const kGuildAuditChannel = (guildId) => `rdoc:guild:${guildId}:audit_channel`;
const kRoomRules = (room) => `rdoc:room:${room}:rules`;
const kRoomBannedUsers = (room) => `rdoc:room:${room}:banned_users`;
const kRoomBadwords = (room) => `rdoc:room:${room}:badwords`;
const kRoomBadwordMode = (room) => `rdoc:room:${room}:badword_mode`;
const kRoomMentionMode = (room) => `rdoc:room:${room}:mention_mode`;

const ROOM_RULES_MAX = 1900;
const BADWORD_MODES = ['off', 'block', 'mask'];
const MENTION_MODES = ['off', 'names-only', 'resolve-users'];

async function initRooms(redisClient) {
  redis = redisClient;
  channelMap.clear();
  roomMembers.clear();
  for (const [, wc] of webhookClients) { try { wc.destroy(); } catch {} }
  webhookClients.clear();

  const roomNames = await redis.smembers(K_ROOMS);
  for (const room of roomNames) {
    const members = await redis.smembers(kRoomMembers(room));
    for (const memberKey of members) {
      const [guildId, channelId] = memberKey.split(':');
      if (!guildId || !channelId) continue;
      const data = await redis.hgetall(kChannel(channelId));
      if (!data || !data.webhookUrl) continue;
      addToCache({
        room,
        guildId,
        channelId,
        webhookUrl: data.webhookUrl,
        webhookId: data.webhookId,
        guildName: data.guildName || '',
        channelName: data.channelName || '',
      });
    }
  }
  log('Rooms', `Loaded: ${roomMembers.size} room(s), ${channelMap.size} channel(s)`);
}

function addToCache(entry) {
  channelMap.set(entry.channelId, entry);
  if (!roomMembers.has(entry.room)) roomMembers.set(entry.room, new Map());
  roomMembers.get(entry.room).set(entry.channelId, entry);
  webhookClients.set(entry.channelId, new WebhookClient({ url: entry.webhookUrl }));
}

function removeFromCache(channelId) {
  const entry = channelMap.get(channelId);
  if (!entry) return null;
  channelMap.delete(channelId);
  const room = roomMembers.get(entry.room);
  if (room) {
    room.delete(channelId);
    if (room.size === 0) roomMembers.delete(entry.room);
  }
  const wc = webhookClients.get(channelId);
  if (wc) { try { wc.destroy(); } catch {} webhookClients.delete(channelId); }
  return entry;
}

async function join(room, guildId, channelId, webhookUrl, webhookId, guildName = '', channelName = '') {
  const entry = { room, guildId, channelId, webhookUrl, webhookId, guildName, channelName };
  const tx = redis.multi();
  tx.sadd(K_ROOMS, room);
  tx.sadd(kRoomMembers(room), `${guildId}:${channelId}`);
  tx.hset(kChannel(channelId), { room, guildId, webhookUrl, webhookId, guildName, channelName });
  await tx.exec();
  addToCache(entry);
}

async function leave(channelId) {
  const entry = channelMap.get(channelId);
  if (!entry) return null;
  const tx = redis.multi();
  tx.srem(kRoomMembers(entry.room), `${entry.guildId}:${entry.channelId}`);
  tx.del(kChannel(channelId));
  await tx.exec();
  const remaining = await redis.scard(kRoomMembers(entry.room));
  if (remaining === 0) await redis.srem(K_ROOMS, entry.room);
  removeFromCache(channelId);
  return entry;
}

function getChannel(channelId) { return channelMap.get(channelId) || null; }

function getRoomMembers(room) {
  const m = roomMembers.get(room);
  return m ? [...m.values()] : [];
}

function getGuildChannels(guildId) {
  return [...channelMap.values()].filter(e => e.guildId === guildId);
}

function listAllFederatedGuilds() {
  const byGuild = new Map();
  for (const [room, members] of roomMembers) {
    for (const m of members.values()) {
      if (!byGuild.has(m.guildId)) {
        byGuild.set(m.guildId, { guildId: m.guildId, guildName: m.guildName || '', rooms: [] });
      }
      const e = byGuild.get(m.guildId);
      if (!e.rooms.includes(room)) e.rooms.push(room);
    }
  }
  return [...byGuild.values()];
}

function getWebhookClient(channelId) { return webhookClients.get(channelId) || null; }

function summary() {
  const out = {};
  for (const [room, members] of roomMembers) out[room] = members.size;
  return out;
}

async function pruneStale(client, { roomFilter } = {}) {
  if (!client) throw new Error('pruneStale requires a logged-in Discord client');
  const all = [...channelMap.values()];
  const entries = roomFilter ? all.filter(e => e.room === roomFilter) : all;
  const details = [];
  let skipped = 0;

  for (const e of entries) {
    let deadReason = null;
    try {
      const ch = await client.channels.fetch(e.channelId);
      if (!ch) deadReason = 'fetch returned null';
    } catch (err) {
      const code = err?.code;
      if (code === 10003)      deadReason = 'Unknown Channel (10003)';
      else if (code === 10004) deadReason = 'Unknown Guild (10004)';
      else {
        skipped++;
        logErr('Rooms', `prune skipped channel=${e.channelId}: ${err?.message || err}`);
      }
    }
    if (deadReason) {
      try {
        await leave(e.channelId);
        details.push({ room: e.room, guildId: e.guildId, channelId: e.channelId, reason: deadReason });
      } catch (err) {
        logErr('Rooms', `prune leave failed channel=${e.channelId}: ${err?.message || err}`);
      }
    }
  }

  return { checked: entries.length, evicted: details.length, skipped, details };
}

async function getRoomRules(room) {
  return await redis.get(kRoomRules(room));
}

async function setRoomRules(room, rules) {
  const text = String(rules == null ? '' : rules);
  if (text.length > ROOM_RULES_MAX) {
    throw new Error(`Rules text too long (${text.length} chars, max ${ROOM_RULES_MAX})`);
  }
  if (!text) {
    await redis.del(kRoomRules(room));
    return;
  }
  await redis.set(kRoomRules(room), text);
}

async function addBannedUser(room, userId) {
  const id = String(userId || '').trim();
  if (!/^\d{17,20}$/.test(id)) throw new Error('Invalid Discord user ID');
  await redis.sadd(kRoomBannedUsers(room), id);
}

async function removeBannedUser(room, userId) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('Missing Discord user ID');
  await redis.srem(kRoomBannedUsers(room), id);
}

async function getBannedUsers(room) {
  return (await redis.smembers(kRoomBannedUsers(room))).sort();
}

async function isUserBanned(room, userId) {
  return (await redis.sismember(kRoomBannedUsers(room), String(userId))) === 1;
}

async function setBadwordMode(room, mode) {
  if (!BADWORD_MODES.includes(mode)) throw new Error('Invalid bad-word mode');
  if (mode === 'off') await redis.del(kRoomBadwordMode(room));
  else await redis.set(kRoomBadwordMode(room), mode);
}

async function getBadwordMode(room) {
  const mode = await redis.get(kRoomBadwordMode(room));
  return BADWORD_MODES.includes(mode) ? mode : 'off';
}

function normalizeModerationText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBadword(word) {
  return normalizeModerationText(word);
}

async function addBadword(room, word) {
  const normalized = normalizeBadword(word);
  if (!normalized) throw new Error('Bad word cannot be empty');
  if (normalized.length > 120) throw new Error('Bad word too long');
  await redis.sadd(kRoomBadwords(room), normalized);
}

async function removeBadword(room, word) {
  const normalized = normalizeBadword(word);
  if (!normalized) throw new Error('Bad word cannot be empty');
  await redis.srem(kRoomBadwords(room), normalized);
}

async function getBadwords(room) {
  return (await redis.smembers(kRoomBadwords(room))).sort();
}

async function clearBadwords(room) {
  await redis.del(kRoomBadwords(room));
}

async function getBadwordConfig(room) {
  const [mode, words] = await Promise.all([getBadwordMode(room), getBadwords(room)]);
  return { mode, words };
}

async function setMentionMode(room, mode) {
  if (!MENTION_MODES.includes(mode)) throw new Error('Invalid mention mode');
  if (mode === 'names-only') await redis.del(kRoomMentionMode(room));
  else await redis.set(kRoomMentionMode(room), mode);
}

async function getMentionMode(room) {
  const mode = await redis.get(kRoomMentionMode(room));
  return MENTION_MODES.includes(mode) ? mode : 'names-only';
}

async function setGuildAuditChannel(guildId, channelId) {
  if (channelId) await redis.set(kGuildAuditChannel(guildId), String(channelId));
  else           await redis.del(kGuildAuditChannel(guildId));
}

async function getGuildAuditChannel(guildId) {
  return await redis.get(kGuildAuditChannel(guildId));
}

// Weblink filtering functions
const kWeblinkMode = (scope, id) => `rdoc:weblink:mode:${scope}:${id}`;
const kWeblinkList = (scope, id) => `rdoc:weblink:list:${scope}:${id}`;

async function setWeblinkMode(scope, id, mode) {
  if (!['none', 'allowlist'].includes(mode)) {
    throw new Error('Invalid mode. Must be "none" or "allowlist"');
  }
  if (!['room', 'guild'].includes(scope)) {
    throw new Error('Invalid scope. Must be "room" or "guild"');
  }
  await redis.set(kWeblinkMode(scope, id), mode);
}

async function getWeblinkMode(scope, id) {
  const mode = await redis.get(kWeblinkMode(scope, id));
  return mode || 'none'; // Default to no filtering
}

async function addToWeblinkList(scope, id, domain) {
  if (!domain || typeof domain !== 'string') {
    throw new Error('Domain must be a non-empty string');
  }
  const normalized = domain.toLowerCase().trim();
  if (!normalized) {
    throw new Error('Domain cannot be empty after trimming');
  }
  await redis.sadd(kWeblinkList(scope, id), normalized);
}

async function removeFromWeblinkList(scope, id, domain) {
  if (!domain || typeof domain !== 'string') {
    throw new Error('Domain must be a non-empty string');
  }
  const normalized = domain.toLowerCase().trim();
  await redis.srem(kWeblinkList(scope, id), normalized);
}

async function getWeblinkList(scope, id) {
  return await redis.smembers(kWeblinkList(scope, id));
}

async function clearWeblinkList(scope, id) {
  await redis.del(kWeblinkList(scope, id));
}

async function getWeblinkConfig(scope, id) {
  const [mode, list] = await Promise.all([
    getWeblinkMode(scope, id),
    getWeblinkList(scope, id)
  ]);
  return { mode, list };
}

module.exports = {
  initRooms, join, leave,
  getChannel, getRoomMembers, getGuildChannels, getWebhookClient, listAllFederatedGuilds,
  summary,
  pruneStale,
  setGuildAuditChannel, getGuildAuditChannel,
  getRoomRules, setRoomRules, ROOM_RULES_MAX,
  addBannedUser, removeBannedUser, getBannedUsers, isUserBanned,
  setBadwordMode, getBadwordMode, addBadword, removeBadword, getBadwords, clearBadwords, getBadwordConfig,
  setMentionMode, getMentionMode, BADWORD_MODES, MENTION_MODES,
  setWeblinkMode, getWeblinkMode,
  addToWeblinkList, removeFromWeblinkList, getWeblinkList, clearWeblinkList,
  getWeblinkConfig,
};
