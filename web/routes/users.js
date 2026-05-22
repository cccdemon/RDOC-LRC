'use strict';

const express = require('express');
const users = require('../users');
const session = require('../session');
const audit = require('../audit');
const { requireAuth, requireRole, requireCsrf } = require('../middleware');
const { log } = require('../../log');

const USER_ID_RE = /^\d{17,20}$/;
const ROLES = ['admin', 'moderator'];

function createRouter(redis) {
  const router = express.Router();
  router.use(requireAuth);
  router.use(requireRole('admin'));

  router.get('/', async (req, res, next) => {
    try {
      const list = await users.listUsers();
      const flash = await req.consumeFlash();
      res.render('users', {
        title: 'Users',
        session: req.session,
        users: list,
        flash,
      });
    } catch (e) { next(e); }
  });

  router.post('/add', requireCsrf, async (req, res, next) => {
    try {
      const userId = String(req.body.userId || '').trim();
      const role = String(req.body.role || '').trim();

      if (!USER_ID_RE.test(userId)) {
        await res.flash({ error: 'User ID must be a 17-20 digit Discord ID.' });
        return res.redirect('/users');
      }
      if (!ROLES.includes(role)) {
        await res.flash({ error: 'Role must be admin or moderator.' });
        return res.redirect('/users');
      }

      const existing = await users.getUser(userId);
      if (existing) {
        await res.flash({ error: `User ${userId} already exists with role "${existing.role}". Use the role selector on their row to change it.` });
        return res.redirect('/users');
      }

      await users.setUserRole(userId, role, req.session.userId);
      log('WebUI', `user add ${userId} role=${role} by=${req.session.userId}`);
      audit.append({
        userId: req.session.userId, username: req.session.username,
        action: 'user.add',
        details: { targetUserId: userId, role },
      });
      await res.flash({ ok: `User ${userId} added with role "${role}". They will be able to sign in on next visit.` });
      res.redirect('/users');
    } catch (e) { next(e); }
  });

  router.post('/set-role', requireCsrf, async (req, res, next) => {
    try {
      const userId = String(req.body.userId || '').trim();
      const role = String(req.body.role || '').trim();

      if (!USER_ID_RE.test(userId)) {
        await res.flash({ error: 'Invalid user ID.' });
        return res.redirect('/users');
      }
      if (!ROLES.includes(role)) {
        await res.flash({ error: 'Role must be admin or moderator.' });
        return res.redirect('/users');
      }

      const existing = await users.getUser(userId);
      if (!existing) {
        await res.flash({ error: `User ${userId} not found.` });
        return res.redirect('/users');
      }

      if (existing.role === role) {
        await res.flash({ ok: `Role for ${userId} unchanged (already "${role}").` });
        return res.redirect('/users');
      }

      if (userId === req.session.userId && existing.role === 'admin' && role !== 'admin') {
        await res.flash({ error: 'You cannot demote yourself. Ask another admin, or recover via the RDOC_BOOTSTRAP_ADMIN_ID env var.' });
        return res.redirect('/users');
      }

      if (existing.role === 'admin' && role !== 'admin') {
        const all = await users.listUsers();
        const admins = all.filter(u => u.role === 'admin');
        if (admins.length <= 1) {
          await res.flash({ error: 'Cannot demote the last admin. Promote another user to admin first.' });
          return res.redirect('/users');
        }
      }

      await users.setUserRole(userId, role, req.session.userId);
      log('WebUI', `user set-role ${userId} ${existing.role}->${role} by=${req.session.userId}`);
      audit.append({
        userId: req.session.userId, username: req.session.username,
        action: 'user.set-role',
        details: { targetUserId: userId, oldRole: existing.role, newRole: role },
      });
      await res.flash({ ok: `Role for ${userId} changed from "${existing.role}" to "${role}".` });
      res.redirect('/users');
    } catch (e) { next(e); }
  });

  router.post('/remove', requireCsrf, async (req, res, next) => {
    try {
      const userId = String(req.body.userId || '').trim();

      if (!USER_ID_RE.test(userId)) {
        await res.flash({ error: 'Invalid user ID.' });
        return res.redirect('/users');
      }

      if (userId === req.session.userId) {
        await res.flash({ error: 'You cannot remove yourself.' });
        return res.redirect('/users');
      }

      const existing = await users.getUser(userId);
      if (!existing) {
        await res.flash({ error: `User ${userId} not found.` });
        return res.redirect('/users');
      }

      if (existing.role === 'admin') {
        const all = await users.listUsers();
        const admins = all.filter(u => u.role === 'admin');
        if (admins.length <= 1) {
          await res.flash({ error: 'Cannot remove the last admin.' });
          return res.redirect('/users');
        }
      }

      await users.removeUser(userId);
      const sessionsRemoved = await session.destroyAllForUser(redis, userId);
      log('WebUI', `user remove ${userId} (${existing.role}) sessionsRemoved=${sessionsRemoved} by=${req.session.userId}`);
      audit.append({
        userId: req.session.userId, username: req.session.username,
        action: 'user.remove',
        details: { targetUserId: userId, formerRole: existing.role, sessionsRemoved },
      });
      await res.flash({ ok: `User ${userId} removed. ${sessionsRemoved} active session(s) terminated.` });
      res.redirect('/users');
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = createRouter;
