const db = require('../db');
const { syncStore } = require('../services/sync');
const { fetchLatestSubscriptionsByUserIds, isActiveSubscription } = require('../middleware/subscription');
const logger = require('../utils/logger');

async function runSyncAll() {
  logger.info('Scheduled sync starting...');

  const stores = await db('stores').where({ is_active: true });
  const subscriptionsByUserId = await fetchLatestSubscriptionsByUserIds(stores.map((store) => store.user_id));
  const eligibleStores = stores.filter((store) => isActiveSubscription(subscriptionsByUserId.get(store.user_id)));

  for (const store of eligibleStores) {
    try {
      await syncStore(store);
    } catch (err) {
      logger.error(`Sync failed for store ${store.id}`, err);
    }
  }

  logger.info(`Scheduled sync complete (${eligibleStores.length}/${stores.length} active stores eligible)`);
}

module.exports = { runSyncAll };
