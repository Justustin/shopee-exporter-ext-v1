const express = require('express');
const db = require('../../db');
const { requireAuthApi } = require('../../middleware/auth');
const { requireStoreOwner } = require('../../middleware/store-owner');
const { requireActiveSubscription } = require('../../middleware/subscription');
const { syncStore } = require('../../services/sync');
const logger = require('../../utils/logger');
const router = express.Router();

router.use(requireAuthApi);

// Disconnect a store
router.delete('/:id', requireActiveSubscription, requireStoreOwner(), async (req, res) => {
  await db('stores').where({ id: req.store.id }).update({ is_active: false });
  res.json({ ok: true });
});

// Trigger manual sync
router.post('/:id/sync', requireActiveSubscription, requireStoreOwner(), async (req, res) => {
  const store = req.store;
  logger.info(`Manual sync triggered for store ${store.id}`);

  const result = await syncStore(store);

  // If called from a form (dashboard), redirect back
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    const status = result.ok ? 'sync_ok' : 'sync_failed';
    return res.redirect(`/dashboard/store/${store.id}?status=${status}`);
  }
  res.json(result);
});

module.exports = router;
