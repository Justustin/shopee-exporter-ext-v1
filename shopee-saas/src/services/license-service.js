const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

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
  const normalizedName = String(storeName || '').trim();
  const normalizedKey = String(storeKey || '').trim();
  return {
    storeKey: normalizedKey,
    storeName: normalizedName,
  };
}

function sanitizeLicenseRecord(record, boundStores = []) {
  if (!record) return null;
  return {
    id: record.id,
    plan: record.plan,
    status: record.status,
    customerEmail: record.customer_email || '',
    customerName: record.customer_name || '',
    expiresAt: record.expires_at ? new Date(record.expires_at).toISOString() : '',
    lastVerifiedAt: record.last_verified_at ? new Date(record.last_verified_at).toISOString() : '',
    maxStores: record.max_stores || 1,
    storeCount: boundStores.length,
    boundStores: boundStores.map((store) => ({
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

async function verifyLicense({ licenseKey, storeKey = '', storeName = '', meta = {} }) {
  const normalizedKey = normalizeLicenseKey(licenseKey);
  if (!normalizedKey) {
    return { ok: false, code: 'LICENSE_KEY_REQUIRED', error: 'License key is required' };
  }

  const storeIdentity = normalizeStoreIdentity({ storeKey, storeName });
  if (!storeIdentity.storeKey) {
    return { ok: false, code: 'STORE_REQUIRED', error: 'Active Shopee store could not be identified' };
  }

  const hash = hashLicenseKey(normalizedKey);

  return db.transaction(async (trx) => {
    const license = await trx('licenses')
      .where({ license_key_hash: hash })
      .first()
      .forUpdate();

    if (!license) {
      return { ok: false, code: 'LICENSE_NOT_FOUND', error: 'License key not found' };
    }
    if (license.status !== 'active') {
      return { ok: false, code: 'LICENSE_INACTIVE', error: 'License is inactive' };
    }
    if (isExpired(license)) {
      return { ok: false, code: 'LICENSE_EXPIRED', error: 'License has expired' };
    }

    const boundStores = await trx('license_stores')
      .where({ license_id: license.id })
      .orderBy('id', 'asc');

    const existingStore = boundStores.find((store) => store.store_key === storeIdentity.storeKey);
    if (!existingStore) {
      const maxStores = license.max_stores || 1;
      if (boundStores.length >= maxStores) {
        return {
          ok: false,
          code: 'STORE_LIMIT_REACHED',
          error: `License already used on ${boundStores.length}/${maxStores} store(s)`,
          license: sanitizeLicenseRecord(license, boundStores),
        };
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
};
