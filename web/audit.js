'use strict';

const K_AUDIT = 'rdoc:webui:audit';
const MAX_ENTRIES = 5000;

let redis = null;

function init(r) { redis = r; }

async function append({ userId, username, action, details }) {
  if (!redis) return;
  const entry = {
    ts: Date.now(),
    userId: String(userId || ''),
    username: String(username || ''),
    action: String(action || ''),
    details: details || {},
  };
  try {
    await redis.multi()
      .lpush(K_AUDIT, JSON.stringify(entry))
      .ltrim(K_AUDIT, 0, MAX_ENTRIES - 1)
      .exec();
  } catch {}
}

async function list({ limit = 100, offset = 0 } = {}) {
  if (!redis) return [];
  const raw = await redis.lrange(K_AUDIT, offset, offset + limit - 1);
  return raw.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

async function count() {
  if (!redis) return 0;
  return await redis.llen(K_AUDIT);
}

module.exports = { init, append, list, count, MAX_ENTRIES };
