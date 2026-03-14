# Shopee Order Exporter

Chrome extension for capturing Shopee Seller Centre income and invoice detail, then exporting per-order fee breakdowns to CSV or colored Excel.

## What it does

- Captures order, income, and invoice detail while you browse Seller Centre.
- Pulls additional invoice breakdown data from Shopee background requests.
- Exports one row per item while keeping invoice-level totals on the first row of each invoice group.
- Produces a colored Excel export for easier review by invoice group.

## Load locally

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the [`extension`](./extension) folder

## Recommended workflow

1. Log into `https://seller.shopee.co.id`
2. Open the extension popup
3. Click `Start`
4. Wait for the sync to finish
5. Export Excel or CSV

## Settings

Open the extension options page to configure:

- Export filename prefix
- Optional seller label in filename
- Whether to include the Shopee profile email in filenames
- Whether to auto-clear captured data after successful export

## Customer build

To prepare a buyer-facing build that points to your hosted license server:

```powershell
node scripts/build-customer-extension.js --license-url https://license.yourdomain.com
```

That produces `dist/extension-customer`.

Deployment notes for the license backend are in [`docs/phase1-deploy.md`](./docs/phase1-deploy.md).
Buyer handoff docs are in [`docs/buyer-install.md`](./docs/buyer-install.md) and [`docs/buyer-usage.md`](./docs/buyer-usage.md).
Ship `dist/extension-customer`, not the raw [`extension`](./extension) folder.

## Repo layout

- [`extension/manifest.json`](./extension/manifest.json)
- [`extension/background.js`](./extension/background.js)
- [`extension/popup.html`](./extension/popup.html)
- [`extension/popup.js`](./extension/popup.js)
- [`extension/options.html`](./extension/options.html)
- [`extension/options.js`](./extension/options.js)

## Notes

- The extension depends on a valid Shopee Seller Centre browser session.
- Shopee internal endpoints can change. When they do, the capture logic in [`extension/background.js`](./extension/background.js) is the main place to adjust.
