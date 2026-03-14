const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');

const PLAN_STORE_LIMITS = {
  trial: 1,
  starter: 1,
  growth: 3,
  pro: 10,
  agency: 10,
};

function normalizeLicenseKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9-]/g, '');
}

function normalizeStoreNameValue(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenericStoreName(value) {
  const normalized = normalizeStoreNameValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return false;
  return [
    'shopee seller centre',
    'shopee seller center',
    'seller centre',
    'seller center',
    'shopee'
  ].includes(normalized);
}

function isGenericStoreKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized.startsWith('name:')) return false;
  return [
    'name:shopee-seller-centre',
    'name:shopee-seller-center',
    'name:seller-centre',
    'name:seller-center',
    'name:shopee'
  ].includes(normalized);
}

function isPlaceholderStoreIdentity({ storeKey = '', storeName = '' } = {}) {
  return isGenericStoreKey(storeKey) || isGenericStoreName(storeName);
}

function hashLicenseKey(licenseKey) {
  return crypto
    .createHmac('sha256', config.license.pepper)
    .update(normalizeLicenseKey(licenseKey))
    .digest('hex');
}

function createReadableKey() {
  const raw = crypto.randomBytes(10).toString('hex').toUpperCase();
  return `SHXP1-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

function normalizeStoreIdentity({ storeKey = '', storeName = '' } = {}) {
  const normalizedName = normalizeStoreNameValue(storeName);
  const sanitizedName = isGenericStoreName(normalizedName) ? '' : normalizedName;
  let normalizedKey = String(storeKey || '').trim();
  if (isGenericStoreKey(normalizedKey)) {
    normalizedKey = '';
  }
  if (!normalizedKey && sanitizedName) {
    normalizedKey = `name:${sanitizedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
  }
  return {
    storeKey: normalizedKey,
    storeName: sanitizedName,
  };
}

function sanitizeLicenseRecord(record, boundStores = []) {
  if (!record) return null;
  return {
    id: record.id,
    plan: record.plan,
    status: record.status,
    notes: record.notes || '',
    customerEmail: record.customer_email || '',
    customerName: record.customer_name || '',
    expiresAt: record.expires_at ? new Date(record.expires_at).toISOString() : '',
    lastVerifiedAt: record.last_verified_at ? new Date(record.last_verified_at).toISOString() : '',
    createdAt: record.created_at ? new Date(record.created_at).toISOString() : '',
    updatedAt: record.updated_at ? new Date(record.updated_at).toISOString() : '',
    maxStores: record.max_stores || 1,
    storeCount: boundStores.length,
    boundStores: boundStores.map((store) => ({
      id: store.id,
      storeKey: store.store_key,
      storeName: store.store_name || '',
      firstVerifiedAt: store.first_verified_at ? new Date(store.first_verified_at).toISOString() : '',
      lastVerifiedAt: store.last_verified_at ? new Date(store.last_verified_at).toISOString() : '',
    })),
  };
}

function isExpired(record) {
  if (!record?.expires_at) return false;
  return new Date(record.expires_at).getTime() < Date.now();
}

function getDefaultStoreLimit(plan) {
  return PLAN_STORE_LIMITS[String(plan || '').trim().toLowerCase()] || 1;
}

async function fetchLicenseWithStores(trx, licenseId) {
  const license = await trx('licenses').where({ id: licenseId }).first();
  if (!license) return null;
  const boundStores = await trx('license_stores')
    .where({ license_id: licenseId })
    .orderBy('id', 'asc');
  return { license, boundStores };
}

async function fetchBoundStoresMap(executor, licenseIds) {
  const ids = Array.from(new Set((licenseIds || []).map((id) => parseInt(id, 10)).filter(Number.isFinite)));
  const result = new Map();
  if (!ids.length) return result;

  const rows = await executor('license_stores')
    .whereIn('license_id', ids)
    .orderBy([{ column: 'license_id', order: 'asc' }, { column: 'id', order: 'asc' }]);

  for (const id of ids) {
    result.set(id, []);
  }
  for (const row of rows) {
    if (!result.has(row.license_id)) {
      result.set(row.license_id, []);
    }
    result.get(row.license_id).push(row);
  }
  return result;
}

