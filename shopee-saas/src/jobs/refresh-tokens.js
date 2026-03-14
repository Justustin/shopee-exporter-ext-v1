const db = require('../db');
const { refreshStoreToken } = require('../services/shopee-auth');
const { fetchLatestSubscriptionsByUserIds, isActiveSubscription } = require('../middleware/subscription');
const logger = require('../utils/logger');

async function runTokenRefresh() {
  logger.info('Token refresh check starting...');

  // Refresh tokens expiring within 1 hour
  const threshold = new Date(Date.now() + 60 * 60 * 1000);

  const stores = await db('stores')
    .where({ is_active: true })
    .where('token_expires_at', '<', threshold)
    .whereNotNull('refresh_token');
  const subscriptionsByUserId = await fetchLatestSubscriptionsByUserIds(stores.map((store) => store.user_id));
  const eligibleStores = stores.filter((store) => isActiveSubscription(subscriptionsByUserId.get(store.user_id)));

  for (const store of eligibleStores) {
    try {
      await refreshStoreToken(store);
    } catch (err) {
      logger.error(`Token refresh failed for store ${store.id}`, err);
    }
  }

  logger.info(`Token refresh done, ${eligibleStores.length}/${stores.length} stores eligible`);
}

module.exports = { runTokenRefresh };
