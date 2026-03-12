const btnExportCSV = document.getElementById('btnExportCSV');
const btnExportExcel = document.getElementById('btnExportExcel');
const btnSyncNow = document.getElementById('btnSyncNow');
const btnClear = document.getElementById('btnClear');
const orderCountEl = document.getElementById('orderCount');
const orderListEl = document.getElementById('orderList');

refreshStatus();

btnSyncNow.addEventListener('click', () => {
  btnSyncNow.disabled = true;
  const originalText = btnSyncNow.textContent;
  btnSyncNow.textContent = 'Syncing...';

  chrome.runtime.sendMessage({ type: 'RUN_SCHEDULED_SYNC' }, (syncResponse) => {
    btnSyncNow.textContent = originalText;
    refreshStatus();

    if (!syncResponse || !syncResponse.ok) {
      alert(`Sync failed: ${syncResponse?.error || 'unknown error'}`);
    }
  });
});

btnExportCSV.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT_CSV', requireReady: true }, (response) => {
    refreshStatus();

    if (response && response.ok && response.csv) {
      downloadFile(response.csv, `shopee-export-${new Date().toISOString().slice(0,10)}.csv`, 'text/csv;charset=utf-8');
      return;
    }

    const pending = response?.pendingHydrationCount ?? '?';
    alert(`Data still incomplete. Pending invoices: ${pending}. Click "Sync Now" and retry.`);
  });
});

btnExportExcel.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'EXPORT_EXCEL_COLORED', requireReady: true }, (response) => {
    refreshStatus();

    if (response && response.ok && response.excel) {
      downloadFile(
        response.excel,
        `shopee-export-${new Date().toISOString().slice(0, 10)}-colored.xls`,
        'application/vnd.ms-excel;charset=utf-8',
        false
      );
      return;
    }

    const pending = response?.pendingHydrationCount ?? '?';
    alert(`Data still incomplete. Pending invoices: ${pending}. Click "Sync Now" and retry.`);
  });
});

btnClear.addEventListener('click', () => {
  if (confirm('Clear all captured order data?')) {
    chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, () => {
      refreshStatus();
    });
  }
});

// Listen for live updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DATA_UPDATED') {
    refreshStatus();
  }
});

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (!response) return;

    const { orderCount, orders, readyToExport, syncInFlight, pendingHydrationCount } = response;
    orderCountEl.textContent = orderCount;
    btnSyncNow.disabled = syncInFlight;
    btnSyncNow.textContent = syncInFlight ? 'Syncing...' : 'Sync Now';
    const disableExport = orderCount === 0 || !readyToExport || syncInFlight;
    btnExportCSV.disabled = disableExport;
    btnExportExcel.disabled = disableExport;
    btnExportCSV.textContent = !readyToExport && orderCount > 0
      ? `Export CSV (waiting: ${pendingHydrationCount || 0})`
      : 'Export CSV';
    btnExportExcel.textContent = !readyToExport && orderCount > 0
      ? `Export Excel (waiting: ${pendingHydrationCount || 0})`
      : 'Export Excel (Colored)';
    renderOrderList(orders || {});
  });
}

function renderOrderList(orders) {
  const entries = Object.values(orders);
  if (entries.length === 0) {
    orderListEl.innerHTML = '<div style="color:#999;text-align:center;padding:12px;">No orders captured yet. Browse Shopee Seller Centre to start.</div>';
    return;
  }

  const recent = entries.slice(-20).reverse();
  orderListEl.innerHTML = recent.map(o => {
    const qty = o.total_quantity ? `${o.total_quantity} items` : '';
    const income = o.net_income ? `Rp ${Number(o.net_income).toLocaleString('id-ID')}` : '';
    const info = [qty, income].filter(Boolean).join(' | ');
    return `<div class="order-item">
      <span class="oid">${escapeHtml(o.order_id || '?')}</span>
      <span class="oinfo">${escapeHtml(info)}</span>
    </div>`;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
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