async function recordVerification(executor, {
  licenseId = null,
  licenseKeyHash = '',
  storeIdentity = {},
  meta = {},
  success = false,
  code = '',
  error = ''
} = {}) {
  try {
    await executor('license_verifications').insert({
      license_id: licenseId || null,
      license_key_hash: licenseKeyHash || null,
      store_key: storeIdentity.storeKey || null,
      store_name: storeIdentity.storeName || null,
      build_tag: meta.buildTag || null,
      profile_email: meta.profileEmail || null,
      result_code: code || 'UNKNOWN',
      success: Boolean(success),
      error_message: error || null,
      metadata: {
        buildTag: meta.buildTag || '',
        profileEmail: meta.profileEmail || '',
      },
    });
  } catch (verificationError) {
    logger.error('Failed to record license verification', {
      error: verificationError.message,
      stack: verificationError.stack,
      licenseId,
      code,
    });
  }
}

async function verifyLicense({ licenseKey, storeKey = '', storeName = '', meta = {} }) {
  const normalizedKey = normalizeLicenseKey(licenseKey);
  if (!normalizedKey) {
    const result = { ok: false, code: 'LICENSE_KEY_REQUIRED', error: 'License key is required' };
    await recordVerification(db, { code: result.code, error: result.error, meta });
    return result;
  }

  const storeIdentity = normalizeStoreIdentity({ storeKey, storeName });
  const hash = hashLicenseKey(normalizedKey);
  if (!storeIdentity.storeKey) {
    const result = { ok: false, code: 'STORE_REQUIRED', error: 'Active Shopee store could not be identified' };
    await recordVerification(db, {
      licenseKeyHash: hash,
      storeIdentity,
      meta,
      code: result.code,
      error: result.error,
    });
    return result;
  }

  return db.transaction(async (trx) => {
    const license = await trx('licenses')
      .where({ license_key_hash: hash })
      .first()
      .forUpdate();

    if (!license) {
      const result = { ok: false, code: 'LICENSE_NOT_FOUND', error: 'License key not found' };
      await recordVerification(trx, {
        licenseKeyHash: hash,
        storeIdentity,
        meta,
        code: result.code,
        error: result.error,
      });
      return result;
    }
    if (license.status !== 'active') {
      const result = { ok: false, code: 'LICENSE_INACTIVE', error: 'License is inactive' };
      await recordVerification(trx, {
        licenseId: license.id,
        licenseKeyHash: hash,
        storeIdentity,
        meta,
        code: result.code,
        error: result.error,
      });
      return result;
    }
    if (isExpired(license)) {
      const result = { ok: false, code: 'LICENSE_EXPIRED', error: 'License has expired' };
      await recordVerification(trx, {
        licenseId: license.id,
        licenseKeyHash: hash,
        storeIdentity,
        meta,
        code: result.code,
        error: result.error,
      });
      return result;
    }

    const boundStores = await trx('license_stores')
      .where({ license_id: license.id })
      .orderBy('id', 'asc');

    const existingStore = boundStores.find((store) => store.store_key === storeIdentity.storeKey);
    if (!existingStore) {
      const placeholderStore = boundStores.find((store) => isPlaceholderStoreIdentity({
        storeKey: store.store_key,
        storeName: store.store_name,
      }));

      if (placeholderStore) {
        await trx('license_stores')
          .where({ id: placeholderStore.id })
          .update({
            store_key: storeIdentity.storeKey,
            store_name: storeIdentity.storeName || null,
            last_verified_at: trx.fn.now(),
            updated_at: trx.fn.now(),
            metadata: {
              lastSeenBuildTag: meta.buildTag || '',
              lastSeenProfileEmail: meta.profileEmail || '',
            },
          });
      } else {
        const maxStores = license.max_stores || 1;
        if (boundStores.length >= maxStores) {
          const result = {
            ok: false,
            code: 'STORE_LIMIT_REACHED',
            error: `License already used on ${boundStores.length}/${maxStores} store(s)`,
            license: sanitizeLicenseRecord(license, boundStores),
          };
          await recordVerification(trx, {
            licenseId: license.id,
            licenseKeyHash: hash,
            storeIdentity,
            meta,
            code: result.code,
            error: result.error,
          });
          return result;
        }

        await trx('license_stores').insert({
          license_id: license.id,
          store_key: storeIdentity.storeKey,
          store_name: storeIdentity.storeName || null,
          first_verified_at: trx.fn.now(),
          last_verified_at: trx.fn.now(),
          metadata: {
            lastSeenBuildTag: meta.buildTag || '',
            lastSeenProfileEmail: meta.profileEmail || '',
          },
        });
      }
    } else {
      await trx('license_stores')
        .where({ id: existingStore.id })
        .update({
          store_name: storeIdentity.storeName || existingStore.store_name || null,
          last_verified_at: trx.fn.now(),
          updated_at: trx.fn.now(),
          metadata: {
            lastSeenBuildTag: meta.buildTag || '',
            lastSeenProfileEmail: meta.profileEmail || '',
          },
        });
    }

    await trx('licenses')
      .where({ id: license.id })
      .update({
        last_verified_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });

    const refreshed = await fetchLicenseWithStores(trx, license.id);
    await recordVerification(trx, {
      licenseId: license.id,
      licenseKeyHash: hash,
      storeIdentity,
      meta,
      success: true,
      code: 'OK',
    });

    return {
      ok: true,
      license: sanitizeLicenseRecord(refreshed.license, refreshed.boundStores),
      store: {
        storeKey: storeIdentity.storeKey,
        storeName: storeIdentity.storeName,
      },
    };
  });
}

