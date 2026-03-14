const cron = require('node-cron');
const logger = require('../utils/logger');
const { runSyncAll } = require('./sync-orders');
const { runTokenRefresh } = require('./refresh-tokens');
const { pruneVerificationHistory } = require('../services/license-service');
const db = require('../db');

function start() {
  // Token refresh: every 3 hours
  cron.schedule('0 */3 * * *', async () => {
    try {
      await runTokenRefresh();
    } catch (err) {
      logger.error('Token refresh cron failed', err);
    }
  });

  // Order sync: every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    try {
      await runSyncAll();
    } catch (err) {
      logger.error('Order sync cron failed', err);
    }
  });

  // Subscription check: daily at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      const now = new Date();
      // Expire trials
      await db('subscriptions')
        .where('status', 'active')
        .where('plan', 'trial')
        .where('trial_ends_at', '<', now)
        .update({ status: 'expired', updated_at: now });

      // Expire lapsed paid
      await db('subscriptions')
        .where('status', 'active')
        .whereNot('plan', 'trial')
        .where('paid_until', '<', now)
        .update({ status: 'expired', updated_at: now });

      const deletedVerifications = await pruneVerificationHistory();
      logger.info('Subscription check complete');
      if (deletedVerifications > 0) {
        logger.info(`Pruned ${deletedVerifications} old license verification rows`);
      }
    } catch (err) {
      logger.error('Subscription check cron failed', err);
    }
  });

  logger.info('Scheduler started: token refresh (3h), order sync (6h), subscription check (daily)');
}

module.exports = { start };
