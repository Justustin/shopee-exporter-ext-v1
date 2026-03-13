const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireStoreOwner } = require('../middleware/store-owner');
const router = express.Router();

router.use(requireAuth);

// Dashboard home: list stores with monthly stats
router.get('/', async (req, res) => {
  const userId = req.session.userId;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const toInt = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const stores = await db('stores').where({ user_id: userId, is_active: true });

  // Enrich with monthly stats
  for (const store of stores) {
    const stats = await db('orders')
      .where({ store_id: store.id })
      .where('create_time', '>=', monthStart)
      .select(
        db.raw('COUNT(*) as order_count'),
        db.raw('COALESCE(SUM(net_income), 0) as net_income_total')
      )
      .first();
    store.order_count = toInt(stats.order_count);
    store.net_income_total = toInt(stats.net_income_total);
  }

  const errorMap = {
    oauth_failed: 'Failed to start Shopee OAuth. Please try again.',
    oauth_callback_failed: 'Shopee OAuth callback failed. Please reconnect your store.',
    missing_params: 'Shopee OAuth callback missing parameters.',
    invalid_store_id: 'Invalid store selected.',
    store_not_found: 'Store not found.',
    subscription_required: 'Active subscription required. Renew or upgrade your plan to continue.',
    shopee_disabled: 'Shopee Open Platform is disabled on this server.',
  };
  const errorCode = req.query.error || null;

  res.render('dashboard', {
    stores,
    error: errorCode ? (errorMap[errorCode] || errorCode) : null,
    success: req.query.connected ? 'Store connected successfully!' : null,
  });
});

// Store detail with orders and fee breakdown
router.get('/store/:id', requireStoreOwner(), async (req, res) => {
  const store = req.store;
  const now = new Date();

  // Date range (default: current month)
  const dateFrom = req.query.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const dateTo = req.query.to || now.toISOString().slice(0, 10);

  const dateFromTs = new Date(dateFrom);
  const dateToTs = new Date(dateTo + 'T23:59:59');
  if (!Number.isFinite(dateFromTs.getTime()) || !Number.isFinite(dateToTs.getTime()) || dateFromTs > dateToTs) {
    return res.redirect(`/dashboard/store/${store.id}?from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}&error=invalid_date_range`);
  }

  // Fetch orders
  const orders = await db('orders')
    .where({ store_id: store.id })
    .whereBetween('create_time', [dateFromTs, dateToTs])
    .orderBy('create_time', 'desc');

  // Summary
  const summary = await db('orders')
    .where({ store_id: store.id })
    .whereBetween('create_time', [dateFromTs, dateToTs])
    .select(
      db.raw('COUNT(*) as "orderCount"'),
      db.raw('COALESCE(SUM(order_total), 0) as "orderTotal"'),
      db.raw('COALESCE(SUM(admin_fee), 0) as "adminFee"'),
      db.raw('COALESCE(SUM(service_fee), 0) as "serviceFee"'),
      db.raw('COALESCE(SUM(transaction_fee), 0) as "transactionFee"'),
      db.raw('COALESCE(SUM(shipping_fee), 0) as "shippingFee"'),
      db.raw('COALESCE(SUM(voucher_from_shopee), 0) as "voucherShopee"'),
      db.raw('COALESCE(SUM(voucher_from_seller), 0) as "voucherSeller"'),
      db.raw('COALESCE(SUM(coins), 0) as "coins"'),
      db.raw('COALESCE(SUM(net_income), 0) as "netIncome"')
    )
    .first();

  const toInt = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  };
  summary.orderCount = toInt(summary.orderCount);
  summary.totalFees = Math.abs(toInt(summary.adminFee)) +
    Math.abs(toInt(summary.serviceFee)) +
    Math.abs(toInt(summary.transactionFee));

  let banner = null;
  if (req.query.status === 'sync_ok') {
    banner = { type: 'success', message: 'Sync completed successfully.' };
  } else if (req.query.status === 'sync_failed') {
    banner = { type: 'error', message: 'Sync failed. Check logs and retry.' };
  } else if (req.query.error === 'invalid_date_range') {
    banner = { type: 'error', message: 'Invalid date range. Please adjust From/To values.' };
  }

  res.render('store-detail', { store, orders, summary, dateFrom, dateTo, banner });
});

module.exports = router;
