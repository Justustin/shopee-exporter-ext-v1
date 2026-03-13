const express = require('express');
const db = require('../../db');
const { requireAuthApi } = require('../../middleware/auth');
const { requireActiveSubscription } = require('../../middleware/subscription');
const router = express.Router();

router.use(requireAuthApi);
router.use(requireActiveSubscription);

// Monthly fee summary for a store
router.get('/fee-summary', async (req, res) => {
  const { store_id, month } = req.query; // month: YYYY-MM
  const userId = req.session.userId;

  const store = await db('stores').where({ id: store_id, user_id: userId }).first();
  if (!store) return res.status(404).json({ error: 'Store not found' });

  // Default to current month
  const m = month || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) {
    return res.status(400).json({ error: 'Invalid month format, expected YYYY-MM' });
  }
  const dateFrom = new Date(m + '-01');
  if (!Number.isFinite(dateFrom.getTime())) {
    return res.status(400).json({ error: 'Invalid month value' });
  }
  const dateTo = new Date(dateFrom.getFullYear(), dateFrom.getMonth() + 1, 0, 23, 59, 59);

  const summary = await db('orders')
    .where({ store_id: store.id })
    .whereBetween('create_time', [dateFrom, dateTo])
    .select(
      db.raw('COUNT(*) as order_count'),
      db.raw('COALESCE(SUM(order_total), 0) as order_total'),
      db.raw('COALESCE(SUM(admin_fee), 0) as admin_fee'),
      db.raw('COALESCE(SUM(service_fee), 0) as service_fee'),
      db.raw('COALESCE(SUM(transaction_fee), 0) as transaction_fee'),
      db.raw('COALESCE(SUM(shipping_fee), 0) as shipping_fee'),
      db.raw('COALESCE(SUM(shipping_fee_rebate), 0) as shipping_fee_rebate'),
      db.raw('COALESCE(SUM(buyer_shipping_fee), 0) as buyer_shipping_fee'),
      db.raw('COALESCE(SUM(shopee_shipping_rebate), 0) as shopee_shipping_rebate'),
      db.raw('COALESCE(SUM(voucher_from_shopee), 0) as voucher_from_shopee'),
      db.raw('COALESCE(SUM(voucher_from_seller), 0) as voucher_from_seller'),
      db.raw('COALESCE(SUM(coins), 0) as coins'),
      db.raw('COALESCE(SUM(order_income), 0) as order_income'),
      db.raw('COALESCE(SUM(net_income), 0) as net_income')
    )
    .first();

  const toInt = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const orderTotal = toInt(summary.order_total);
  const totalFees = Math.abs(toInt(summary.admin_fee)) +
    Math.abs(toInt(summary.service_fee)) +
    Math.abs(toInt(summary.transaction_fee));

  res.json({
    store_id: store.id,
    shop_id: store.shop_id,
    month: m,
    order_count: toInt(summary.order_count),
    order_total: orderTotal,
    total_fees: totalFees,
    fee_percentage: orderTotal > 0 ? ((totalFees / orderTotal) * 100).toFixed(2) : '0.00',
    admin_fee: toInt(summary.admin_fee),
    service_fee: toInt(summary.service_fee),
    transaction_fee: toInt(summary.transaction_fee),
    shipping_fee: toInt(summary.shipping_fee),
    shipping_fee_rebate: toInt(summary.shipping_fee_rebate),
    buyer_shipping_fee: toInt(summary.buyer_shipping_fee),
    shopee_shipping_rebate: toInt(summary.shopee_shipping_rebate),
    voucher_from_shopee: toInt(summary.voucher_from_shopee),
    voucher_from_seller: toInt(summary.voucher_from_seller),
    coins: toInt(summary.coins),
    order_income: toInt(summary.order_income),
    net_income: toInt(summary.net_income),
  });
});

module.exports = router;
