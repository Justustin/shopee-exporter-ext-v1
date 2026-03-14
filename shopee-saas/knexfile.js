require('dotenv').config();

function toBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function buildConnection(isProduction) {
  const connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/shopee_saas';
  const useSsl = toBool(process.env.DATABASE_SSL, isProduction);
  const rejectUnauthorized = toBool(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED, true);
  if (!useSsl) {
    return connectionString;
  }
  return {
    connectionString,
    ssl: { rejectUnauthorized },
  };
}

module.exports = {
  development: {
    client: 'pg',
    connection: buildConnection(false),
    migrations: { directory: './migrations' },
    seeds: { directory: './seeds' },
  },
  production: {
    client: 'pg',
    connection: buildConnection(true),
    migrations: { directory: './migrations' },
    pool: { min: 2, max: 10 },
  },
};
