#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { licenseUrl: '', outDir: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--license-url') {
      args.licenseUrl = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (current === '--out-dir') {
      args.outDir = String(argv[index + 1] || '').trim();
      index += 1;
    }
  }
  return args;
}

function ensureUrl(raw) {
  if (!raw) {
    throw new Error('Missing required --license-url argument');
  }
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('License URL must start with http:// or https://');
  }
  return parsed.origin;
}

function replaceDefaultLicenseUrl(filePath, licenseUrl) {
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = original.replace(
    /const DEFAULT_LICENSE_API_BASE_URL = '.*?';/,
    `const DEFAULT_LICENSE_API_BASE_URL = '${licenseUrl}';`
  );

  if (original === updated) {
    throw new Error(`Could not replace DEFAULT_LICENSE_API_BASE_URL in ${filePath}`);
  }

  fs.writeFileSync(filePath, updated, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const licenseOrigin = ensureUrl(args.licenseUrl);
  const repoRoot = path.resolve(__dirname, '..');
  const sourceDir = path.join(repoRoot, 'extension');
  const outputDir = path.resolve(repoRoot, args.outDir || path.join('dist', 'extension-customer'));

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.cpSync(sourceDir, outputDir, { recursive: true });

  replaceDefaultLicenseUrl(path.join(outputDir, 'background.js'), licenseOrigin);

  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [
    'https://seller.shopee.co.id/*',
    `${licenseOrigin}/*`
  ];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const buildInfo = {
    builtAt: new Date().toISOString(),
    licenseApiBaseUrl: licenseOrigin,
    source: 'customer',
  };
  fs.writeFileSync(
    path.join(outputDir, 'BUILD_INFO.json'),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
    'utf8'
  );

  console.log(`Customer extension build created at ${outputDir}`);
  console.log(`License API URL: ${licenseOrigin}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
