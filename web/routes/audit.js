'use strict';

const express = require('express');
const audit = require('../audit');
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('admin'));

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(0, parseInt(String(req.query.page || '0'), 10));
    const limit = 50;
    const [entries, total] = await Promise.all([
      audit.list({ limit, offset: page * limit }),
      audit.count(),
    ]);
    res.render('audit', {
      title: 'Audit log',
      session: req.session,
      entries,
      page,
      limit,
      total,
    });
  } catch (e) { next(e); }
});

router.get('/fragment', async (req, res, next) => {
  try {
    const entries = await audit.list({ limit: 50, offset: 0 });
    res.render('audit-rows', { entries });
  } catch (e) { next(e); }
});

module.exports = router;
