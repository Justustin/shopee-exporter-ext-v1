const db = require('../db');
const { refreshStoreToken } = require('../services/shopee-auth');
const logger = require('../utils/logger');

async function runTokenRefresh() {
  logger.info('Token refresh check starting...');

  // Refresh tokens expiring within 1 hour
  const threshold = new Date(Date.now() + 60 * 60 * 1000);

  const stores = await db('stores')
    .where({ is_active: true })
    .where('token_expires_at', '<', threshold)
    .whereNotNull('refresh_token');

  for (const store of stores) {
    try {
      await refreshStoreToken(store);
    } catch (err) {
      logger.error(`Token refresh failed for store ${store.id}`, err);
    }
  }

  logger.info(`Token refresh done, ${stores.length} stores checked`);
}

module.exports = { runTokenRefresh };
