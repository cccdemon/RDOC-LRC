'use strict';

const K_USERS = 'rdoc:webui:users';
const kUser = (id) => `rdoc:webui:user:${id}`;

const ROLES = ['admin', 'moderator'];

let redis = null;

function init(redisClient) { redis = redisClient; }

async function getUser(userId) {
  const data = await redis.hgetall(kUser(userId));
  if (!data || !data.role) return null;
  return { userId: String(userId), ...data };
}

async function setUserRole(userId, role, addedBy) {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  const id = String(userId);
  const existed = (await redis.hexists(kUser(id), 'role')) === 1;
  const tx = redis.multi();
  tx.sadd(K_USERS, id);
  const fields = { role, addedBy: String(addedBy || ''), updatedAt: String(Date.now()) };
  if (!existed) fields.addedAt = String(Date.now());
  tx.hset(kUser(id), fields);
  await tx.exec();
}

async function setUsername(userId, username) {
  await redis.hset(kUser(String(userId)), { username: String(username || '') });
}

async function removeUser(userId) {
  const id = String(userId);
  await redis.multi()
    .srem(K_USERS, id)
    .del(kUser(id))
    .exec();
}

async function listUsers() {
  const ids = await redis.smembers(K_USERS);
  const out = [];
  for (const id of ids) {
    const data = await redis.hgetall(kUser(id));
    if (data && data.role) out.push({ userId: id, ...data });
  }
  return out.sort((a, b) => Number(a.addedAt || 0) - Number(b.addedAt || 0));
}

async function bootstrapAdmin(userId) {
  if (!userId) return false;
  const id = String(userId);
  const existing = await getUser(id);
  if (existing && existing.role === 'admin') return false;
  await setUserRole(id, 'admin', 'bootstrap');
  return true;
}

module.exports = {
  init, getUser, setUserRole, setUsername, removeUser, listUsers, bootstrapAdmin,
  ROLES,
};
