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
      addToCache({ room, guildId, channelId, webhookUrl: data.webhookUrl, webhookId: data.webhookId });
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

async function join(room, guildId, channelId, webhookUrl, webhookId) {
  const entry = { room, guildId, channelId, webhookUrl, webhookId };
  const tx = redis.multi();
  tx.sadd(K_ROOMS, room);
  tx.sadd(kRoomMembers(room), `${guildId}:${channelId}`);
  tx.hset(kChannel(channelId), { room, guildId, webhookUrl, webhookId });
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

async function setGuildAuditChannel(guildId, channelId) {
  if (channelId) await redis.set(kGuildAuditChannel(guildId), String(channelId));
  else           await redis.del(kGuildAuditChannel(guildId));
}

async function getGuildAuditChannel(guildId) {
  return await redis.get(kGuildAuditChannel(guildId));
}

module.exports = {
  initRooms, join, leave,
  getChannel, getRoomMembers, getGuildChannels, getWebhookClient,
  summary,
  pruneStale,
  setGuildAuditChannel, getGuildAuditChannel,
};
