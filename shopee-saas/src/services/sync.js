const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const shopeeApi = require('./shopee-api');
const config = require('../config');
const logger = require('../utils/logger');

const { lockTimeoutMinutes, lookbackDays, escrowBatchLimit } = config.sync;

function toRupiahInt(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = typeof value === 'number'
    ? value
    : Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(num)) return 0;
  return Math.round(num);
}

function toTimestampSeconds(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const asNum = Number(value);
  if (Number.isFinite(asNum)) {
    return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

// --- Lock management ---

async function acquireLock(storeId) {
  const lockId = uuidv4();
  const staleThreshold = new Date(Date.now() - lockTimeoutMinutes * 60 * 1000);

  // Acquire lock only if not locked, or lock is stale
  const updated = await db('stores')
    .where({ id: storeId })
    .where(function () {
      this.whereNull('sync_lock_id')
        .orWhere('sync_lock_at', '<', staleThreshold);
    })
    .update({ sync_lock_id: lockId, sync_lock_at: new Date() });

  return updated > 0 ? lockId : null;
}

async function releaseLock(storeId, lockId) {
  await db('stores')
    .where({ id: storeId, sync_lock_id: lockId })
    .update({ sync_lock_id: null, sync_lock_at: null });
}

// --- Main sync orchestrator ---

async function syncStore(store) {
  const lockId = await acquireLock(store.id);
  if (!lockId) {
    logger.warn(`Store ${store.id} sync skipped - already locked`);
    return { ok: false, error: 'Sync already in progress' };
  }

  const runId = uuidv4();
  let totalSynced = 0;

  try {
    // Log start
    await db('sync_logs').insert({
      store_id: store.id,
      sync_run_id: runId,
      job_type: 'order_list',
      status: 'started',
    });

    // Phase 1: Fetch order list + details
    totalSynced = await phaseOrderSync(store);

    await db('sync_logs')
      .where({ store_id: store.id, sync_run_id: runId, job_type: 'order_list' })
      .update({ status: 'completed', orders_synced: totalSynced, finished_at: new Date() });

    // Phase 2: Escrow enrichment backlog
    await db('sync_logs').insert({
      store_id: store.id,
      sync_run_id: runId,
      job_type: 'escrow_detail',
      status: 'started',
    });

    const escrowCount = await phaseEscrowEnrich(store);

    await db('sync_logs')
      .where({ store_id: store.id, sync_run_id: runId, job_type: 'escrow_detail' })
      .update({ status: 'completed', orders_synced: escrowCount, finished_at: new Date() });

    // Update last sync
    await db('stores').where({ id: store.id }).update({ last_sync_at: new Date() });

    logger.info(`Store ${store.id} sync complete: ${totalSynced} orders, ${escrowCount} escrows`);
    return { ok: true, ordersSynced: totalSynced, escrowsSynced: escrowCount };
  } catch (err) {
    logger.error(`Store ${store.id} sync failed`, err);

    await db('sync_logs')
      .where({ store_id: store.id, sync_run_id: runId })
      .whereIn('status', ['started'])
      .update({ status: 'failed', error_message: err.message, finished_at: new Date() });

    return { ok: false, error: err.message };
  } finally {
    await releaseLock(store.id, lockId);
  }
}

// --- Phase 1: Order list + detail ---

async function phaseOrderSync(store) {
  const now = Math.floor(Date.now() / 1000);
  const rawLastSynced = store.last_synced_update_time
    ? Number(store.last_synced_update_time)
    : now - lookbackDays * 24 * 60 * 60;
  // Rewind a few seconds for boundary safety; UPSERT keeps this idempotent.
  const timeFrom = Math.max(0, rawLastSynced - 5);
  const timeTo = now;

  let cursor = '';
  const seenOrderSns = new Set();
  const allOrderSns = [];
  let maxSeenUpdateTime = 0;
  let latestOrderSn = '';

  // Paginate order list
  do {
    const result = await shopeeApi.getOrderList(store, { timeFrom, timeTo, cursor });
    for (const entry of result.orderEntries || []) {
      if (!entry || !entry.orderSn) continue;
      if (!seenOrderSns.has(entry.orderSn)) {
        seenOrderSns.add(entry.orderSn);
        allOrderSns.push(entry.orderSn);
      }

      const updateTs = toTimestampSeconds(entry.updateTime);
      if (updateTs > maxSeenUpdateTime) {
        maxSeenUpdateTime = updateTs;
        latestOrderSn = entry.orderSn;
      } else if (updateTs === maxSeenUpdateTime && entry.orderSn > latestOrderSn) {
        latestOrderSn = entry.orderSn;
      }
    }
    cursor = result.more ? result.nextCursor : '';
  } while (cursor);

  if (allOrderSns.length === 0) return 0;

  // Fetch details in batches of 50
  let synced = 0;
  for (let i = 0; i < allOrderSns.length; i += 50) {
    const batch = allOrderSns.slice(i, i + 50);
    const details = await shopeeApi.getOrderDetail(store, batch);

    if (details && details.order_list) {
      for (const order of details.order_list) {
        await upsertOrder(store.id, order);
        synced++;
      }
    }
  }

  // Persist cursor to latest update_time observed from order_list.
  if (maxSeenUpdateTime > 0) {
    await db('stores').where({ id: store.id }).update({
      last_synced_update_time: maxSeenUpdateTime,
      last_synced_order_sn: latestOrderSn || null,
    });
  } else if (allOrderSns.length > 0) {
    // Fallback when update_time is absent in list payload.
    await db('stores').where({ id: store.id }).update({
      last_synced_update_time: timeTo,
      last_synced_order_sn: allOrderSns[allOrderSns.length - 1] || null,
    });
  }

  return synced;
}

// --- Phase 2: Escrow enrichment ---

async function phaseEscrowEnrich(store) {
  const pending = await db('orders')
    .where({ store_id: store.id, escrow_synced: false })
    .orderBy('create_time', 'desc')
    .limit(escrowBatchLimit)
    .select('id', 'order_sn');

  let count = 0;
  for (const order of pending) {
    try {
      const escrow = await shopeeApi.getEscrowDetail(store, order.order_sn);
      if (escrow) {
        await updateEscrow(order.id, escrow);
        count++;
      }
    } catch (err) {
      // Log but continue - don't fail entire batch for one bad order.
      logger.warn(`Escrow fetch failed for ${order.order_sn}: ${err.message}`);
    }
  }

  return count;
}

// --- DB operations ---

async function upsertOrder(storeId, order) {
  const items = order.item_list || [];
  const totalQty = items.reduce((sum, i) => sum + (i.model_quantity_purchased || 0), 0);
  const incomingUpdateTime = order.update_time ? new Date(order.update_time * 1000) : null;

  await db.transaction(async (trx) => {
    const existing = await trx('orders')
      .where({ store_id: storeId, order_sn: order.order_sn })
      .first();

    const row = {
      store_id: storeId,
      order_sn: order.order_sn,
      order_id: order.order_id || order.order_sn,
      income_invoice_id: order?.invoice_data?.invoice_no || null,
      buyer_name: order.buyer_username || '',
      order_status: order.order_status || '',
      payment_method: order.payment_method || '',
      create_time: order.create_time ? new Date(order.create_time * 1000) : null,
      update_time: incomingUpdateTime,
      total_quantity: totalQty,
      order_total: toRupiahInt(order.total_amount),
      synced_at: new Date(),
      updated_at: new Date(),
    };

    let orderId;
    if (existing) {
      const existingUpdateTs = toTimestampSeconds(existing.update_time);
      const incomingUpdateTs = toTimestampSeconds(incomingUpdateTime);
      const shouldResetEscrow = incomingUpdateTs >= existingUpdateTs;
      if (shouldResetEscrow) {
        row.escrow_synced = false;
        row.escrow_updated_at = null;
      }

      await trx('orders').where({ id: existing.id }).update(row);
      orderId = existing.id;
    } else {
      row.escrow_synced = false;
      const [inserted] = await trx('orders').insert(row).returning('id');
      orderId = inserted.id || inserted;
    }

    await trx('order_items').where({ order_id: orderId }).del();
    if (items.length > 0) {
      await trx('order_items').insert(
        items.map((item) => {
          const quantity = item.model_quantity_purchased || 0;
          const unitPrice = toRupiahInt(item.model_discounted_price || item.model_original_price || 0);
          return {
            order_id: orderId,
            item_name: item.item_name || '',
            sku: item.model_name || '',
            quantity,
            unit_price: unitPrice,
            subtotal: toRupiahInt(unitPrice * quantity),
          };
        })
      );
    }
  });
}

async function updateEscrow(orderId, escrow) {
  const orderIncome = escrow.order_income || escrow || {};
  const netIncome = orderIncome.final_escrow_amount ??
    orderIncome.escrow_amount_after_adjustment ??
    orderIncome.escrow_amount ??
    0;

  await db('orders').where({ id: orderId }).update({
    escrow_synced: true,
    escrow_updated_at: new Date(),
    raw_escrow: escrow,
    admin_fee: toRupiahInt(orderIncome.commission_fee || orderIncome.seller_commission || 0),
    service_fee: toRupiahInt(orderIncome.service_fee || 0),
    transaction_fee: toRupiahInt(orderIncome.credit_card_fee || orderIncome.transaction_fee || 0),
    shipping_fee: toRupiahInt(orderIncome.actual_shipping_fee || 0),
    shipping_fee_rebate: toRupiahInt(orderIncome.shipping_fee_discount_from_3pl || orderIncome.shipping_fee_rebate || 0),
    buyer_shipping_fee: toRupiahInt(orderIncome.buyer_paid_shipping_fee || 0),
    shopee_shipping_rebate: toRupiahInt(orderIncome.shopee_shipping_rebate || 0),
    voucher_from_shopee: toRupiahInt(orderIncome.voucher_from_shopee || 0),
    voucher_from_seller: toRupiahInt(orderIncome.voucher_from_seller || 0),
    coins: toRupiahInt(orderIncome.coins || 0),
    order_income: toRupiahInt(orderIncome.escrow_amount || netIncome),
    net_income: toRupiahInt(netIncome),
    updated_at: new Date(),
  });
}

module.exports = { syncStore, acquireLock, releaseLock };
