const express = require('express');
const db = require('../../db');
const { requireAuthApi } = require('../../middleware/auth');
const router = express.Router();

router.use(requireAuthApi);

router.get('/', async (req, res) => {
  const { store_id, date_from, date_to, page = 1 } = req.query;
  const userId = req.session.userId;
  const limit = 100;
  const pageNum = parseInt(page, 10);
  const offset = (pageNum - 1) * limit;
  if (!Number.isFinite(pageNum) || pageNum < 1) {
    return res.status(400).json({ error: 'Invalid page' });
  }

  // Verify ownership
  const store = await db('stores').where({ id: store_id, user_id: userId }).first();
  if (!store) return res.status(404).json({ error: 'Store not found' });

  let query = db('orders').where({ store_id: store.id });

  if (date_from) {
    const from = new Date(String(date_from));
    if (!Number.isFinite(from.getTime())) {
      return res.status(400).json({ error: 'Invalid date_from' });
    }
    query = query.where('create_time', '>=', from);
  }
  if (date_to) {
    const to = new Date(`${String(date_to)}T23:59:59`);
    if (!Number.isFinite(to.getTime())) {
      return res.status(400).json({ error: 'Invalid date_to' });
    }
    query = query.where('create_time', '<=', to);
  }

  const orders = await query.orderBy('create_time', 'desc').limit(limit).offset(offset);

  res.json({ orders, page: pageNum, limit });
});

module.exports = router;
