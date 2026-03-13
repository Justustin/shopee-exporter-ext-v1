const express = require('express');
const db = require('../../db');
const { requireAuthApi } = require('../../middleware/auth');
const { requireActiveSubscription } = require('../../middleware/subscription');
const { generateCSV, generateExcelXml } = require('../../services/export');
const router = express.Router();

router.use(requireAuthApi);

function parseDateRange(dateFromRaw, dateToRaw) {
  const from = new Date(String(dateFromRaw || '').trim());
  const to = new Date(`${String(dateToRaw || '').trim()}T23:59:59`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return null;
  }
  if (from > to) {
    return null;
  }
  return { from, to };
}

router.get('/csv', requireActiveSubscription, async (req, res) => {
  const { store_id, date_from, date_to } = req.query;
  if (!store_id || !date_from || !date_to) {
    return res.status(400).json({ error: 'store_id, date_from, date_to required' });
  }
  const range = parseDateRange(date_from, date_to);
  if (!range) {
    return res.status(400).json({ error: 'Invalid date range' });
  }

  // Verify ownership
  const store = await db('stores').where({ id: store_id, user_id: req.session.userId }).first();
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const csv = await generateCSV(store.id, range.from, range.to);
  const filename = `shopee-export-${store.shop_id}-${date_from}-to-${date_to}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

router.get('/excel', requireActiveSubscription, async (req, res) => {
  const { store_id, date_from, date_to } = req.query;
  if (!store_id || !date_from || !date_to) {
    return res.status(400).json({ error: 'store_id, date_from, date_to required' });
  }
  const range = parseDateRange(date_from, date_to);
  if (!range) {
    return res.status(400).json({ error: 'Invalid date range' });
  }

  const store = await db('stores').where({ id: store_id, user_id: req.session.userId }).first();
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const xml = await generateExcelXml(store.id, range.from, range.to);
  const filename = `shopee-export-${store.shop_id}-${date_from}-to-${date_to}.xls`;

  res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(xml);
});

module.exports = router;
