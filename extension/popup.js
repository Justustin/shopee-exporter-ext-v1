const DEFAULT_SETTINGS = {
  exportFilenamePrefix: 'shopee-export',
  exportLabel: '',
  includeProfileEmailInFilename: false,
  autoClearAfterExport: false,
  licenseApiBaseUrl: 'http://localhost:3000'
};

const elements = {
  orderCount: document.getElementById('orderCount'),
  remainingCount: document.getElementById('remainingCount'),
  statusText: document.getElementById('statusText'),
  lastRunText: document.getElementById('lastRunText'),
  fileNameText: document.getElementById('fileNameText'),
  messageBox: document.getElementById('messageBox'),
  btnStart: document.getElementById('btnStart'),
  btnExportExcel: document.getElementById('btnExportExcel'),
  btnExportCSV: document.getElementById('btnExportCSV'),
  btnActivate: document.getElementById('btnActivate'),
  btnRemoveLicense: document.getElementById('btnRemoveLicense'),
  licenseKeyInput: document.getElementById('licenseKeyInput'),
  licenseInactiveView: document.getElementById('licenseInactiveView'),
  licenseActiveView: document.getElementById('licenseActiveView'),
  licenseStatusText: document.getElementById('licenseStatusText'),
  licenseSummaryText: document.getElementById('licenseSummaryText'),
  licensePlanText: document.getElementById('licensePlanText'),
  licenseCustomerText: document.getElementById('licenseCustomerText'),
  licenseStoreText: document.getElementById('licenseStoreText'),
  licenseExpiryText: document.getElementById('licenseExpiryText'),
  licenseVerifiedText: document.getElementById('licenseVerifiedText'),
  settingsLink: document.getElementById('settingsLink')
};

let snapshot = {
  status: null,
  lastSyncMeta: null,
  settings: DEFAULT_SETTINGS
};

refreshStatus();

elements.btnActivate.addEventListener('click', async () => {
  const licenseKey = elements.licenseKeyInput.value.trim();
  if (!licenseKey) {
    setMessage('warning', 'Enter the activation key first.');
    return;
  }

  setMessage('info', 'Activating license...');
  elements.btnActivate.disabled = true;
  elements.btnActivate.textContent = 'Activating...';

  const response = await sendMessage({ type: 'ACTIVATE_LICENSE', licenseKey });
  await refreshStatus();

  elements.btnActivate.disabled = false;
  elements.btnActivate.textContent = 'Activate License';

  if (!response || !response.ok) {
    setMessage('error', response?.error || 'License activation failed.');
    return;
  }

  elements.licenseKeyInput.value = '';
  setMessage('success', 'License activated. Start is now available.');
});

elements.btnRemoveLicense.addEventListener('click', async () => {
  setMessage('info', 'Removing stored license...');
  const response = await sendMessage({ type: 'CLEAR_LICENSE' });
  await refreshStatus();

  if (!response || !response.ok) {
    setMessage('error', response?.error || 'Failed to remove stored license.');
    return;
  }

  setMessage('success', 'Stored license removed.');
});

elements.btnStart.addEventListener('click', async () => {
  setMessage('info', 'Refreshing page and starting sync...');
  elements.btnStart.disabled = true;
  elements.btnStart.textContent = 'Starting...';

  const response = await sendMessage({ type: 'START_CAPTURE' });
  await refreshStatus();

  if (!response || !response.ok) {
    setMessage('error', `Start failed: ${response?.error || 'unknown error'}`);
    return;
  }

  if (snapshot.status && snapshot.status.orderCount > 0) {
    setMessage('success', 'Sync finished. Export is ready.');
    return;
  }

  setMessage('warning', 'Sync finished, but no exportable orders were found in the current data.');
});

elements.btnExportExcel.addEventListener('click', async () => {
  await exportData('excel');
});

elements.btnExportCSV.addEventListener('click', async () => {
  await exportData('csv');
});

elements.settingsLink.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'DATA_UPDATED') {
    refreshStatus();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.lastSyncMeta || changes.extensionSettings || changes.licenseState) {
    refreshStatus();
  }
});

async function refreshStatus() {
  const [status, storage] = await Promise.all([
    sendMessage({ type: 'GET_STATUS' }),
    storageGet(['lastSyncMeta', 'extensionSettings'])
  ]);

  if (!status) {
    elements.statusText.textContent = 'Background unavailable';
    elements.btnStart.disabled = false;
    elements.btnStart.textContent = 'Start';
    renderLicense(null);
    return;
  }

  snapshot = {
    status,
    lastSyncMeta: storage.lastSyncMeta || null,
    settings: normalizeSettings(storage.extensionSettings)
  };

  elements.orderCount.textContent = String(status.orderCount || 0);
  elements.remainingCount.textContent = String(status.remainingInvoiceCount || status.pendingHydrationCount || 0);
  elements.statusText.textContent = deriveStatusText(status);
  elements.lastRunText.textContent = formatTimestamp(snapshot.lastSyncMeta?.ts);
  elements.fileNameText.textContent = buildFilename('excel');

  renderLicense(status.license || null);
}

async function exportData(kind) {
  setMessage('info', kind === 'excel' ? 'Preparing Excel export...' : 'Preparing CSV export...');
  const response = await sendMessage({
    type: kind === 'excel' ? 'EXPORT_EXCEL_COLORED' : 'EXPORT_CSV'
  });
  await refreshStatus();

  if (!response || !response.ok) {
    setMessage('warning', response?.error || 'Export failed. Press Start again after Shopee finishes loading data.');
    return;
  }

  if (kind === 'excel' && response.excel) {
    downloadFile(
      response.excel,
      buildFilename('excel'),
      'application/vnd.ms-excel;charset=utf-8',
      false
    );
  } else if (kind === 'csv' && response.csv) {
    downloadFile(
      response.csv,
      buildFilename('csv'),
      'text/csv;charset=utf-8'
    );
  }

  if (snapshot.settings.autoClearAfterExport) {
    await sendMessage({ type: 'CLEAR_DATA' });
    await refreshStatus();
  }

  setMessage('success', kind === 'excel' ? 'Excel downloaded.' : 'CSV downloaded.');
}

