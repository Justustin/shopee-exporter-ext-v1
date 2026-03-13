const DEFAULT_SETTINGS = {
  exportFilenamePrefix: 'shopee-export',
  exportLabel: '',
  includeProfileEmailInFilename: false,
  autoClearAfterExport: false
};

const elements = {
  orderCount: document.getElementById('orderCount'),
  statusText: document.getElementById('statusText'),
  lastRunText: document.getElementById('lastRunText'),
  fileNameText: document.getElementById('fileNameText'),
  messageBox: document.getElementById('messageBox'),
  btnStart: document.getElementById('btnStart'),
  btnExportExcel: document.getElementById('btnExportExcel'),
  btnExportCSV: document.getElementById('btnExportCSV'),
  settingsLink: document.getElementById('settingsLink')
};

let snapshot = {
  status: null,
  lastSyncMeta: null,
  settings: DEFAULT_SETTINGS
};

refreshStatus();

elements.btnStart.addEventListener('click', async () => {
  setMessage('info', 'Starting fresh sync...');
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
  if (changes.lastSyncMeta || changes.extensionSettings) {
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
    return;
  }

  snapshot = {
    status,
    lastSyncMeta: storage.lastSyncMeta || null,
    settings: normalizeSettings(storage.extensionSettings)
  };

  elements.orderCount.textContent = String(status.orderCount || 0);
  elements.statusText.textContent = deriveStatusText(status);
  elements.lastRunText.textContent = formatTimestamp(snapshot.lastSyncMeta?.ts);
  elements.fileNameText.textContent = buildFilename('excel');

  const disableExport = status.syncInFlight || (status.orderCount || 0) === 0;
  elements.btnExportExcel.disabled = disableExport;
  elements.btnExportCSV.disabled = disableExport;
  elements.btnStart.disabled = Boolean(status.syncInFlight);
  elements.btnStart.textContent = status.syncInFlight ? 'Running...' : 'Start';
}

async function exportData(kind) {
  setMessage('info', kind === 'excel' ? 'Preparing Excel export...' : 'Preparing CSV export...');
  const response = await sendMessage({
    type: kind === 'excel' ? 'EXPORT_EXCEL_COLORED' : 'EXPORT_CSV'
  });
  await refreshStatus();

  if (!response || !response.ok) {
    setMessage('warning', 'Export failed. Press Start again after Shopee finishes loading data.');
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

function deriveStatusText(status) {
  if (status.syncInFlight) {
    return 'Running';
  }
  if ((status.orderCount || 0) === 0) {
    return 'Idle';
  }
  return 'Ready to export';
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
  return settings;
}

function formatTimestamp(ts) {
  if (!ts) return 'Never';
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return 'Never';
  return date.toLocaleString('id-ID');
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
