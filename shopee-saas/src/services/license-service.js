const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

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

function sanitizeLicenseRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    plan: record.plan,
    status: record.status,
    customerEmail: record.customer_email || '',
    customerName: record.customer_name || '',
    expiresAt: record.expires_at ? new Date(record.expires_at).toISOString() : '',
    boundInstallationId: record.bound_installation_id || '',
    lastVerifiedAt: record.last_verified_at ? new Date(record.last_verified_at).toISOString() : '',
  };
}

function isExpired(record) {
  if (!record?.expires_at) return false;
  return new Date(record.expires_at).getTime() < Date.now();
}

async function verifyLicense({ licenseKey, installationId = '', meta = {} }) {
  const normalizedKey = normalizeLicenseKey(licenseKey);
  if (!normalizedKey) {
    return { ok: false, code: 'LICENSE_KEY_REQUIRED', error: 'License key is required' };
  }

  const installation = String(installationId || '').trim();
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
    if (license.bound_installation_id && installation && license.bound_installation_id !== installation) {
      return { ok: false, code: 'DEVICE_MISMATCH', error: 'License is already activated on another device' };
    }

    const patch = {
      last_verified_at: trx.fn.now(),
      updated_at: trx.fn.now(),
      metadata: {
        lastSeenBuildTag: meta.buildTag || '',
        lastSeenProfileEmail: meta.profileEmail || '',
      },
    };
    if (!license.bound_installation_id && installation) {
      patch.bound_installation_id = installation;
      patch.bound_at = trx.fn.now();
    }

    await trx('licenses').where({ id: license.id }).update(patch);
    const updated = await trx('licenses').where({ id: license.id }).first();

    return {
      ok: true,
      license: sanitizeLicenseRecord(updated),
    };
  });
}

async function createLicense({ customerEmail = '', customerName = '', plan = 'starter', durationDays = 30, notes = '' }) {
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
      plan: String(plan || 'starter').trim() || 'starter',
      status: 'active',
      expires_at: expiresAt,
      notes: String(notes || '').trim(),
      metadata: {},
    })
    .returning('*');

  return {
    licenseKey,
    license: sanitizeLicenseRecord(record),
  };
}

module.exports = {
  normalizeLicenseKey,
  hashLicenseKey,
  verifyLicense,
  createLicense,
};