async function listLicenses(filters = {}) {
  const email = String(filters.email || '').trim().toLowerCase();
  const plan = String(filters.plan || '').trim().toLowerCase();
  const status = String(filters.status || '').trim().toLowerCase();
  const store = String(filters.store || '').trim();

  const query = db('licenses')
    .select('licenses.*')
    .orderBy('licenses.updated_at', 'desc')
    .limit(100);

  if (email) {
    query.whereILike('licenses.customer_email', `%${email}%`);
  }
  if (plan) {
    query.where('licenses.plan', plan);
  }
  if (status) {
    query.where('licenses.status', status);
  }
  if (store) {
    query.whereExists(function filterByStore() {
      this.select(db.raw('1'))
        .from('license_stores')
        .whereRaw('license_stores.license_id = licenses.id')
        .andWhere(function applyStoreSearch() {
          this.whereILike('license_stores.store_name', `%${store}%`)
            .orWhereILike('license_stores.store_key', `%${store}%`);
        });
    });
  }

  const licenses = await query;
  const storeMap = await fetchBoundStoresMap(db, licenses.map((license) => license.id));
  return licenses.map((license) => sanitizeLicenseRecord(license, storeMap.get(license.id) || []));
}

async function getLicenseDetail(licenseId) {
  const id = parseInt(licenseId, 10);
  if (!Number.isFinite(id)) {
    return null;
  }

  const fetched = await fetchLicenseWithStores(db, id);
  if (!fetched) {
    return null;
  }

  const verifications = await db('license_verifications')
    .where({ license_id: id })
    .orderBy('created_at', 'desc')
    .limit(100);

  return {
    license: sanitizeLicenseRecord(fetched.license, fetched.boundStores),
    verifications: verifications.map((entry) => ({
      id: entry.id,
      storeKey: entry.store_key || '',
      storeName: entry.store_name || '',
      buildTag: entry.build_tag || '',
      profileEmail: entry.profile_email || '',
      resultCode: entry.result_code || '',
      success: Boolean(entry.success),
      errorMessage: entry.error_message || '',
      createdAt: entry.created_at ? new Date(entry.created_at).toISOString() : '',
    })),
  };
}

