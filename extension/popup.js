const DEFAULT_SETTINGS = {
  exportFilenamePrefix: 'shopee-export',
  exportLabel: '',
  includeProfileEmailInFilename: false,
  autoClearAfterExport: false
};

const SELLER_CENTRE_URL = 'https://seller.shopee.co.id/portal/finance/income?type=2&dateRange=THIS_WEEK';

const elements = {
  orderCount: document.getElementById('orderCount'),
  pendingCount: document.getElementById('pendingCount'),
  buildTag: document.getElementById('buildTag'),
  captureState: document.getElementById('captureState'),
  monitorState: document.getElementById('monitorState'),
  lastSyncValue: document.getElementById('lastSyncValue'),
  lastMethodValue: document.getElementById('lastMethodValue'),
  profileValue: document.getElementById('profileValue'),
  filenamePreview: document.getElementById('filenamePreview'),
  orderList: document.getElementById('orderList'),
  messageBox: document.getElementById('messageBox'),
  btnSyncNow: document.getElementById('btnSyncNow'),
  btnHiddenSync: document.getElementById('btnHiddenSync'),
  btnExportExcel: document.getElementById('btnExportExcel'),
  btnExportCSV: document.getElementById('btnExportCSV'),
  btnMonitorToggle: document.getElementById('btnMonitorToggle'),
  btnOpenSeller: document.getElementById('btnOpenSeller'),
  btnSettings: document.getElementById('btnSettings'),
  btnClear: document.getElementById('btnClear'),
  settingsLink: document.getElementById('settingsLink')
};

let lastSnapshot = {
  status: null,
  monitor: null,
  settings: DEFAULT_SETTINGS,
  lastSyncMeta: null
};

refreshStatus();
const refreshInterval = setInterval(refreshStatus, 4000);
window.addEventListener('unload', () => clearInterval(refreshInterval));

elements.btnSyncNow.addEventListener('click', async () => {
  setMessage('info', 'Running pull sync...');
  elements.btnSyncNow.disabled = true;
  const response = await sendMessage({ type: 'RUN_SCHEDULED_SYNC' });
  if (!response || !response.ok) {
    setMessage('error', `Sync failed: ${response?.error || 'unknown error'}`);
  } else {
    setMessage('success', 'Sync completed. Refreshing status...');
  }
  await refreshStatus();
});

elements.btnHiddenSync.addEventListener('click', async () => {
  setMessage('info', 'Opening hidden income pages to fetch invoice detail...');
  elements.btnHiddenSync.disabled = true;
  const response = await sendMessage({ type: 'RUN_HIDDEN_INCOME_SYNC' });
  if (!response || !response.ok) {
    setMessage('error', `Warm income pages failed: ${response?.error || 'unknown error'}`);
  } else {
    setMessage('success', 'Hidden income sync finished.');
  }
  await refreshStatus();
});

elements.btnExportCSV.addEventListener('click', async () => {
  await handleExport('csv');
});

elements.btnExportExcel.addEventListener('click', async () => {
  await handleExport('excel');
});

elements.btnMonitorToggle.addEventListener('click', async () => {
  const monitorEnabled = Boolean(lastSnapshot.monitor?.monitorEnabled);
  setMessage('info', monitorEnabled ? 'Stopping monitor...' : 'Starting rotating monitor...');
  elements.btnMonitorToggle.disabled = true;
  const response = await sendMessage({ type: monitorEnabled ? 'STOP_MONITOR' : 'RUN_MONITOR_NOW' });
  if (!response || !response.ok) {
    setMessage('error', `Monitor action failed: ${response?.error || 'unknown error'}`);
  } else {
    setMessage('success', monitorEnabled ? 'Monitor stopped.' : 'Monitor started.');
  }
  await refreshStatus();
});

elements.btnOpenSeller.addEventListener('click', async () => {
  await chrome.tabs.create({ url: SELLER_CENTRE_URL });
});

elements.btnSettings.addEventListener('click', openSettings);
elements.settingsLink.addEventListener('click', (event) => {
  event.preventDefault();
  openSettings();
});

