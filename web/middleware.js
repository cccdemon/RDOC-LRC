'use strict';

const crypto = require('crypto');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireAuth(req, res, next) {
  if (!req.session) return res.redirect(`/login?to=${encodeURIComponent(req.originalUrl)}`);
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session) return res.redirect(`/login?to=${encodeURIComponent(req.originalUrl)}`);
    if (role === 'admin' && req.session.role !== 'admin') {
      return res.status(403).render('error', {
        title: 'Forbidden',
        message: 'Admin role required for this action.',
        session: req.session,
      });
    }
    next();
  };
}

function requireCsrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const provided = req.body && req.body._csrf;
  const expected = req.session && req.session.csrf;
  if (!expected || !provided || !safeEqual(provided, expected)) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: 'CSRF token mismatch. Reload the page and try the action again.',
      session: req.session || null,
    });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireCsrf };
