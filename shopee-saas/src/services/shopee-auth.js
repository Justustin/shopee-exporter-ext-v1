const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const shopeeApi = require('./shopee-api');
const { encrypt, decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

async function initiateOAuth(session) {
  const state = uuidv4();
  session.shopeeOAuthState = state;
  return shopeeApi.generateAuthUrl(state);
}

async function handleCallback(code, shopId, state, session) {
  // Verify state
  if (!state || state !== session.shopeeOAuthState) {
    throw new Error('Invalid OAuth state - possible CSRF');
  }
  delete session.shopeeOAuthState;

  // Exchange code for tokens
  const tokens = await shopeeApi.exchangeCode(code, shopId);

  // Encrypt tokens before storing
  const encAccessToken = encrypt(tokens.accessToken);
  const encRefreshToken = encrypt(tokens.refreshToken);
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

  // Upsert store
  const existing = await db('stores')
    .where({ user_id: session.userId, shop_id: tokens.shopId })
    .first();

  if (existing) {
    await db('stores').where({ id: existing.id }).update({
      access_token: encAccessToken,
      refresh_token: encRefreshToken,
      token_expires_at: expiresAt,
      is_active: true,
      updated_at: new Date(),
    });
    return existing.id;
  }

  const [store] = await db('stores')
    .insert({
      user_id: session.userId,
      shop_id: tokens.shopId,
      access_token: encAccessToken,
      refresh_token: encRefreshToken,
      token_expires_at: expiresAt,
      is_active: true,
    })
    .returning('*');

  return store.id;
}

async function refreshStoreToken(store) {
  const currentRefresh = decrypt(store.refresh_token);
  const tokens = await shopeeApi.refreshAccessToken(store.shop_id, currentRefresh);

  const encAccess = encrypt(tokens.accessToken);
  const encRefresh = encrypt(tokens.refreshToken);
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

  await db('stores').where({ id: store.id }).update({
    access_token: encAccess,
    refresh_token: encRefresh,
    token_expires_at: expiresAt,
    updated_at: new Date(),
  });

  logger.info(`Refreshed token for store ${store.id} (shop ${store.shop_id})`);
}

module.exports = { initiateOAuth, handleCallback, refreshStoreToken };
