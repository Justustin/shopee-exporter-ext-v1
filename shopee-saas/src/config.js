require('dotenv').config();

function toBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function toList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function toPositiveInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  databaseUrl: process.env.DATABASE_URL || 'postgres://localhost:5432/shopee_saas',
  databaseSsl: toBool(process.env.DATABASE_SSL, process.env.NODE_ENV === 'production'),
  databaseSslRejectUnauthorized: toBool(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED, true),
  allowSelfRegistration: toBool(process.env.ALLOW_SELF_REGISTRATION, process.env.NODE_ENV !== 'production'),

  shopee: {
    enabled: toBool(process.env.ENABLE_SHOPEE_PLATFORM, false),
    partnerId: parseInt(process.env.SHOPEE_PARTNER_ID, 10),
    partnerKey: process.env.SHOPEE_PARTNER_KEY || '',
    redirectUrl: process.env.SHOPEE_REDIRECT_URL || 'http://localhost:3000/shopee/auth/callback',
    apiHost: 'https://partner.shopeemobile.com',
  },

  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
  license: {
    pepper: process.env.LICENSE_PEPPER || process.env.SESSION_SECRET || 'dev-license-pepper',
    verificationRetentionDays: toPositiveInt(process.env.LICENSE_VERIFICATION_RETENTION_DAYS, 90),
  },
  adminEmails: toList(process.env.ADMIN_EMAILS),
  support: {
    email: process.env.SUPPORT_EMAIL || 'support@example.com',
    whatsapp: process.env.SUPPORT_WHATSAPP || '',
  },

  sync: {
    intervalHours: 6,
    lookbackDays: 15,
    escrowBatchLimit: 100,
    lockTimeoutMinutes: 30,
    baseDelayMs: 1100,
    maxRetries: 3,
  },
};

function validateRuntimeConfig() {
  const errors = [];

  if (config.nodeEnv === 'production' && config.sessionSecret === 'dev-secret-change-me') {
    errors.push('SESSION_SECRET must be set in production');
  }
  if (config.nodeEnv === 'production' && !config.adminEmails.length) {
    errors.push('ADMIN_EMAILS must contain at least one admin email in production');
  }
  if (config.nodeEnv === 'production' && config.allowSelfRegistration) {
    errors.push('ALLOW_SELF_REGISTRATION must be false in production');
  }
  if (config.shopee.enabled) {
    if (!Number.isFinite(config.shopee.partnerId) || config.shopee.partnerId <= 0) {
      errors.push('SHOPEE_PARTNER_ID must be set to a positive integer when ENABLE_SHOPEE_PLATFORM=true');
    }
    if (!config.shopee.partnerKey) {
      errors.push('SHOPEE_PARTNER_KEY must be set when ENABLE_SHOPEE_PLATFORM=true');
    }
    if (!config.tokenEncryptionKey || config.tokenEncryptionKey.length !== 64) {
      errors.push('TOKEN_ENCRYPTION_KEY must be a 64-char hex string when ENABLE_SHOPEE_PLATFORM=true');
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

config.validateRuntimeConfig = validateRuntimeConfig;

module.exports = config;