elements.btnClear.addEventListener('click', async () => {
  if (!window.confirm('Clear all captured order data?')) {
    return;
  }
  setMessage('info', 'Clearing captured data...');
  const response = await sendMessage({ type: 'CLEAR_DATA' });
  if (!response || !response.ok) {
    setMessage('error', 'Failed to clear captured data.');
  } else {
    setMessage('success', 'Captured data cleared.');
  }
  await refreshStatus();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'DATA_UPDATED') {
    refreshStatus();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.lastSyncMeta || changes.extensionSettings || changes.monitorMeta) {
    refreshStatus();
  }
});

async function handleExport(kind) {
  const actionLabel = kind === 'excel' ? 'Excel export' : 'CSV export';
  setMessage('info', `${actionLabel} requested...`);

  const messageType = kind === 'excel' ? 'EXPORT_EXCEL_COLORED' : 'EXPORT_CSV';
  const response = await sendMessage({ type: messageType, requireReady: true });
  await refreshStatus();

  if (!response || !response.ok) {
    const pending = response?.pendingHydrationCount ?? '?';
    setMessage('error', `Data still incomplete. Pending invoices: ${pending}. Run sync and retry.`);
    return;
  }

  const settings = lastSnapshot.settings || DEFAULT_SETTINGS;
  const profileEmail = lastSnapshot.status?.profileEmail || lastSnapshot.lastSyncMeta?.profileEmail || '';
  if (kind === 'excel' && response.excel) {
    downloadFile(
      response.excel,
      buildFilename('excel', settings, profileEmail),
      'application/vnd.ms-excel;charset=utf-8',
      false
    );
  }
  if (kind === 'csv' && response.csv) {
    downloadFile(
      response.csv,
      buildFilename('csv', settings, profileEmail),
      'text/csv;charset=utf-8'
    );
  }

  if (settings.autoClearAfterExport) {
    await sendMessage({ type: 'CLEAR_DATA' });
    setMessage('success', `${actionLabel} downloaded. Captured data cleared by setting.`);
  } else {
    setMessage('success', `${actionLabel} downloaded.`);
  }
  await refreshStatus();
}

async function refreshStatus() {
  const [status, monitor, storage] = await Promise.all([
    sendMessage({ type: 'GET_STATUS' }),
    sendMessage({ type: 'GET_MONITOR_STATUS' }),
    storageGet(['lastSyncMeta', 'extensionSettings'])
  ]);

  const settings = normalizeSettings(storage.extensionSettings);
  const lastSyncMeta = storage.lastSyncMeta || null;
  lastSnapshot = {
    status,
    monitor,
    settings,
    lastSyncMeta
  };

  if (!status) {
    elements.captureState.className = 'chip danger';
    elements.captureState.textContent = 'Background unavailable';
    elements.monitorState.className = 'chip neutral';
    elements.monitorState.textContent = 'Monitor unknown';
    return;
  }

  elements.orderCount.textContent = String(status.orderCount || 0);
  elements.pendingCount.textContent = String(status.pendingHydrationCount || 0);
  elements.buildTag.textContent = `${chrome.runtime.getManifest().version} / ${status.buildTag || 'build'}`;
  elements.profileValue.textContent = status.profileEmail || lastSyncMeta?.profileEmail || '-';
  elements.lastSyncValue.textContent = formatTimestamp(lastSyncMeta?.ts);
  elements.lastMethodValue.textContent = formatLastMethod(lastSyncMeta);
  elements.filenamePreview.textContent = buildFilename('excel', settings, status.profileEmail || lastSyncMeta?.profileEmail || '');

  renderCaptureState(status);
  renderMonitorState(monitor);
  renderOrderList(status.orders || {});

  const disableExport = status.syncInFlight || !status.readyToExport || (status.orderCount || 0) === 0;
  elements.btnExportCSV.disabled = disableExport;
  elements.btnExportExcel.disabled = disableExport;
  elements.btnSyncNow.disabled = Boolean(status.syncInFlight);
  elements.btnSyncNow.textContent = status.syncInFlight ? 'Syncing...' : 'Sync Now';
  elements.btnHiddenSync.disabled = Boolean(status.syncInFlight);

  const monitorEnabled = Boolean(monitor?.monitorEnabled);
  elements.btnMonitorToggle.disabled = false;
  elements.btnMonitorToggle.textContent = monitorEnabled ? 'Stop Monitor' : 'Start Monitor';
}

