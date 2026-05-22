'use strict';

const crypto = require('crypto');

const COOKIE = 'rdoc_sid';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const kSession = (id) => `rdoc:webui:session:${id}`;

function genId() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookies(req) {
  const out = {};
  const hdr = req.headers.cookie;
  if (!hdr) return out;
  for (const part of hdr.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isSecure(req) {
  if (req.secure) return true;
  const xfp = req.headers['x-forwarded-proto'];
  return typeof xfp === 'string' && xfp.split(',')[0].trim() === 'https';
}

function buildCookie(name, value, { maxAgeSec, secure }) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function sessionMiddleware(redis) {
  return async (req, res, next) => {
    try {
      const cookies = parseCookies(req);
      const sid = cookies[COOKIE];
      req.session = null;
      req.sessionId = null;

      if (sid) {
        const data = await redis.hgetall(kSession(sid));
        if (data && data.userId) {
          req.session = data;
          req.sessionId = sid;
        }
      }
      res.locals.session = req.session;

      res.login = async (data) => {
        const id = genId();
        await redis.multi()
          .hset(kSession(id), data)
          .pexpire(kSession(id), SESSION_TTL_MS)
          .exec();
        res.setHeader('Set-Cookie', buildCookie(COOKIE, id, {
          maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
          secure: isSecure(req),
        }));
        req.session = data;
        req.sessionId = id;
      };

      res.logout = async () => {
        if (req.sessionId) await redis.del(kSession(req.sessionId));
        res.setHeader('Set-Cookie', buildCookie(COOKIE, '', { maxAgeSec: 0, secure: isSecure(req) }));
        req.session = null;
        req.sessionId = null;
        res.locals.session = null;
      };

      next();
    } catch (e) {
      next(e);
    }
  };
}

async function destroyAllForUser(redis, userId) {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'rdoc:webui:session:*', 'COUNT', 200);
    cursor = next;
    for (const key of keys) {
      const data = await redis.hgetall(key);
      if (data && data.userId === String(userId)) {
        await redis.del(key);
        removed++;
      }
    }
  } while (cursor !== '0');
  return removed;
}

module.exports = { sessionMiddleware, destroyAllForUser, COOKIE };
