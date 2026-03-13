const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/crypto');

const { partnerId, partnerKey, apiHost } = config.shopee;
const { baseDelayMs, maxRetries } = config.sync;

// --- Signature ---

function sign(path, timestamp, accessToken, shopId) {
  const base = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(base).digest('hex');
}

function commonParams(path, accessToken, shopId) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    partner_id: partnerId,
    timestamp,
    sign: sign(path, timestamp, accessToken, shopId),
    access_token: accessToken,
    shop_id: shopId,
  };
}

// --- HTTP with adaptive retry ---

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callApi(method, path, store, params = {}, body = null) {
  const accessToken = decrypt(store.access_token);
  const shopId = store.shop_id;
  const common = commonParams(path, accessToken, shopId);
  const url = `${apiHost}${path}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await axios({
        method,
        url,
        params: { ...common, ...params },
        data: body,
        timeout: 15000,
      });

      const data = resp.data;
      if (!data || typeof data !== 'object') {
        throw new Error(`Unexpected Shopee response type for ${path}`);
      }

      // Shopee returns error in response body, not HTTP status
      if (data.error) {
        const errCode = data.error;
        // Rate limited
        if (errCode === 'error_auth' || errCode === 'error_server' || errCode === 'error_too_many_request') {
          if (attempt < maxRetries) {
            const delay = baseDelayMs * Math.pow(2, attempt);
            logger.warn(`Shopee API ${errCode} on ${path}, retry ${attempt + 1} in ${delay}ms`);
            await sleep(delay);
            continue;
          }
        }
        throw new ShopeeApiError(errCode, data.message || '', path);
      }

      return data.response || {};
    } catch (err) {
      if (err instanceof ShopeeApiError) throw err;

      // Network/HTTP errors
      const status = err.response?.status;
      if (status === 429 || (status >= 500 && status < 600)) {
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          logger.warn(`HTTP ${status} on ${path}, retry ${attempt + 1} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
      }
      throw err;
    }
  }
}

class ShopeeApiError extends Error {
  constructor(code, message, path) {
    super(`Shopee API error: ${code} - ${message} (${path})`);
    this.code = code;
    this.name = 'ShopeeApiError';
  }
}

// --- Order APIs ---

async function getOrderList(store, { timeFrom, timeTo, cursor = '' }) {
  const path = '/api/v2/order/get_order_list';
  const params = {
    time_range_field: 'update_time',
    time_from: timeFrom,
    time_to: timeTo,
    page_size: 50,
    order_direction: 'ASC',
    response_optional_fields: 'order_status',
  };
  if (cursor) {
    params.cursor = cursor;
  }

  await sleep(baseDelayMs);
  const resp = await callApi('GET', path, store, params);
  const entries = (resp.order_list || []).map((order) => ({
    orderSn: order.order_sn,
    updateTime: order.update_time || order.update_time_range_field || 0,
  }));
  return {
    orderEntries: entries,
    more: resp.more,
    nextCursor: resp.next_cursor || '',
  };
}

async function getOrderDetail(store, orderSnList) {
  const path = '/api/v2/order/get_order_detail';
  const params = {
    order_sn_list: orderSnList.join(','),
    response_optional_fields: [
      'buyer_user_id', 'buyer_username', 'estimated_shipping_fee',
      'actual_shipping_fee', 'total_amount', 'item_list',
      'pay_time', 'payment_method', 'invoice_data',
    ].join(','),
  };

  await sleep(baseDelayMs);
  return callApi('GET', path, store, params);
}

async function getEscrowDetail(store, orderSn) {
  const path = '/api/v2/payment/get_escrow_detail';
  const params = { order_sn: orderSn };

  await sleep(baseDelayMs);
  return callApi('GET', path, store, params);
}

// --- Auth APIs (no store token needed, use partner-level signature) ---

function signPartner(path, timestamp) {
  const base = `${partnerId}${path}${timestamp}`;
  return crypto.createHmac('sha256', partnerKey).update(base).digest('hex');
}

function generateAuthUrl(state) {
  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signPartner(path, timestamp);
  const redirectUrl = encodeURIComponent(config.shopee.redirectUrl);
  return `${apiHost}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sig}&redirect=${redirectUrl}&state=${state}`;
}

async function exchangeCode(code, shopId) {
  const path = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signPartner(path, timestamp);

  const resp = await axios.post(`${apiHost}${path}`, {
    code,
    shop_id: parseInt(shopId, 10),
    partner_id: partnerId,
  }, {
    params: { partner_id: partnerId, timestamp, sign: sig },
    timeout: 15000,
  });

  if (resp.data.error) {
    throw new ShopeeApiError(resp.data.error, resp.data.message || '', path);
  }

  return {
    accessToken: resp.data.access_token,
    refreshToken: resp.data.refresh_token,
    expiresIn: resp.data.expire_in, // seconds
    shopId: resp.data.shop_id,
  };
}

async function refreshAccessToken(shopId, currentRefreshToken) {
  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signPartner(path, timestamp);

  const resp = await axios.post(`${apiHost}${path}`, {
    shop_id: parseInt(shopId, 10),
    refresh_token: currentRefreshToken,
    partner_id: partnerId,
  }, {
    params: { partner_id: partnerId, timestamp, sign: sig },
    timeout: 15000,
  });

  if (resp.data.error) {
    throw new ShopeeApiError(resp.data.error, resp.data.message || '', path);
  }

  return {
    accessToken: resp.data.access_token,
    refreshToken: resp.data.refresh_token,
    expiresIn: resp.data.expire_in,
  };
}

module.exports = {
  getOrderList,
  getOrderDetail,
  getEscrowDetail,
  generateAuthUrl,
  exchangeCode,
  refreshAccessToken,
  ShopeeApiError,
};
