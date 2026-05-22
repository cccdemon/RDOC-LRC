'use strict';

const { logErr } = require('../log');

let redis = null;

function init(r) { redis = r; }

function clientKey(req) {
  if (req.session && req.session.userId) return `user:${req.session.userId}`;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return `ip:${xff.split(',')[0].trim()}`;
  return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function limit({ bucket, max, windowSec }) {
  return async (req, res, next) => {
    if (!redis) return next();
    const key = `rdoc:webui:rl:${bucket}:${clientKey(req)}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec);
      if (count > max) {
        const ttl = await redis.ttl(key);
        res.setHeader('Retry-After', String(Math.max(1, ttl)));
        return res.status(429).render('error', {
          title: 'Too many requests',
          message: `Rate limit exceeded for "${bucket}" (${max} per ${windowSec}s). Try again in ${Math.max(1, ttl)}s.`,
          session: req.session || null,
        });
      }
      next();
    } catch (e) {
      logErr('WebUI', `ratelimit redis error (${bucket}): ${e.message}`);
      next();
    }
  };
}

module.exports = { init, limit };
