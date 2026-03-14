const bcrypt = require('bcrypt');
const db = require('../db');
const config = require('../config');

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
  const email = String(args.email || '').trim().toLowerCase();
  const password = String(args.password || '');
  const name = String(args.name || '').trim();

  if (!email || !password) {
    throw new Error('Usage: npm run admin:create -- --email admin@example.com --password strong-password [--name "Admin User"]');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (!config.adminEmails.includes(email)) {
    throw new Error(`Email ${email} is not in ADMIN_EMAILS. Add it to your environment first.`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await db('users').where({ email }).first();

  if (existing) {
    await db('users')
      .where({ id: existing.id })
      .update({
        password_hash: passwordHash,
        name: name || existing.name || '',
        updated_at: db.fn.now(),
      });
    console.log(`Updated admin user: ${email}`);
    return;
  }

  await db('users').insert({
    email,
    password_hash: passwordHash,
    name,
  });
  console.log(`Created admin user: ${email}`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