async function updateLicenseStatus(licenseId, status) {
  const id = parseInt(licenseId, 10);
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!Number.isFinite(id) || !['active', 'inactive'].includes(normalizedStatus)) {
    throw new Error('Invalid license status update');
  }

  const updated = await db('licenses')
    .where({ id })
    .update({
      status: normalizedStatus,
      updated_at: db.fn.now(),
    });
  if (!updated) {
    throw new Error('License not found');
  }

  return getLicenseDetail(id);
}

async function extendLicenseExpiry(licenseId, days) {
  const id = parseInt(licenseId, 10);
  const extendDays = parseInt(days, 10);
  if (!Number.isFinite(id) || !Number.isFinite(extendDays) || extendDays <= 0) {
    throw new Error('Invalid expiry extension');
  }

  const license = await db('licenses').where({ id }).first();
  if (!license) {
    throw new Error('License not found');
  }

  const now = Date.now();
  const currentExpiry = license.expires_at ? new Date(license.expires_at).getTime() : 0;
  const base = currentExpiry > now ? currentExpiry : now;
  const nextExpiry = new Date(base + extendDays * 24 * 60 * 60 * 1000);

  await db('licenses')
    .where({ id })
    .update({
      expires_at: nextExpiry,
      updated_at: db.fn.now(),
    });

  return getLicenseDetail(id);
}

async function resetLicenseStore(licenseId, boundStoreId) {
  const id = parseInt(licenseId, 10);
  const storeId = parseInt(boundStoreId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(storeId)) {
    throw new Error('Invalid bound store reset');
  }

  const deleted = await db('license_stores')
    .where({ id: storeId, license_id: id })
    .del();
  if (!deleted) {
    throw new Error('Bound store not found');
  }

  await db('licenses')
    .where({ id })
    .update({ updated_at: db.fn.now() });

  return getLicenseDetail(id);
}

async function resetAllLicenseStores(licenseId) {
  const id = parseInt(licenseId, 10);
  if (!Number.isFinite(id)) {
    throw new Error('Invalid bound store reset');
  }

  const license = await db('licenses').where({ id }).first();
  if (!license) {
    throw new Error('License not found');
  }

  await db('license_stores')
    .where({ license_id: id })
    .del();

  await db('licenses')
    .where({ id })
    .update({ updated_at: db.fn.now() });

  return getLicenseDetail(id);
}

async function createLicense({ customerEmail = '', customerName = '', plan = 'starter', durationDays = 30, notes = '', maxStores = null }) {
  const normalizedPlan = String(plan || 'starter').trim() || 'starter';
  const resolvedMaxStores = Number.isFinite(maxStores) && maxStores > 0
    ? maxStores
    : getDefaultStoreLimit(normalizedPlan);

  const licenseKey = createReadableKey();
  const licenseKeyHash = hashLicenseKey(licenseKey);
  const expiresAt = Number.isFinite(durationDays) && durationDays > 0
    ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)
    : null;

  const [record] = await db('licenses')
    .insert({
      license_key_hash: licenseKeyHash,
      customer_email: String(customerEmail || '').trim().toLowerCase(),
      customer_name: String(customerName || '').trim(),
      plan: normalizedPlan,
      status: 'active',
      expires_at: expiresAt,
      notes: String(notes || '').trim(),
      metadata: {},
      max_stores: resolvedMaxStores,
    })
    .returning('*');

  return {
    licenseKey,
    license: sanitizeLicenseRecord(record, []),
  };
}

module.exports = {
  normalizeLicenseKey,
  hashLicenseKey,
  normalizeStoreIdentity,
  verifyLicense,
  createLicense,
  getDefaultStoreLimit,
  listLicenses,
  getLicenseDetail,
  updateLicenseStatus,
  extendLicenseExpiry,
  resetLicenseStore,
  resetAllLicenseStores,
};
