const db = require('../db');
const { createLicense } = require('../services/license-service');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : 'true';
    args[key] = value;
    if (value !== 'true') index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const durationDays = parseInt(args.days || args.durationDays || '30', 10);
  const maxStores = parseInt(args.stores || args.maxStores || '', 10);
  const result = await createLicense({
    customerEmail: args.email || '',
    customerName: args.name || '',
    plan: args.plan || 'starter',
    durationDays: Number.isFinite(durationDays) ? durationDays : 30,
    notes: args.notes || '',
    maxStores: Number.isFinite(maxStores) ? maxStores : null,
  });

  console.log('License created');
  console.log(`Key: ${result.licenseKey}`);
  console.log(`Plan: ${result.license.plan}`);
  console.log(`Max Stores: ${result.license.maxStores}`);
  console.log(`Customer Email: ${result.license.customerEmail || '-'}`);
  console.log(`Expires At: ${result.license.expiresAt || '-'}`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