function renderCaptureState(status) {
  const pending = status.pendingHydrationCount || 0;
  if (status.syncInFlight) {
    setChip(elements.captureState, 'warning', 'Sync in progress');
    return;
  }
  if ((status.orderCount || 0) === 0) {
    setChip(elements.captureState, 'neutral', 'No captured orders');
    return;
  }
  if (status.readyToExport) {
    setChip(elements.captureState, 'success', 'Ready to export');
    return;
  }
  setChip(elements.captureState, 'warning', `Waiting on ${pending} invoice${pending === 1 ? '' : 's'}`);
}

function renderMonitorState(monitor) {
  if (!monitor) {
    setChip(elements.monitorState, 'neutral', 'Monitor unknown');
    return;
  }
  const meta = monitor.monitorMeta || {};
  if (!monitor.monitorEnabled) {
    setChip(elements.monitorState, 'neutral', 'Monitor off');
    return;
  }
  if (meta.status === 'idle_no_session') {
    setChip(elements.monitorState, 'warning', 'Monitor waiting for login');
    return;
  }
  if (meta.status === 'running') {
    setChip(elements.monitorState, 'success', 'Monitor running');
    return;
  }
  setChip(elements.monitorState, 'neutral', 'Monitor armed');
}

function renderOrderList(orders) {
  const entries = Object.values(orders || {});
  if (entries.length === 0) {
    elements.orderList.innerHTML = '<div class="order-empty">No orders captured yet. Browse Seller Centre or run a sync.</div>';
    return;
  }

  const recent = entries
    .slice()
    .sort((left, right) => getOrderTimestamp(right) - getOrderTimestamp(left))
    .slice(0, 12);

  elements.orderList.innerHTML = recent.map((order) => {
    const displayId = escapeHtml(order.order_sn || order.order_id || order.income_invoice_id || '-');
    const qty = Number(order.total_quantity || 0);
    const income = Number(order.net_income || order.order_income || 0);
    const payment = escapeHtml(order.payment_method || '');
    const date = escapeHtml(formatShortDate(order.create_time || order.released_time || ''));
    const itemCountText = qty > 0 ? `${qty} item${qty === 1 ? '' : 's'}` : 'qty pending';
    return `<div class="order-item">
      <div class="order-top">
        <div class="order-id">${displayId}</div>
        <div class="order-income">${income ? `Rp ${income.toLocaleString('id-ID')}` : ''}</div>
      </div>
      <div class="order-meta">${escapeHtml(itemCountText)}${payment ? ` | ${payment}` : ''}${date ? ` | ${date}` : ''}</div>
    </div>`;
  }).join('');
}

function setChip(element, variant, text) {
  element.className = `chip ${variant}`;
  element.textContent = text;
}

function setMessage(type, text) {
  elements.messageBox.className = `message visible ${type}`;
  elements.messageBox.textContent = text;
}

function formatLastMethod(lastSyncMeta) {
  if (!lastSyncMeta || !lastSyncMeta.method) return '-';
  const method = lastSyncMeta.method === 'pull'
    ? 'Pull sync'
    : lastSyncMeta.method === 'hidden'
      ? 'Hidden income sync'
      : String(lastSyncMeta.method);
  if (lastSyncMeta.reason) {
    return `${method} (${lastSyncMeta.reason})`;
  }
  if (typeof lastSyncMeta.hydratedOrderComponents === 'number') {
    return `${method} (${lastSyncMeta.hydratedOrderComponents} hydrated)`;
  }
  if (typeof lastSyncMeta.fetchedDetails === 'number') {
    return `${method} (${lastSyncMeta.fetchedDetails} fetched)`;
  }
  return method;
}

function formatTimestamp(ts) {
  if (!ts) return 'Never';
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return 'Never';
  return date.toLocaleString('id-ID');
}

function formatShortDate(value) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString('id-ID');
}

function getOrderTimestamp(order) {
  const candidates = [
    order?.create_time,
    order?.released_time,
    order?.income_released_time,
    order?.income_estimated_escrow_time
  ];
  for (const candidate of candidates) {
    const ts = normalizeTimestamp(candidate);
    if (ts > 0) return ts;
  }
  return 0;
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string' || !value.trim()) return 0;
  if (/^\d+$/.test(value.trim())) {
    const asNum = Number(value.trim());
    return asNum > 1e12 ? asNum : asNum * 1000;
  }
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildFilename(kind, settings, profileEmail) {
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
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

function openSettings() {
  chrome.runtime.openOptionsPage();
}
