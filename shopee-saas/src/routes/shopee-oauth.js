const express = require('express');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { requireActiveSubscription } = require('../middleware/subscription');
const shopeeAuth = require('../services/shopee-auth');
const logger = require('../utils/logger');
const router = express.Router();

function ensureShopeeEnabled(req, res, next) {
  if (config.shopee.enabled) {
    next();
    return;
  }

  if (req.originalUrl.startsWith('/api/')) {
    res.status(503).json({ error: 'Shopee Open Platform is disabled on this server' });
    return;
  }

  res.redirect('/dashboard?error=shopee_disabled');
}

// Redirect user to Shopee authorization page
router.get('/auth/initiate', requireAuth, requireActiveSubscription, ensureShopeeEnabled, async (req, res) => {
  try {
    const url = await shopeeAuth.initiateOAuth(req.session);
    res.redirect(url);
  } catch (err) {
    logger.error('OAuth initiate failed', err);
    res.redirect('/dashboard?error=oauth_failed');
  }
});

// Shopee redirects here after seller authorizes
router.get('/auth/callback', requireAuth, ensureShopeeEnabled, async (req, res) => {
  try {
    const { code, shop_id, state } = req.query;
    if (!code || !shop_id) {
      return res.redirect('/dashboard?error=missing_params');
    }

    const storeId = await shopeeAuth.handleCallback(code, shop_id, state, req.session);
    logger.info(`Store ${storeId} connected for user ${req.session.userId}`);
    res.redirect(`/dashboard/store/${storeId}?connected=true`);
  } catch (err) {
    logger.error('OAuth callback failed', err);
    res.redirect('/dashboard?error=oauth_callback_failed');
  }
});

module.exports = router;
