'use strict';

const crypto = require('crypto');
const { log } = require('./log');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TOKEN_GROUPS = 4;
const TOKEN_GROUP_LEN = 4;
const PREFIX = 'rdoc';
const TOKEN_RE = /^rdoc-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/;

const K_TOKENS = 'rdoc:tokens';
const kToken = (t) => `rdoc:token:${t}`;
const kRoomTokens = (room) => `rdoc:room:${room}:tokens`;

let redis = null;

function init(redisClient) { redis = redisClient; }

function generateToken() {
  const bytes = crypto.randomBytes(TOKEN_GROUPS * TOKEN_GROUP_LEN);
  const groups = [];
  for (let g = 0; g < TOKEN_GROUPS; g++) {
    let s = '';
    for (let c = 0; c < TOKEN_GROUP_LEN; c++) {
      s += ALPHABET[bytes[g * TOKEN_GROUP_LEN + c] % ALPHABET.length];
    }
    groups.push(s);
  }
  return `${PREFIX}-${groups.join('-')}`;
}

function isValidFormat(s) { return typeof s === 'string' && TOKEN_RE.test(s); }

async function create({ room, guildId, expiresInMs }) {
  const token = generateToken();
  const now = Date.now();
  const expiresAt = now + expiresInMs;

  const data = {
    kind: 'join',
    room,
    createdAt: String(now),
    expiresAt: String(expiresAt),
  };
  if (guildId) data.guildId = String(guildId);

  const tx = redis.multi();
  tx.hset(kToken(token), data);
  tx.sadd(K_TOKENS, token);
  tx.sadd(kRoomTokens(room), token);
  tx.pexpireat(kToken(token), expiresAt);
  await tx.exec();

  return { token, kind: 'join', room, guildId: data.guildId || null, createdAt: now, expiresAt };
}

async function createKick({ room, targetGuildId, expiresInMs }) {
  const token = generateToken();
  const now = Date.now();
  const expiresAt = now + expiresInMs;

  const data = {
    kind: 'kick',
    room,
    targetGuildId: String(targetGuildId),
    createdAt: String(now),
    expiresAt: String(expiresAt),
  };

  const tx = redis.multi();
  tx.hset(kToken(token), data);
  tx.sadd(K_TOKENS, token);
  tx.sadd(kRoomTokens(room), token);
  tx.pexpireat(kToken(token), expiresAt);
  await tx.exec();

  return { token, kind: 'kick', room, targetGuildId: data.targetGuildId, createdAt: now, expiresAt };
}

const CONSUME_JOIN_LUA = `
local tokenKey = KEYS[1]
local tokensSet = KEYS[2]
local token = ARGV[1]
local now = tonumber(ARGV[2])
local expectedRoom = ARGV[3]
local callerGuildId = ARGV[4]

if redis.call('EXISTS', tokenKey) == 0 then
  return redis.error_reply('NOT_FOUND')
end

local data = redis.call('HGETALL', tokenKey)
local map = {}
for i = 1, #data, 2 do map[data[i]] = data[i+1] end

local kind = map['kind']
if kind and kind ~= 'join' then
  return redis.error_reply('WRONG_KIND')
end

local expiresAt = tonumber(map['expiresAt'])
if expiresAt and expiresAt < now then
  redis.call('DEL', tokenKey)
  redis.call('SREM', tokensSet, token)
  if map['room'] then
    redis.call('SREM', 'rdoc:room:' .. map['room'] .. ':tokens', token)
  end
  return redis.error_reply('EXPIRED')
end

if map['room'] ~= expectedRoom then
  return redis.error_reply('ROOM_MISMATCH')
end

if map['guildId'] and map['guildId'] ~= '' and map['guildId'] ~= callerGuildId then
  return redis.error_reply('GUILD_MISMATCH')
end

redis.call('DEL', tokenKey)
redis.call('SREM', tokensSet, token)
redis.call('SREM', 'rdoc:room:' .. map['room'] .. ':tokens', token)

return data
`;

