const db = require('../db');
const { syncStore } = require('../services/sync');
const logger = require('../utils/logger');

async function runSyncAll() {
  logger.info('Scheduled sync starting...');

  const stores = await db('stores').where({ is_active: true });

  for (const store of stores) {
    try {
      await syncStore(store);
    } catch (err) {
      logger.error(`Sync failed for store ${store.id}`, err);
    }
  }

  logger.info('Scheduled sync complete');
}

module.exports = { runSyncAll };