function renderLicense(license) {
  const active = Boolean(license?.active);

  elements.licenseInactiveView.classList.toggle('hidden', active);
  elements.licenseActiveView.classList.toggle('hidden', !active);
  elements.btnStart.classList.toggle('hidden', !active);
  elements.btnExportExcel.classList.toggle('hidden', !active);
  elements.btnExportCSV.classList.toggle('hidden', !active);

  if (!active) {
    elements.licenseStatusText.textContent = license?.lastError || 'Activation required';
    elements.btnStart.disabled = true;
    elements.btnExportExcel.disabled = true;
    elements.btnExportCSV.disabled = true;
    return;
  }

  const status = snapshot.status || {};
  const offlineGrace = Boolean(license.offlineGraceActive);
  const disableExport = status.syncInFlight || (status.orderCount || 0) === 0;

  elements.licenseSummaryText.textContent = offlineGrace ? 'Offline grace' : 'Active';
  const maxStores = Number(license.maxStores || 0);
  const storeCount = Number(license.storeCount || 0);
  elements.licensePlanText.textContent = license.plan
    ? `${license.plan}${maxStores > 0 ? ` (${storeCount}/${maxStores} stores)` : ''}`
    : '-';
  elements.licenseCustomerText.textContent = license.customerEmail || license.customerName || '-';
  elements.licenseStoreText.textContent = resolveStoreDisplayName(snapshot.status?.storeContext, license);
  elements.licenseExpiryText.textContent = formatIsoDate(license.expiresAt) || 'No expiry';
  elements.licenseVerifiedText.textContent = formatTimestamp(license.lastVerifiedAt) || 'Never';

  elements.btnStart.disabled = Boolean(status.syncInFlight);
  elements.btnStart.textContent = status.syncInFlight ? 'Running...' : 'Start';
  elements.btnExportExcel.disabled = disableExport;
  elements.btnExportCSV.disabled = disableExport;
}

function deriveStatusText(status) {
  if (!status.license?.active) {
    return 'Activation required';
  }
  const remaining = status.remainingInvoiceCount || status.pendingHydrationCount || 0;
  if (status.syncInFlight) {
    return remaining > 0 ? `Running - ${remaining} left` : 'Running';
  }
  if ((status.orderCount || 0) === 0) {
    return 'Idle';
  }
  return 'Ready to export';
}

function resolveStoreDisplayName(storeContext, license) {
  const context = storeContext || {};
  if (context.storeName) {
    return context.storeName;
  }

  const boundStores = Array.isArray(license?.boundStores) ? license.boundStores : [];
  if (context.storeKey) {
    const matched = boundStores.find((store) => store?.storeKey === context.storeKey && store?.storeName);
    if (matched?.storeName) {
      return matched.storeName;
    }
  }

  if (boundStores.length === 1 && boundStores[0]?.storeName) {
    return boundStores[0].storeName;
  }

  return '-';
}

function buildFilename(kind) {
  const settings = snapshot.settings || DEFAULT_SETTINGS;
  const profileEmail = snapshot.status?.profileEmail || snapshot.lastSyncMeta?.profileEmail || '';
  const parts = [];
  const prefix = sanitizeFilenamePart(settings.exportFilenamePrefix || DEFAULT_SETTINGS.exportFilenamePrefix);
  const label = sanitizeFilenamePart(settings.exportLabel || '');
  const profileTag = settings.includeProfileEmailInFilename ? sanitizeFilenamePart(extractProfileTag(profileEmail)) : '';
  const datePart = new Date().toISOString().slice(0, 10);

  if (prefix) parts.push(prefix);
  if (label) parts.push(label);
  if (profileTag) parts.push(profileTag);
  parts.push(datePart);
  if (kind === 'excel') {
    parts.push('colored');
  }

  return `${parts.join('-')}.${kind === 'excel' ? 'xls' : 'csv'}`;
}

function extractProfileTag(profileEmail) {
  if (!profileEmail) return '';
  return String(profileEmail).split('@')[0] || '';
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeSettings(raw) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  settings.exportFilenamePrefix = String(settings.exportFilenamePrefix || DEFAULT_SETTINGS.exportFilenamePrefix).trim() || DEFAULT_SETTINGS.exportFilenamePrefix;
  settings.exportLabel = String(settings.exportLabel || '').trim();
  settings.includeProfileEmailInFilename = Boolean(settings.includeProfileEmailInFilename);
  settings.autoClearAfterExport = Boolean(settings.autoClearAfterExport);
  settings.licenseApiBaseUrl = String(settings.licenseApiBaseUrl || DEFAULT_SETTINGS.licenseApiBaseUrl).trim() || DEFAULT_SETTINGS.licenseApiBaseUrl;
  return settings;
}

function formatTimestamp(ts) {
  if (!ts) return 'Never';
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return 'Never';
  return date.toLocaleString('id-ID');
}

function formatIsoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString('id-ID');
}

function setMessage(type, text) {
  elements.messageBox.className = `message visible ${type}`;
  elements.messageBox.textContent = text;
}

function downloadFile(content, filename, mimeType, includeBom = true) {
  const payload = includeBom ? '\uFEFF' + content : content;
  const blob = new Blob([payload], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result || {});
    });
  });
}