const CONSUME_KICK_LUA = `
local tokenKey = KEYS[1]
local tokensSet = KEYS[2]
local token = ARGV[1]
local now = tonumber(ARGV[2])
local expectedTarget = ARGV[3]

if redis.call('EXISTS', tokenKey) == 0 then
  return redis.error_reply('NOT_FOUND')
end

local data = redis.call('HGETALL', tokenKey)
local map = {}
for i = 1, #data, 2 do map[data[i]] = data[i+1] end

if map['kind'] ~= 'kick' then
  return redis.error_reply('WRONG_KIND')
end

local expiresAt = tonumber(map['expiresAt'])
if expiresAt and expiresAt < now then
  redis.call('DEL', tokenKey)
  redis.call('SREM', tokensSet, token)
  if map['room'] then
    redis.call('SREM', 'rdoc:room:' .. map['room'] .. ':tokens', token)
  end
  return redis.error_reply('EXPIRED')
end

if expectedTarget ~= '' and map['targetGuildId'] ~= expectedTarget then
  return redis.error_reply('TARGET_MISMATCH')
end

redis.call('DEL', tokenKey)
redis.call('SREM', tokensSet, token)
redis.call('SREM', 'rdoc:room:' .. map['room'] .. ':tokens', token)

return data
`;

class TokenError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

async function consume({ token, room, guildId }) {
  let result;
  try {
    result = await redis.eval(
      CONSUME_JOIN_LUA, 2,
      kToken(token), K_TOKENS,
      token, String(Date.now()), room, String(guildId)
    );
  } catch (e) {
    const code = (e?.message || '').trim();
    if (['NOT_FOUND', 'EXPIRED', 'ROOM_MISMATCH', 'GUILD_MISMATCH', 'WRONG_KIND'].includes(code)) {
      throw new TokenError(code);
    }
    throw e;
  }
  const map = {};
  for (let i = 0; i < result.length; i += 2) map[result[i]] = result[i + 1];
  return map;
}

async function consumeKick({ token, expectedTargetGuildId }) {
  let result;
  try {
    result = await redis.eval(
      CONSUME_KICK_LUA, 2,
      kToken(token), K_TOKENS,
      token, String(Date.now()), String(expectedTargetGuildId || '')
    );
  } catch (e) {
    const code = (e?.message || '').trim();
    if (['NOT_FOUND', 'EXPIRED', 'WRONG_KIND', 'TARGET_MISMATCH'].includes(code)) {
      throw new TokenError(code);
    }
    throw e;
  }
  const map = {};
  for (let i = 0; i < result.length; i += 2) map[result[i]] = result[i + 1];
  return map;
}

async function list({ room } = {}) {
  const tokens = room
    ? await redis.smembers(kRoomTokens(room))
    : await redis.smembers(K_TOKENS);
  const out = [];
  for (const token of tokens) {
    const data = await redis.hgetall(kToken(token));
    if (!data || !data.room) continue;
    out.push({
      token,
      kind: data.kind || 'join',
      room: data.room,
      guildId: data.guildId || null,
      targetGuildId: data.targetGuildId || null,
      createdAt: Number(data.createdAt),
      expiresAt: Number(data.expiresAt),
    });
  }
  out.sort((a, b) => a.expiresAt - b.expiresAt);
  return out;
}

async function revoke(prefix) {
  if (!prefix || prefix.length < 8) throw new TokenError('PREFIX_TOO_SHORT', 'prefix must be at least 8 characters');
  const tokens = await redis.smembers(K_TOKENS);
  const matches = tokens.filter(t => t.startsWith(prefix));
  if (matches.length === 0) throw new TokenError('NO_MATCH', 'no matching token');
  if (matches.length > 1) throw new TokenError('AMBIGUOUS', `prefix matches ${matches.length} tokens; be more specific`);

  const token = matches[0];
  const data = await redis.hgetall(kToken(token));
  const tx = redis.multi();
  tx.del(kToken(token));
  tx.srem(K_TOKENS, token);
  if (data?.room) tx.srem(kRoomTokens(data.room), token);
  await tx.exec();
  return { token, room: data?.room };
}

async function sweepExpired() {
  const now = Date.now();
  const tokens = await redis.smembers(K_TOKENS);
  let removed = 0;
  for (const token of tokens) {
    const data = await redis.hgetall(kToken(token));
    if (!data || !data.expiresAt) {
      await redis.srem(K_TOKENS, token);
      removed++;
      continue;
    }
    if (Number(data.expiresAt) < now) {
      const tx = redis.multi();
      tx.del(kToken(token));
      tx.srem(K_TOKENS, token);
      if (data.room) tx.srem(kRoomTokens(data.room), token);
      await tx.exec();
      removed++;
    }
  }
  if (removed > 0) log('Tokens', `Swept ${removed} expired token(s)`);
}

module.exports = {
  init, generateToken, isValidFormat,
  create, createKick,
  consume, consumeKick,
  list, revoke, sweepExpired,
  TokenError, TOKEN_RE,
};
