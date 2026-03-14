# Phase 1 Deployment

This is the minimum setup for selling the extension with manual license keys.

## Architecture

- `shopee-saas` runs on your VPS
- PostgreSQL runs on Neon
- the extension talks to your hosted license API
- buyers only install the extension and paste an activation key

## 1. Backend deploy

Recommended:

- VPS: DigitalOcean / Hetzner
- Node.js 22 LTS
- reverse proxy: Nginx
- process manager: PM2 or systemd
- database: Neon PostgreSQL

Required environment:

```env
NODE_ENV=production
PORT=3000
SESSION_SECRET=replace-with-long-random-secret
LICENSE_PEPPER=replace-with-long-random-secret
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DB?sslmode=require
DATABASE_SSL=false
ENABLE_SHOPEE_PLATFORM=false
```

Deploy commands:

```powershell
cd shopee-saas
npm install
npm run migrate
npm run start
```

Health checks:

- `GET /health`
- `GET /health/db`

## 2. Reverse proxy

Expose the backend as HTTPS on a real domain, for example:

- `https://license.yourdomain.com`

Your reverse proxy should forward HTTPS traffic to `http://127.0.0.1:3000`.

## 3. Build the customer extension

From the repo root:

```powershell
node scripts/build-customer-extension.js --license-url https://license.yourdomain.com
```

Output:

- `dist/extension-customer`

That folder is the customer build. Load or zip that folder, not the source `extension` folder.

## 4. Create buyer licenses

```powershell
cd shopee-saas
npm run license:create -- --email buyer@example.com --plan starter --days 30
```

For multi-store plans:

```powershell
npm run license:create -- --email buyer@example.com --plan growth --days 30
```

or:

```powershell
npm run license:create -- --email buyer@example.com --plan custom --stores 5 --days 30
```

## 5. Buyer handoff

Send the buyer:

- the built extension package from `dist/extension-customer`
- the activation key
- install steps:
  1. load the extension
  2. log into Shopee Seller Centre
  3. paste the activation key
  4. click `Start`

## 6. Operational checklist

Before giving it to buyers:

- verify `https://license.yourdomain.com/health` returns `200`
- verify `https://license.yourdomain.com/health/db` returns `200`
- activate one license against a real store
- export one Excel file from the built extension
- confirm the correct store is bound in the license backend
