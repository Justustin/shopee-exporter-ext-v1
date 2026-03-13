// Background service worker: always-on capture with persistent storage.

const INCOME_LIST_URL = 'https://seller.shopee.co.id/portal/finance/income?type=2&dateRange=THIS_WEEK';
const MONITOR_ALARM_INTERVAL_MINUTES = 2;
const MONITOR_URLS = [
  'https://seller.shopee.co.id/portal/sale/order',
  INCOME_LIST_URL
];
const HIDDEN_INVOICE_VISIT_LIMIT = 12;
const HIDDEN_PAGE_SETTLE_MS = 2500;
const SELLER_CDS_VER = '2';
const BUILD_TAG = '2026-03-13-a';
const INVOICE_LIST_URL_FILTER = '*://seller.shopee.co.id/api/v4/invoice/seller/get_invoice_list*';
const INCOME_REPORT_LIST_URL = 'https://seller.shopee.co.id/api/v4/accounting/pc/seller_income/income_report/get_income_report_list';
const ACCOUNTING_INCOME_DETAIL_URL = 'https://seller.shopee.co.id/api/v4/accounting/pc/seller_income/income_overview/get_income_detail';
const ORDER_INCOME_COMPONENTS_URL = 'https://seller.shopee.co.id/api/v4/accounting/pc/seller_income/income_detail/get_order_income_components';
const ORDER_COMPONENTS_FETCH_LIMIT = 80;
const FORWARDED_INVOICE_HEADERS = [
  'sc-fe-session',
  'sc-fe-ver',
  'referer',
  'origin',
  'accept-language',
  'x-requested-with'
];
const INCOME_DETAIL_ENDPOINTS = [
  ACCOUNTING_INCOME_DETAIL_URL,
  'https://seller.shopee.co.id/api/v4/finance/income_transaction_detail',
  'https://seller.shopee.co.id/api/v4/finance/get_income_detail',
  'https://seller.shopee.co.id/api/v4/invoice/seller/get_invoice_detail',
  'https://seller.shopee.co.id/api/v3/finance/income_transaction_detail',
  'https://seller.shopee.co.id/api/v3/finance/get_income_detail',
  'https://seller.shopee.co.id/api/v2/finance/get_income_detail'
];
const INCOME_DETAIL_BODY_BUILDERS = [
  (id) => ({ income_id: id }),
  (id) => ({ transaction_id: id }),
  (id) => ({ invoice_id: id }),
  (id) => ({ id })
];
const SYNC_LOOKBACK_DAYS = 30;
const SYNC_ENDPOINT_GROUPS = [
  {
    name: 'income_overviews',
    candidates: [
      'https://seller.shopee.co.id/api/v4/accounting/pc/seller_income/income_overview/get_income_overviews'
    ],
    buildInit() {
      return {
        method: 'GET'
      };
    }
  },
  {
    name: 'income_report_list',
    candidates: [INCOME_REPORT_LIST_URL],
    buildInit() {
      return {
        method: 'GET'
      };
    }
  },
  {
    name: 'income_detail_list',
    candidates: [ACCOUNTING_INCOME_DETAIL_URL],
    buildInit() {
      const hasTemplateBody = Boolean(
        requestTemplates.income_detail_list_body &&
        typeof requestTemplates.income_detail_list_body === 'object' &&
        Object.keys(requestTemplates.income_detail_list_body).length > 0
      );
      const source = String(requestTemplates.income_detail_list_source || '');
      const method = String(requestTemplates.income_detail_list_method || 'POST').toUpperCase();
      const useGet = method === 'GET' && !hasTemplateBody && source !== 'empty';
      if (useGet) {
        return { method: 'GET' };
      }
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(buildIncomeDetailPayload())
      };
    }
  },
  {
    name: 'invoice_list',
    candidates: [
      'https://seller.shopee.co.id/api/v4/invoice/seller/get_invoice_list'
    ],
    buildInit() {
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(buildInvoiceListPayload())
      };
    }
  }
];

let warmupTabId = null;
let monitorTabId = null;
let monitorUrlIndex = 0;
let monitorEnabled = false;
let monitorTickInFlight = false;
const disabledSyncGroups = new Set();
const syncGroup404Streaks = new Map();
let syncInFlight = false;
let syncPromise = null;
let profileInfo = { email: '', id: '' };
let requestTemplates = {};
let webRequestCaptureInitialized = false;
let observedApiEndpoints = {};

chrome.identity.getProfileUserInfo((info) => {
  if (info) {
    profileInfo = info;
  }
});

// In-memory cache (restored from storage on wake)
let capturedOrders = {};

initializeNetworkTemplateCapture();
console.log(`[Shopee Exporter] build=${BUILD_TAG} groups=${SYNC_ENDPOINT_GROUPS.map((group) => group.name).join('|')}`);
chrome.alarms.clear('shopeePullSync');

chrome.storage.local.get('monitorEnabled', (result) => {
  monitorEnabled = false;
  syncMonitorAlarm();
  if (result.monitorEnabled) {
    chrome.storage.local.set({ monitorEnabled: false });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'shopeeMonitorTick' && monitorEnabled) {
    runMonitorTick('alarm');
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === warmupTabId) {
    warmupTabId = null;
  }
  if (tabId === monitorTabId) {
    monitorTabId = null;
  }
});

// Restore from storage on service worker start
chrome.storage.local.get(['capturedOrders', 'requestTemplates'], (result) => {
  if (result.capturedOrders) {
    capturedOrders = result.capturedOrders;
    console.log(`[Shopee Exporter] Restored ${Object.keys(capturedOrders).length} orders from storage`);
  }
  if (result.requestTemplates && typeof result.requestTemplates === 'object') {
    requestTemplates = result.requestTemplates;
  }
});

// Debounced save to storage
let saveTimeout = null;
function saveToStorage() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    chrome.storage.local.set({ capturedOrders, requestTemplates });
  }, 1000);
}

async function clearCapturedData() {
  await waitForCurrentSync();
  capturedOrders = {};
  await chrome.storage.local.remove('capturedOrders');
  updateBadge();
  notifyPopup();
}

function initializeNetworkTemplateCapture() {
  if (!chrome.webRequest || !chrome.webRequest.onBeforeRequest) {
    console.warn('[Shopee Exporter] webRequest API unavailable for template capture');
    return;
  }
  if (webRequestCaptureInitialized) return;
  if (chrome.webRequest.onBeforeRequest.hasListener(captureInvoiceListRequestBody)) {
    webRequestCaptureInitialized = true;
    return;
  }

  chrome.webRequest.onBeforeRequest.addListener(
    captureInvoiceListRequestBody,
    { urls: [INVOICE_LIST_URL_FILTER], types: ['xmlhttprequest'] },
    ['requestBody']
  );

  if (chrome.webRequest.onBeforeSendHeaders && !chrome.webRequest.onBeforeSendHeaders.hasListener(captureInvoiceListRequestHeaders)) {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      captureInvoiceListRequestHeaders,
      { urls: [INVOICE_LIST_URL_FILTER], types: ['xmlhttprequest'] },
      ['requestHeaders']
    );
  }

  console.log('[Shopee Exporter] webRequest capture enabled for invoice list payloads');
  webRequestCaptureInitialized = true;
}

function captureInvoiceListRequestBody(details) {
  if (!details) return;
  // Ignore extension-originated background fetches; only learn from real Seller Centre tab traffic.
  if (typeof details.tabId === 'number' && details.tabId < 0) return;
  if (typeof details.initiator === 'string' && details.initiator.startsWith('chrome-extension://')) return;
  if (typeof details.documentUrl === 'string' && details.documentUrl.startsWith('chrome-extension://')) return;
  if (!details || details.method !== 'POST') return;
  const parsed = parseRequestBodyFromWebRequest(details.requestBody);
  if (!parsed || Object.keys(parsed).length === 0) return;
  if (!isLikelyInvoiceListPayload(parsed)) return;

  const serialized = JSON.stringify(parsed);
  const previous = requestTemplates.invoice_list_body
    ? JSON.stringify(requestTemplates.invoice_list_body)
    : '';
  if (serialized === previous) return;

  requestTemplates.invoice_list_body = parsed;
  requestTemplates.invoice_list_source = 'webRequest';
  requestTemplates.invoice_list_captured_at = Date.now();
  console.log(`[Shopee Exporter] Captured invoice list request template (webRequest) keys=${Object.keys(parsed).join('|')}`);
  saveToStorage();
}

function captureInvoiceListRequestHeaders(details) {
  if (!details) return;
  if (typeof details.tabId === 'number' && details.tabId < 0) return;
  if (typeof details.initiator === 'string' && details.initiator.startsWith('chrome-extension://')) return;
  if (typeof details.documentUrl === 'string' && details.documentUrl.startsWith('chrome-extension://')) return;
  if (!Array.isArray(details.requestHeaders) || details.requestHeaders.length === 0) return;

  const normalized = {};
  for (const header of details.requestHeaders) {
    if (!header || !header.name) continue;
    const name = String(header.name).toLowerCase();
    if (!FORWARDED_INVOICE_HEADERS.includes(name)) continue;
    normalized[name] = header.value || '';
  }

  if (Object.keys(normalized).length === 0) return;

  const serialized = JSON.stringify(normalized);
  const previous = requestTemplates.invoice_list_headers
    ? JSON.stringify(requestTemplates.invoice_list_headers)
    : '';
  if (serialized === previous) return;

  requestTemplates.invoice_list_headers = normalized;
  requestTemplates.invoice_headers_captured_at = Date.now();
  console.log(`[Shopee Exporter] Captured invoice list request headers (${Object.keys(normalized).join('|')})`);
  saveToStorage();
}

function parseRequestBodyFromWebRequest(requestBody) {
  if (!requestBody) return null;

  if (requestBody.formData && typeof requestBody.formData === 'object') {
    const payload = {};
    for (const [key, values] of Object.entries(requestBody.formData)) {
      if (!Array.isArray(values) || values.length === 0) continue;
      payload[key] = values.length === 1 ? values[0] : values;
    }
    if (Object.keys(payload).length > 0) {
      return payload;
    }
  }

  if (Array.isArray(requestBody.raw)) {
    for (const part of requestBody.raw) {
      if (!part || !part.bytes) continue;
      try {
        const text = new TextDecoder('utf-8').decode(part.bytes).trim();
        if (!text) continue;
        const asJson = parseJsonSafe(text);
        if (asJson && typeof asJson === 'object' && Object.keys(asJson).length > 0) {
          return asJson;
        }
        if (text.includes('=')) {
          const form = Object.fromEntries(new URLSearchParams(text).entries());
          if (Object.keys(form).length > 0) {
            return form;
          }
        }
      } catch {
        // ignore non-text payload chunks
      }
    }
  }

  return null;
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isLikelyInvoiceListPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return hasAnyKeyDeep(payload, [
    'page_number',
    'pageNumber',
    'page_size',
    'pageSize',
    'time_from',
    'timeFrom',
    'start_time',
    'startTime',
    'time_to',
    'timeTo',
    'end_time',
    'endTime',
    'offset',
    'limit',
    'type',
    'status',
    'status_list',
    'statusList'
  ]);
}

function hasAnyKeyDeep(node, keys, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      return true;
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object' && hasAnyKeyDeep(value, keys, depth + 1)) {
      return true;
    }
  }
  return false;
}

// Badge: show order count on extension icon
function updateBadge() {
  const count = Object.keys(capturedOrders).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#ee4d2d' });
}

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'API_INTERCEPTED') {
    handleInterceptedData(message.data);
    sendResponse({ ok: true });
  }

  if (message.type === 'GET_STATUS') {
    const remainingInvoiceCount = getPendingHydrationCount();
    for (const order of Object.values(capturedOrders)) {
      applyOrderGuards(order);
    }
    sendResponse({
      orderCount: Object.keys(capturedOrders).length,
      orders: capturedOrders,
      syncInFlight,
      pendingHydrationCount: remainingInvoiceCount,
      remainingInvoiceCount,
      readyToExport: canExportCsvNow(),
      buildTag: BUILD_TAG,
      profileEmail: profileInfo.email || ''
    });
  }

  if (message.type === 'CLEAR_DATA') {
    (async () => {
      await clearCapturedData();
      sendResponse({ ok: true });
    })();
  }

  if (message.type === 'START_CAPTURE') {
    (async () => {
      try {
        await clearCapturedData();
        const hasSession = await hasSellerSession();
        if (!hasSession) {
          sendResponse({ ok: false, error: 'Log into Shopee Seller Centre first.' });
          return;
        }
        await refreshSellerTabBeforeSync();
        await performScheduledSync('fresh-start');
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
  }

  if (message.type === 'EXPORT_CSV') {
    if (message.requireReady && !canExportCsvNow()) {
      sendResponse({
        ok: false,
        reason: 'sync_not_ready',
        syncInFlight,
        pendingHydrationCount: getPendingHydrationCount()
      });
      return;
    }
    const csv = generateCSV();
    sendResponse({ ok: Boolean(csv), csv });
  }

  if (message.type === 'EXPORT_EXCEL_COLORED') {
    if (message.requireReady && !canExportCsvNow()) {
      sendResponse({
        ok: false,
        reason: 'sync_not_ready',
        syncInFlight,
        pendingHydrationCount: getPendingHydrationCount()
      });
      return;
    }
    const excel = generateColoredExcelXml();
    sendResponse({ ok: Boolean(excel), excel });
  }

  if (message.type === 'RUN_SCHEDULED_SYNC') {
    (async () => {
      try {
        await performScheduledSync('manual');
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
  }

  if (message.type === 'RUN_HIDDEN_INCOME_SYNC') {
    (async () => {
      try {
        await runHiddenIncomeSync();
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
  }

  if (message.type === 'RUN_MONITOR_NOW') {
    (async () => {
      try {
        monitorEnabled = true;
        await chrome.storage.local.set({ monitorEnabled: true });
        syncMonitorAlarm();
        await runMonitorTick('manual');
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
  }

  if (message.type === 'GET_MONITOR_STATUS') {
    chrome.storage.local.get('monitorMeta', (result) => {
      sendResponse({
        monitorEnabled,
        monitorTabId,
        monitorUrl: nextMonitorUrlPreview(),
        monitorMeta: result.monitorMeta || null
      });
    });
  }

  if (message.type === 'STOP_MONITOR') {
    (async () => {
      monitorEnabled = false;
      await closeMonitorTab();
      await chrome.storage.local.set({ monitorEnabled: false });
      chrome.alarms.clear('shopeeMonitorTick');
      chrome.storage.local.set({
        monitorMeta: {
          ts: Date.now(),
          status: 'stopped'
        }
      });
      sendResponse({ ok: true });
    })();
  }

  if (message.type === 'GET_ENDPOINT_SUMMARY') {
    sendResponse({ endpoints: observedApiEndpoints });
  }

  return true;
});

function handleInterceptedData(data) {
  if (!data || !data.url) return;

  const url = data.url;
  const isAccountingIncomeDetail = url.includes('/api/v4/accounting/pc/seller_income/income_overview/get_income_detail');
  const isOrderIncomeComponents = url.includes('/api/v4/accounting/pc/seller_income/income_detail/get_order_income_components');
  const isIncomeOverviewSummary = url.includes('/api/v4/accounting/pc/seller_income/income_overview/get_income_overviews');
  const isIncomeReportList = url.includes('/api/v4/accounting/pc/seller_income/income_report/get_income_report_list');
  maybeReenableSyncGroup(url);
  recordObservedEndpoint(url, data.body);
  maybeCaptureRequestTemplate(data);

  // Handle income list responses
  if (
    url.includes('income_transaction_history') ||
    isAccountingIncomeDetail ||
    url.includes('get_invoice_list')
  ) {
    processIncomeList(data.body, { fromIncomeHistory: true });
  }

  // Handle order list responses
  if (url.includes('order_list')) {
    processIncomeList(data.body);
  }

  // Handle order detail / invoice responses
  if (
    url.includes('income_transaction_detail') ||
    (url.includes('get_income_detail') && !isAccountingIncomeDetail) ||
    url.includes('get_invoice_detail')
  ) {
    processOrderDetail(data.body);
  }

  // Handle escrow detail (the full invoice breakdown)
  if (url.includes('get_order_detail') || url.includes('get_escrow_detail')) {
    processEscrowDetail(data.body);
  }
  if (isOrderIncomeComponents) {
    processOrderIncomeComponents(data.body);
  }

  // Generic: capture any finance/order API response
  if (!isIncomeReportList && !isIncomeOverviewSummary && (url.includes('/finance/') || url.includes('/order/') || url.includes('/accounting/') || url.includes('/invoice/'))) {
    processGenericResponse(url, data.body);
  }
}

function maybeReenableSyncGroup(url) {
  if (!url) return;
  const normalizedUrl = String(url).split('?')[0];

  for (const group of SYNC_ENDPOINT_GROUPS) {
    const matched = (group.candidates || []).some((candidate) => {
      const normalizedCandidate = String(candidate).split('?')[0];
      return normalizedUrl === normalizedCandidate;
    });

    if (!matched) continue;
    syncGroup404Streaks.delete(group.name);
    if (disabledSyncGroups.delete(group.name)) {
      console.log(`[Shopee Exporter] Re-enabled sync group "${group.name}" after live endpoint detection`);
    }
  }
}

function recordObservedEndpoint(url, body) {
  if (!url) return;
  const trimmedUrl = String(url).split('?')[0];
  const now = Date.now();
  const data = body && typeof body === 'object' ? body.data : undefined;
  const list = extractListFromData(data || body);
  const sampleEntity = Array.isArray(list) && list[0] && typeof list[0] === 'object'
    ? normalizeEntityRecord(list[0]) || list[0]
    : null;
  const sampleKeys = sampleEntity && typeof sampleEntity === 'object'
    ? Object.keys(sampleEntity).slice(0, 20)
    : [];
  const code = body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'code')
    ? body.code
    : null;
  const error = body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'error')
    ? body.error
    : null;

  observedApiEndpoints[trimmedUrl] = {
    ts: now,
    code,
    error,
    listCount: Array.isArray(list) ? list.length : 0,
    sampleKeys,
    shape: summarizeResponseShape(body)
  };

  const keys = Object.keys(observedApiEndpoints);
  if (keys.length > 80) {
    keys
      .sort((a, b) => (observedApiEndpoints[a].ts || 0) - (observedApiEndpoints[b].ts || 0))
      .slice(0, keys.length - 80)
      .forEach((key) => {
        delete observedApiEndpoints[key];
      });
  }
}

function maybeCaptureRequestTemplate(data) {
  if (!data || !data.url) return;
  if (!data.method) return;
  const method = String(data.method || 'GET').toUpperCase();

  if (data.url.includes('/api/v4/accounting/pc/seller_income/income_overview/get_income_detail')) {
    captureIncomeDetailRequestMeta(data.url, method);
    if (method === 'POST') {
      const rawBody = typeof data.requestBody === 'string' ? data.requestBody : '';
      if (rawBody.trim() === '') {
        requestTemplates.income_detail_list_body = {};
        requestTemplates.income_detail_list_source = 'empty';
        requestTemplates.income_detail_list_captured_at = Date.now();
        console.log('[Shopee Exporter] Captured income detail list request template (empty)');
        saveToStorage();
      } else {
        captureRequestTemplateBody({
          templateKey: 'income_detail_list_body',
          sourceKey: 'income_detail_list_source',
          capturedAtKey: 'income_detail_list_captured_at',
          logLabel: 'income detail list'
        }, rawBody);
      }
    }
    return;
  }

  if (method !== 'POST') return;
  if (typeof data.requestBody !== 'string' || data.requestBody.trim() === '') return;

  if (data.url.includes('/api/v4/accounting/pc/seller_income/income_detail/get_order_income_components')) {
    captureRequestTemplateBody({
      templateKey: 'order_income_components_body',
      sourceKey: 'order_income_components_source',
      capturedAtKey: 'order_income_components_captured_at',
      logLabel: 'order income components'
    }, data.requestBody);
    return;
  }

  if (data.url.includes('/api/v4/invoice/seller/get_invoice_list')) {
    captureRequestTemplateBody({
      templateKey: 'invoice_list_body',
      sourceKey: 'invoice_list_source',
      capturedAtKey: 'invoice_list_captured_at',
      logLabel: 'invoice list'
    }, data.requestBody);
    return;
  }

  if (data.url.includes('/api/v4/accounting/pc/seller_income/income_report/get_income_report_list')) {
    captureRequestTemplateBody({
      templateKey: 'income_report_list_body',
      sourceKey: 'income_report_list_source',
      capturedAtKey: 'income_report_list_captured_at',
      logLabel: 'income report list'
    }, data.requestBody);
  }
}

function captureIncomeDetailRequestMeta(rawUrl, method) {
  const normalizedUrl = normalizeCapturedEndpointUrl(rawUrl);
  const normalizedMethod = String(method || 'POST').toUpperCase();
  const previous = JSON.stringify({
    url: requestTemplates.income_detail_list_url || '',
    method: requestTemplates.income_detail_list_method || ''
  });

  requestTemplates.income_detail_list_url = normalizedUrl || ACCOUNTING_INCOME_DETAIL_URL;
  requestTemplates.income_detail_list_method = normalizedMethod;
  requestTemplates.income_detail_meta_captured_at = Date.now();

  const next = JSON.stringify({
    url: requestTemplates.income_detail_list_url || '',
    method: requestTemplates.income_detail_list_method || ''
  });

  if (previous !== next) {
    console.log(`[Shopee Exporter] Captured income detail request metadata (${normalizedMethod})`);
    saveToStorage();
  }
}

function normalizeCapturedEndpointUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, 'https://seller.shopee.co.id');
    url.searchParams.delete('SPC_CDS');
    url.searchParams.delete('SPC_CDS_VER');
    return url.toString();
  } catch {
    return '';
  }
}

function captureRequestTemplateBody(config, requestBody) {
  const parsed = parseCapturedRequestBody(requestBody);
  if (!parsed || Object.keys(parsed).length === 0) {
    console.warn(`[Shopee Exporter] Could not parse ${config.logLabel} request template body`);
    return;
  }

  requestTemplates[config.templateKey] = parsed.payload;
  requestTemplates[config.sourceKey] = parsed.source;
  requestTemplates[config.capturedAtKey] = Date.now();
  console.log(`[Shopee Exporter] Captured ${config.logLabel} request template (${parsed.source})`);
  saveToStorage();
}

function parseCapturedRequestBody(requestBody) {
  try {
    const parsed = JSON.parse(requestBody);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
      return { payload: parsed, source: 'json' };
    }
  } catch {
    // fall back to urlencoded parsing below
  }

  try {
    if (requestBody.includes('=')) {
      const form = new URLSearchParams(requestBody);
      const obj = Object.fromEntries(form.entries());
      if (Object.keys(obj).length > 0) {
        return { payload: obj, source: 'urlencoded' };
      }
    }
  } catch {
    // ignore invalid payload shapes
  }

  return null;
}

function normalizeEntityRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }

  const preferredNestedKeys = [
    'local_income_detail',
    'income_detail',
    'order_income_info',
    'order_info',
    'order_item_list',
    'order_detail',
    'order',
    'invoice',
    'transaction',
    'detail',
    'data'
  ];

  for (const key of preferredNestedKeys) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return { ...record, ...nested };
    }
  }

  const nestedObjects = Object.values(record).filter(
    (value) => value && typeof value === 'object' && !Array.isArray(value)
  );
  if (nestedObjects.length === 1) {
    return { ...record, ...nestedObjects[0] };
  }

  return record;
}

function expandEntityCandidates(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [];
  }

  const base = normalizeEntityRecord(record) || record;
  const candidates = [base];
  const nestedArrayKeys = [
    'local_income_detail',
    'income_detail',
    'order_detail',
    'details',
    'items',
    'transactions',
    'list'
  ];

  for (const key of nestedArrayKeys) {
    const value = record[key];
    if (!Array.isArray(value) || value.length === 0) continue;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      candidates.push({ ...base, ...entry });
    }
  }

  return candidates;
}

function walkObjectsDeep(node, visitor, depth = 0, seen = new Set()) {
  if (!node || depth > 6) return;
  if (typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (!Array.isArray(node)) {
    visitor(node);
  }

  const values = Array.isArray(node) ? node : Object.values(node);
  for (const value of values) {
    walkObjectsDeep(value, visitor, depth + 1, seen);
  }
}

function toNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeMoneyNumber(value) {
  const num = toNumberOrNull(value);
  if (num === null) return null;
  if (Math.abs(num) >= 100000 && num % 100000 === 0) {
    return num / 100000;
  }
  return num;
}

function extractNumericFromUnknown(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;

  const direct = normalizeMoneyNumber(value);
  if (direct !== null) return direct;

  if (Array.isArray(value)) {
    let picked = null;
    for (const entry of value) {
      const num = extractNumericFromUnknown(entry, depth + 1);
      if (num === null) continue;
      picked = pickBetterNumeric(picked, num);
    }
    return picked;
  }

  if (typeof value !== 'object') return null;

  const prioritizedKeys = [
    'amount',
    'value',
    'money',
    'money_amount',
    'income_amount',
    'net_income',
    'order_income',
    'final_income',
    'escrow_amount',
    'total',
    'fee',
    'price',
    'cost',
    'nominal',
    'display_amount',
    'signed_amount'
  ];

  for (const key of prioritizedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const num = extractNumericFromUnknown(value[key], depth + 1);
    if (num !== null) return num;
  }

  let picked = null;
  for (const [key, entry] of Object.entries(value)) {
    if (/(^|_)(id|sn|status|time|timestamp|count|qty|quantity|payment|carrier)(_|$)/i.test(key)) {
      continue;
    }
    if (!/(amount|income|fee|price|cost|money|total|value|nominal|saldo|balance|shipping|voucher|coin)/i.test(key)) {
      continue;
    }
    const num = extractNumericFromUnknown(entry, depth + 1);
    if (num === null) continue;
    picked = pickBetterNumeric(picked, num);
  }

  return picked;
}

function firstNumeric(...values) {
  for (const value of values) {
    const num = toNumberOrNull(value);
    if (num !== null) return num;
  }
  return null;
}

function pickBetterNumeric(existing, incoming) {
  if (incoming === null || incoming === undefined || Number.isNaN(incoming)) return existing;
  if (existing === null || existing === undefined || Number.isNaN(existing)) return incoming;
  if (existing === 0 && incoming !== 0) return incoming;
  if (Math.abs(incoming) > Math.abs(existing)) return incoming;
  return existing;
}

function dedupeItems(items, options = {}) {
  const preserveNoLineRefDuplicates = Boolean(options.preserveNoLineRefDuplicates);
  const unique = [];
  const seen = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const lineRef = String(item._line_ref || '').trim();
    if (!lineRef && preserveNoLineRefDuplicates) {
      unique.push(item);
      continue;
    }
    const key = lineRef
      ? `line:${lineRef}`
      : [
          item.name || '',
          item.sku || '',
          item.quantity || 0,
          item.unit_price || 0,
          item.subtotal || 0,
          item.refund_status || '',
          item.refund_qty || 0
        ].join('|');
    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, unique.length);
      unique.push(item);
      continue;
    }

    const existing = unique[existingIndex];
    if (!lineRef) {
      // If the backend emits repeated identical lines without stable line ids,
      // keep a single row but accumulate quantity/subtotal so totals stay correct.
      const existingQty = toNumberOrNull(existing.quantity) || 0;
      const nextQty = toNumberOrNull(item.quantity) || 0;
      const existingSubtotal = toNumberOrNull(existing.subtotal) || 0;
      const nextSubtotal = toNumberOrNull(item.subtotal) || 0;
      const existingRefundQty = toNumberOrNull(existing.refund_qty) || 0;
      const nextRefundQty = toNumberOrNull(item.refund_qty) || 0;
      const mergedQty = existingQty + nextQty;
      const mergedSubtotal = existingSubtotal + nextSubtotal;
      const mergedRefundQty = existingRefundQty + nextRefundQty;

      existing.quantity = mergedQty;
      existing.subtotal = mergedSubtotal;
      existing.refund_qty = mergedRefundQty;
      existing.refund_status = deriveRefundStatus(
        mergedQty,
        mergedRefundQty,
        Boolean(existing.refund_status || item.refund_status)
      );
      if ((!toNumberOrNull(existing.unit_price) || toNumberOrNull(existing.unit_price) === 0) && mergedQty > 0) {
        existing.unit_price = mergedSubtotal / mergedQty;
      }
      continue;
    }

    const existingSubtotal = toNumberOrNull(existing.subtotal) || 0;
    const nextSubtotal = toNumberOrNull(item.subtotal) || 0;

    if (existingSubtotal === 0 && nextSubtotal !== 0) {
      unique[existingIndex] = item;
      continue;
    }

    if (existingSubtotal !== 0 && nextSubtotal !== 0 && Math.abs(nextSubtotal) < Math.abs(existingSubtotal)) {
      unique[existingIndex] = item;
    }
  }
  return unique;
}

function deriveRefundStatus(quantity, refundQty, hasRefundFlag = false) {
  const normalizedQty = toNumberOrNull(quantity) || 0;
  const normalizedRefundQty = toNumberOrNull(refundQty) || 0;
  if (normalizedRefundQty <= 0 && !hasRefundFlag) {
    return '';
  }
  if (normalizedQty > 0 && normalizedRefundQty > 0 && normalizedRefundQty < normalizedQty) {
    return 'Partial Return/Refund';
  }
  return 'Return/Refund';
}

function parseItemObject(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const name = firstPresent(
    obj.item_name,
    obj.product_name,
    obj.name,
    obj.item_title,
    obj.product_title
  );
  const sku = firstPresent(
    obj.model_name,
    obj.variation,
    obj.product_sku,
    obj.model_sku,
    obj.sku,
    obj.variation_name
  );

  const quantity = firstNumeric(
    obj.quantity,
    obj.qty,
    obj.amount,
    obj.item_count,
    obj.count
  );

  const unitPrice = firstNumeric(
    obj.item_price,
    obj.price,
    obj.unit_price,
    obj.product_price,
    obj.original_price,
    obj.bundle_item_price
  );

  const subtotal = firstNumeric(
    obj.subtotal,
    obj.item_subtotal,
    obj.total_price,
    obj.total_amount,
    obj.amount
  );
  const lineRef = firstPresent(
    obj.line_item_id,
    obj.lineItemId
  );
  const rawRefundQty = firstNumeric(
    obj.refunded_qty,
    obj.refund_qty,
    obj.returned_qty,
    obj.return_qty,
    obj.cancelled_qty,
    obj.canceled_qty,
    obj.cancel_qty
  );

  if (!name && !sku) return null;
  if (quantity === null && unitPrice === null && subtotal === null) return null;

  let finalQty = quantity !== null ? quantity : 0;
  const normalizedUnitPrice = normalizeMoneyNumber(unitPrice);
  const normalizedSubtotal = normalizeMoneyNumber(subtotal);
  let finalUnitPrice = normalizedUnitPrice !== null ? normalizedUnitPrice : 0;
  let finalSubtotal = normalizedSubtotal !== null ? normalizedSubtotal : 0;

  if (finalQty === 0 && finalSubtotal !== null && finalUnitPrice && finalUnitPrice !== 0) {
    finalQty = finalSubtotal / finalUnitPrice;
  }
  if (finalUnitPrice === 0 && finalQty && finalSubtotal) {
    finalUnitPrice = finalSubtotal / finalQty;
  }
  if (finalSubtotal === 0 && finalQty && finalUnitPrice) {
    finalSubtotal = finalQty * finalUnitPrice;
  }

  let refundQty = rawRefundQty !== null ? rawRefundQty : 0;
  const hasRefundFlag = Boolean(
    obj.show_return_tag ||
    obj.showReturnTag ||
    obj.show_cancellation_tag ||
    obj.showCancellationTag ||
    obj.is_refunded ||
    obj.isRefunded
  );
  if (refundQty === 0 && hasRefundFlag && finalQty > 0) {
    refundQty = finalQty;
  }

  return {
    name: name || '',
    sku: sku || '',
    quantity: finalQty || 0,
    unit_price: finalUnitPrice || 0,
    subtotal: finalSubtotal || 0,
    refund_qty: refundQty || 0,
    refund_status: deriveRefundStatus(finalQty, refundQty, hasRefundFlag),
    _line_ref: lineRef !== undefined && lineRef !== null && lineRef !== '' ? String(lineRef) : ''
  };
}

function extractItemsFromOrderItemList(orderItems) {
  if (!Array.isArray(orderItems) || orderItems.length === 0) return [];

  const parsed = [];
  const sameIdentity = (left, right) => {
    if (!left || !right) return false;
    const leftName = String(left.name || '').trim().toLowerCase();
    const rightName = String(right.name || '').trim().toLowerCase();
    const leftSku = String(left.sku || '').trim().toLowerCase();
    const rightSku = String(right.sku || '').trim().toLowerCase();
    return leftName === rightName && leftSku === rightSku;
  };

  for (const item of orderItems) {
    const parent = parseItemObject(item);
    const children = [];

    if (Array.isArray(item?.bundle_items)) {
      for (const bundleItem of item.bundle_items) {
        if (!bundleItem || typeof bundleItem !== 'object') continue;

        const child = parseItemObject(bundleItem);
        if (!child) continue;
        children.push(child);
      }
    }

    if (children.length > 0) {
      const dedupedChildren = dedupeItems(children);
      const allSameAsParent = parent && dedupedChildren.every((child) => sameIdentity(child, parent));

      // Mixed bundle packet: children are the real invoice lines; drop synthetic parent wrapper row.
      if (!allSameAsParent) {
        parsed.push(...dedupedChildren);
        continue;
      }

      // Same-product packet: keep one merged row with child quantity/price and parent discounted subtotal.
      const primaryChild = dedupedChildren[0];
      const merged = {
        name: firstPresent(primaryChild.name, parent.name),
        sku: firstPresent(primaryChild.sku, parent.sku),
        quantity: firstNumeric(primaryChild.quantity, parent.quantity, 0) || 0,
        unit_price: firstNumeric(primaryChild.unit_price, parent.unit_price, 0) || 0,
        subtotal: firstNumeric(parent.subtotal, primaryChild.subtotal, 0) || 0,
        refund_qty: firstNumeric(primaryChild.refund_qty, 0) || 0,
        refund_status: firstPresent(primaryChild.refund_status, '')
      };

      if (!merged.unit_price && merged.quantity && merged.subtotal) {
        merged.unit_price = merged.subtotal / merged.quantity;
      }

      parsed.push(merged);
      continue;
    }

    if (parent) {
      parsed.push(parent);
    }
  }

  return dedupeItems(parsed, { preserveNoLineRefDuplicates: true });
}

function extractItemsFromEntity(entity) {
  const canonicalOrderItems =
    entity?.order_item_list?.order_items ||
    entity?.order_items ||
    entity?.items ||
    entity?.product_list ||
    null;

  const canonicalParsed = extractItemsFromOrderItemList(canonicalOrderItems);
  if (canonicalParsed.length > 0) {
    return canonicalParsed;
  }

  const found = [];
  walkObjectsDeep(entity, (obj) => {
    const parsed = parseItemObject(obj);
    if (parsed) {
      found.push(parsed);
    }
  });

  return dedupeItems(found);
}

function mapFeeKey(key) {
  const raw = String(key || '').toLowerCase().trim();
  if (!raw) return '';
  const compact = raw.replace(/[^a-z0-9]+/g, '_');
  const has = (...tokens) => tokens.some((token) => raw.includes(token) || compact.includes(token));

  if ((compact.includes('income_info') || compact.endsWith('_info') || compact.endsWith('_infos')) && !has('amount')) {
    return '';
  }
  if (has('buyer_service_fee', 'buyer_paid_amount')) {
    return '';
  }
  if (has('commission', 'komisi', 'admin_fee', 'administr', 'biaya_administrasi', 'fee_admin', 'admin_charge')) {
    return 'admin_fee';
  }
  if (has('service_fee', 'layanan', 'biaya_layanan', 'fee_layanan', 'service_charge')) {
    return 'service_fee';
  }
  if (has('credit_card_fee', 'transaction_fee', 'processing_fee', 'payment_fee', 'fee_transaksi', 'proses_pesanan', 'biaya_proses_pesanan', 'biaya_pembayaran')) {
    return 'transaction_fee';
  }
  if (has('buyer_paid_shipping', 'shipping_fee_paid_by_buyer', 'buyer_shipping', 'ongkir_dibayar_pembeli', 'ongkir_pembeli')) {
    return 'buyer_shipping_fee';
  }
  if (has('shopee_shipping_rebate', 'shipping_rebate_from_shopee', 'potongan_ongkos_kirim_dari_shopee', 'subsidi_ongkir_shopee', 'shipping_subsidy_shopee')) {
    return 'shopee_shipping_rebate';
  }
  if (has('shipping_fee_discount', 'shipping_rebate', 'shipping_discount', 'potongan_ongkos_kirim')) {
    return 'shipping_fee_rebate';
  }
  if (has('actual_shipping_fee', 'shipping_fee', 'ongkir', 'ongkos_kirim_yang_dibayarkan_ke_jasa_kirim', 'shipping_cost_paid_to_carrier', 'ongkos_kirim_ke_jasa_kirim')) {
    return 'shipping_fee';
  }
  if (has('voucher_from_shopee', 'voucher_shopee', 'shopee_voucher', 'subsidi_shopee')) {
    return 'voucher_from_shopee';
  }
  if (has('voucher_from_seller', 'voucher_toko', 'seller_voucher', 'voucher_toko_yang_ditanggung_penjual', 'voucher_penjual')) {
    return 'voucher_from_seller';
  }
  if (has('refund_amount', 'returned_amount', 'refund_total', 'pengembalian_dana', 'jumlah_pengembalian_dana', 'refund_to_buyer')) {
    return 'refund_amount';
  }
  if (has('merchandise_subtotal', 'product_price', 'buyer_total_amount', 'order_total', 'subtotal_pesanan', 'subtotal_order', 'total_amount', 'harga_produk', 'product_amount')) {
    return 'order_total';
  }
  if (has('escrow_amount', 'net_income', 'order_income', 'final_income', 'total_penghasilan', 'income_total', 'settlement_amount', 'payout', 'amount_after_adjustment')) {
    return 'net_income';
  }
  return '';
}

function extractFeeFieldsFromEntity(entity) {
  const result = {};
  const normalizeShippingMapping = (obj, mappedKey) => {
    if (mappedKey !== 'shipping_fee') return mappedKey;
    const label = String(firstPresent(
      obj?.display_name,
      obj?.displayName,
      obj?.label,
      obj?.name,
      obj?.title
    ) || '').toLowerCase();
    if (!label) return mappedKey;

    if (
      label.includes('dibayar pembeli') ||
      label.includes('buyer paid') ||
      label.includes('buyer_shipping') ||
      label.includes('shipping paid by buyer')
    ) {
      return 'buyer_shipping_fee';
    }
    if (
      label.includes('dibayarkan ke jasa kirim') ||
      label.includes('jasa kirim') ||
      label.includes('actual shipping')
    ) {
      return 'shipping_fee';
    }
    return mappedKey;
  };

  const isVoucherAggregateNode = (obj, mappedKey, hintText = '') => {
    if (mappedKey !== 'voucher_from_shopee' && mappedKey !== 'voucher_from_seller') {
      return false;
    }
    const hasSubBreakdown = Array.isArray(obj?.sub_breakdown) && obj.sub_breakdown.length > 0;
    if (!hasSubBreakdown) return false;
    const text = String(hintText || '').toLowerCase();
    if (!text) return true;
    return text.includes('voucher') || text.includes('subsidi');
  };

  const processObject = (obj) => {
    const fieldName = firstPresent(obj.field_name, obj.fieldName, obj.type_name, obj.typeName);
    if (typeof fieldName === 'string' && /^BUYER_/i.test(fieldName)) {
      return;
    }

    let mappedFromFieldName = mapFeeKey(fieldName);
    if (mappedFromFieldName) {
      mappedFromFieldName = normalizeShippingMapping(obj, mappedFromFieldName);
      if (isVoucherAggregateNode(obj, mappedFromFieldName, fieldName)) {
        // Parent voucher rows can represent group totals; prefer explicit sub rows.
      } else {
      const amount = extractNumericFromUnknown(
        firstPresent(
          obj.amount,
          obj.value,
          obj.money,
          obj.money_amount,
          obj.income_amount,
          obj.net_income,
          obj.order_income,
          obj.final_income,
          obj.total,
          obj.fee,
          obj.price,
          obj.cost
        )
      );
      if (amount !== null) {
        result[mappedFromFieldName] = pickBetterNumeric(result[mappedFromFieldName], amount);
      }
      }
    }

    for (const [key, rawValue] of Object.entries(obj)) {
      let mapped = mapFeeKey(key);
      if (!mapped) continue;
      mapped = normalizeShippingMapping(obj, mapped);
      if (key === 'ext_info' || key.endsWith('_info') || key.endsWith('_infos')) continue;
      if (isVoucherAggregateNode(obj, mapped, key)) continue;
      const num = extractNumericFromUnknown(rawValue);
      if (num === null) continue;
      result[mapped] = pickBetterNumeric(result[mapped], num);
    }

    // Some payloads encode fee rows as {label/name/title, amount/value}.
    const label = firstPresent(
      obj.label,
        obj.title,
        obj.name,
        obj.key_name,
        obj.display_name,
        obj.description,
        obj.fee_label,
        obj.fee_name,
        obj.income_label,
        obj.income_name,
        obj.type_name,
        obj.sub_type_name,
        obj.category_name,
        obj.category
      );
    if (!label) return;

    const mappedFromLabel = mapFeeKey(label);
    if (!mappedFromLabel) return;
    if (isVoucherAggregateNode(obj, mappedFromLabel, label)) return;

    const amount = extractNumericFromUnknown(
      firstPresent(
        obj.amount,
        obj.value,
        obj.money,
        obj.money_amount,
        obj.income_amount,
        obj.net_income,
        obj.order_income,
        obj.final_income,
        obj.total,
        obj.fee,
        obj.price,
        obj.cost
      )
    );
    if (amount === null) return;

    result[mappedFromLabel] = pickBetterNumeric(result[mappedFromLabel], amount);
  };

  const seen = new Set();
  const walk = (node, path = []) => {
    if (!node || typeof node !== 'object' || path.length > 7) return;
    if (seen.has(node)) return;
    seen.add(node);

    if (path.includes('buyer_payment_breakdown') || path.includes('ext_info')) {
      return;
    }

    if (!Array.isArray(node)) {
      processObject(node);
    }

    const entries = Array.isArray(node)
      ? node.map((value, index) => [String(index), value])
      : Object.entries(node);

    for (const [key, value] of entries) {
      if (key === 'buyer_payment_breakdown' || key === 'ext_info') {
        continue;
      }
      walk(value, path.concat(String(key)));
    }
  };

  walk(entity, []);
  return result;
}

function hasExplicitShopeeVoucherDetail(entity) {
  let found = false;
  const seen = new Set();

  const walk = (node, path = []) => {
    if (found || !node || typeof node !== 'object' || path.length > 7) return;
    if (seen.has(node)) return;
    seen.add(node);

    if (path.includes('buyer_payment_breakdown') || path.includes('ext_info')) {
      return;
    }

    if (!Array.isArray(node)) {
      const label = firstPresent(
        node.field_name,
        node.fieldName,
        node.display_name,
        node.displayName,
        node.name,
        node.label,
        node.title
      );

      if (label) {
        const text = String(label).toLowerCase();
        const looksShopeeVoucher =
          text.includes('voucher shopee') ||
          text.includes('shopee_voucher') ||
          text.includes('voucher_from_shopee') ||
          text.includes('subsidi shopee');
        const looksSellerVoucher =
          text.includes('voucher toko') ||
          text.includes('seller voucher') ||
          text.includes('voucher penjual') ||
          text.includes('ditanggung penjual') ||
          text.includes('seller_voucher') ||
          text.includes('voucher_from_seller');
        const isParent = Array.isArray(node.sub_breakdown) && node.sub_breakdown.length > 0;

        if (looksShopeeVoucher && !looksSellerVoucher && !isParent) {
          const amount = extractNumericFromUnknown(
            firstPresent(
              node.amount,
              node.value,
              node.money,
              node.money_amount,
              node.total,
              node.fee
            )
          );
          if (amount !== null) {
            found = true;
            return;
          }
        }
      }
    }

    const entries = Array.isArray(node)
      ? node.map((value, index) => [String(index), value])
      : Object.entries(node);

    for (const [key, value] of entries) {
      if (key === 'buyer_payment_breakdown' || key === 'ext_info') {
        continue;
      }
      walk(value, path.concat(String(key)));
      if (found) return;
    }
  };

  walk(entity, []);
  return found;
}

function applyVoucherGuard(order) {
  if (!order || typeof order !== 'object') return;
  if (order._has_explicit_shopee_voucher) return;

  // If we already parsed order_income_components and found no explicit Shopee voucher row,
  // always force Shopee voucher to zero to match invoice UI.
  if (order._components_voucher_checked) {
    if ((toNumberOrNull(order.voucher_from_shopee) || 0) !== 0) {
      order.voucher_from_shopee = 0;
    }
    return;
  }

  const sellerVoucher = toNumberOrNull(order.voucher_from_seller) || 0;
  const shopeeVoucher = toNumberOrNull(order.voucher_from_shopee) || 0;

  // If seller voucher exists but Shopee voucher is not explicitly present in detail payload,
  // treat Shopee voucher as zero to match invoice UI.
  if (sellerVoucher !== 0 && shopeeVoucher !== 0) {
    order.voucher_from_shopee = 0;
  }
}

function applyComponentsBreakdownGuard(order) {
  if (!order || typeof order !== 'object') return;
  if (!order._components_breakdown_checked) return;
  const breakdown = order._components_breakdown;
  if (!breakdown || typeof breakdown !== 'object') return;

  const fields = [
    'shipping_fee',
    'buyer_shipping_fee',
    'shopee_shipping_rebate',
    'voucher_from_shopee',
    'voucher_from_seller'
  ];

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(breakdown, field)) continue;
    const numeric = toNumberOrNull(breakdown[field]);
    order[field] = numeric === null ? breakdown[field] : numeric;
  }
}

function applyOrderGuards(order) {
  applyComponentsBreakdownGuard(order);
  applyVoucherGuard(order);
}

function extractCoinsFromSellerIncomeBreakdown(entity) {
  const breakdown = entity?.seller_income_breakdown?.breakdown;
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    return undefined;
  }

  let found;
  const walkEntries = (entries) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const label = String(firstPresent(
        entry.field_name,
        entry.fieldName,
        entry.display_name,
        entry.displayName,
        entry.name,
        entry.label,
        entry.title
      ) || '').toLowerCase();
      const hasChildren = Array.isArray(entry.sub_breakdown) && entry.sub_breakdown.length > 0;
      const looksLikeCoins =
        label.includes('coin_amount') ||
        label.includes('coins') ||
        label.includes('shopee coin') ||
        label.includes('shopee coins') ||
        label.includes('koin shopee') ||
        label.includes('koin');

      if (looksLikeCoins && !hasChildren) {
        const amount = extractNumericFromUnknown(
          firstPresent(
            entry.amount,
            entry.value,
            entry.money,
            entry.money_amount,
            entry.total,
            entry.fee
          )
        );
        if (amount !== null) {
          found = amount;
        }
      }

      if (hasChildren) {
        walkEntries(entry.sub_breakdown);
      }
    }
  };

  walkEntries(breakdown);
  return found;
}

function pickPaymentMethod(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    if (/^\d+$/.test(text)) continue;
    return text;
  }
  return '';
}

function extractVoucherFieldsFromSellerIncomeBreakdown(entity) {
  const breakdown = entity?.seller_income_breakdown?.breakdown;
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    return {};
  }

  const result = {};
  const walkEntries = (entries) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const label = String(firstPresent(
        entry.field_name,
        entry.fieldName,
        entry.display_name,
        entry.displayName,
        entry.name,
        entry.label,
        entry.title
      ) || '').toLowerCase();

      const hasChildren = Array.isArray(entry.sub_breakdown) && entry.sub_breakdown.length > 0;
      const amount = extractNumericFromUnknown(
        firstPresent(
          entry.amount,
          entry.value,
          entry.money,
          entry.money_amount,
          entry.total,
          entry.fee
        )
      );

      const isSellerVoucher =
        label.includes('voucher toko') ||
        label.includes('seller voucher') ||
        label.includes('voucher penjual') ||
        label.includes('ditanggung penjual') ||
        label.includes('seller_voucher') ||
        label.includes('voucher_from_seller');
      const isShopeeVoucher =
        label.includes('voucher shopee') ||
        label.includes('shopee_voucher') ||
        label.includes('voucher_from_shopee') ||
        label.includes('subsidi shopee');

      if (amount !== null) {
        if (isSellerVoucher) {
          result.voucher_from_seller = amount;
        } else if (isShopeeVoucher && !hasChildren) {
          // Ignore parent aggregate rows like "Voucher & Subsidi Shopee"; use detail rows only.
          result.voucher_from_shopee = amount;
        }
      }

      if (hasChildren) {
        walkEntries(entry.sub_breakdown);
      }
    }
  };

  walkEntries(breakdown);
  return result;
}

function extractShippingFieldsFromSellerIncomeBreakdown(entity) {
  const breakdown = entity?.seller_income_breakdown?.breakdown;
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    return {};
  }

  const result = {};
  const walkEntries = (entries) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const label = String(firstPresent(
        entry.field_name,
        entry.fieldName,
        entry.display_name,
        entry.displayName,
        entry.name,
        entry.label,
        entry.title
      ) || '').toLowerCase();

      const hasChildren = Array.isArray(entry.sub_breakdown) && entry.sub_breakdown.length > 0;
      const amount = extractNumericFromUnknown(
        firstPresent(
          entry.amount,
          entry.value,
          entry.money,
          entry.money_amount,
          entry.total,
          entry.fee
        )
      );

      if (amount !== null) {
        if (
          label.includes('shipping_fee_paid_by_buyer') ||
          label.includes('buyer_paid_shipping') ||
          label.includes('ongkir dibayar pembeli') ||
          label.includes('ongkir_dibayar_pembeli')
        ) {
          result.buyer_shipping_fee = amount;
        } else if (
          label.includes('actual_shipping_fee') ||
          label.includes('shipping_cost_paid_to_carrier') ||
          label.includes('ongkos kirim yang dibayarkan ke jasa kirim') ||
          label.includes('ongkos_kirim_yang_dibayarkan_ke_jasa_kirim')
        ) {
          result.shipping_fee = amount;
        } else if (
          label.includes('shipping_rebate_from_shopee') ||
          label.includes('shopee_shipping_rebate') ||
          label.includes('potongan ongkos kirim dari shopee') ||
          label.includes('potongan_ongkos_kirim_dari_shopee')
        ) {
          result.shopee_shipping_rebate = amount;
        }
      }

      if (hasChildren) {
        walkEntries(entry.sub_breakdown);
      }
    }
  };

  walkEntries(breakdown);
  return result;
}

function enrichOrderFromEntity(target, entity) {
  if (!target || !entity || typeof entity !== 'object') return;

  const feeFields = extractFeeFieldsFromEntity(entity);
  const explicitShopeeVoucher = hasExplicitShopeeVoucherDetail(entity);
  const targetSellerVoucher = toNumberOrNull(target.voucher_from_seller) || 0;
  const incomingSellerVoucher = toNumberOrNull(feeFields.voucher_from_seller) || 0;
  if (!explicitShopeeVoucher && feeFields.voucher_from_shopee !== undefined) {
    if (incomingSellerVoucher !== 0 || targetSellerVoucher !== 0) {
      delete feeFields.voucher_from_shopee;
      if ((toNumberOrNull(target.voucher_from_shopee) || 0) !== 0) {
        target.voucher_from_shopee = 0;
      }
    }
  }

  if (Object.keys(feeFields).length > 0) {
    mergeOrderFields(target, feeFields);
    if (!target.total_amount && feeFields.order_total !== undefined) {
      target.total_amount = feeFields.order_total;
    }
    if (!target.net_income && feeFields.net_income !== undefined) {
      target.net_income = feeFields.net_income;
    }
    if (!target.order_income && feeFields.net_income !== undefined) {
      target.order_income = feeFields.net_income;
    }
  }

  const items = extractItemsFromEntity(entity);
  if (items.length > 0) {
    if (!Array.isArray(target.items) || items.length >= target.items.length) {
      target.items = items;
      target.total_quantity = items.reduce((sum, item) => sum + (toNumberOrNull(item.quantity) || 0), 0);
    }
  }

  applyOrderGuards(target);
}

function normalizeEntityIdValue(value, options = {}) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (!text) return '';

  const minLength = typeof options.minLength === 'number' ? options.minLength : 6;
  const maxLength = typeof options.maxLength === 'number' ? options.maxLength : 40;
  const pattern = options.allowAlpha
    ? /^[A-Za-z0-9_-]+$/
    : /^\d+$/;

  if (text.length < minLength || text.length > maxLength) return '';
  if (!pattern.test(text)) return '';
  if (!/\d/.test(text)) return '';
  return text;
}

function hashString32(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildSyntheticEntityId(candidate, parentOrderId, parentIncomeId) {
  const parts = [];
  const pOrder = normalizeEntityIdValue(parentOrderId, { allowAlpha: true, minLength: 1 });
  const pIncome = normalizeEntityIdValue(parentIncomeId, { allowAlpha: true, minLength: 1 });
  if (pOrder) parts.push(`po:${pOrder}`);
  if (pIncome) parts.push(`pi:${pIncome}`);

  if (candidate && typeof candidate === 'object') {
    const source = normalizeEntityRecord(candidate) || candidate;
    const preferredKeys = [
      'order_sn',
      'order_id',
      'invoice_id',
      'income_id',
      'transaction_id',
      'create_time',
      'ctime',
      'request_time',
      'amount',
      'income_amount',
      'net_income',
      'buyer_name',
      'buyer_username',
      'status',
      'sub_type'
    ];
    for (const key of preferredKeys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if (value === null || value === undefined || value === '') continue;
      parts.push(`${key}:${String(value).slice(0, 80)}`);
    }

    if (parts.length === 0) {
      parts.push(JSON.stringify(source).slice(0, 800));
    }
  } else {
    parts.push(String(candidate || ''));
  }

  const seed = parts.join('|');
  if (!seed) return '';
  return `inc_${hashString32(seed)}`;
}

function resolveEntityKey(candidate, parentOrderId, parentIncomeId) {
  const direct = (
    pickOrderId(candidate) ||
    normalizeEntityIdValue(parentOrderId, { allowAlpha: true, minLength: 1 })
  );
  if (direct) return direct;
  return buildSyntheticEntityId(candidate, parentOrderId, parentIncomeId);
}

function processIncomeList(body, options = {}) {
  if (!body || typeof body !== 'object') return;
  const data = normalizeEntityRecord(body.data && typeof body.data === 'object' ? body.data : body);
  const list = extractListFromData(data);
  const includeParentContext = list.length <= 1;
  const parentOrderId = pickOrderId(data);
  const parentIncomeId = pickIncomeInvoiceId(data, true);

  if (list.length === 0 && parentOrderId) {
    if (!capturedOrders[parentOrderId]) {
      capturedOrders[parentOrderId] = { order_id: parentOrderId };
    }
    mergeOrderFields(capturedOrders[parentOrderId], flattenOrder(data));
    enrichOrderFromEntity(capturedOrders[parentOrderId], data);
    const incomeInvoiceId = pickIncomeInvoiceId(data, true);
    if (incomeInvoiceId) {
      capturedOrders[parentOrderId].income_invoice_id = incomeInvoiceId;
    }
    saveToStorage();
    updateBadge();
    notifyPopup();
    return;
  }

  for (const item of list) {
    const candidates = expandEntityCandidates(item);
    if (candidates.length === 0) {
      const orderId = resolveEntityKey(item, parentOrderId, parentIncomeId);
      if (!orderId) continue;
      if (!capturedOrders[orderId]) {
        capturedOrders[orderId] = { order_id: orderId };
      }
      if (!capturedOrders[orderId].order_id) {
        capturedOrders[orderId].order_id = orderId;
      }
      if (includeParentContext) {
        mergeOrderFields(capturedOrders[orderId], flattenOrder(data));
        enrichOrderFromEntity(capturedOrders[orderId], data);
      }
      mergeOrderFields(capturedOrders[orderId], flattenOrder(item));
      enrichOrderFromEntity(capturedOrders[orderId], item);
      if (options.fromIncomeHistory) {
        const incomeInvoiceId = pickIncomeInvoiceId(item, true) || parentIncomeId;
        if (incomeInvoiceId) {
          capturedOrders[orderId].income_invoice_id = incomeInvoiceId;
        }
      }
      continue;
    }

    for (const candidate of candidates) {
      const orderId = resolveEntityKey(candidate, parentOrderId, parentIncomeId);
      if (!orderId) continue;
      if (!capturedOrders[orderId]) {
        capturedOrders[orderId] = { order_id: orderId };
      }
      if (!capturedOrders[orderId].order_id) {
        capturedOrders[orderId].order_id = orderId;
      }
      if (includeParentContext) {
        mergeOrderFields(capturedOrders[orderId], flattenOrder(data));
        enrichOrderFromEntity(capturedOrders[orderId], data);
      }
      mergeOrderFields(capturedOrders[orderId], flattenOrder(candidate));
      enrichOrderFromEntity(capturedOrders[orderId], candidate);
      if (options.fromIncomeHistory) {
        const incomeInvoiceId = pickIncomeInvoiceId(candidate, true) || parentIncomeId;
        if (incomeInvoiceId) {
          capturedOrders[orderId].income_invoice_id = incomeInvoiceId;
        }
      }
    }
  }
  saveToStorage();
  updateBadge();
  notifyPopup();
}

function processOrderDetail(body) {
  if (!body || !body.data) return;
  const detail = body.data;
  const orderId = pickOrderId(detail);
  if (!orderId) return;
  if (!capturedOrders[orderId]) {
    capturedOrders[orderId] = { order_id: orderId };
  }
  mergeOrderFields(capturedOrders[orderId], flattenOrderDetail(detail));
  enrichOrderFromEntity(capturedOrders[orderId], detail);
  const incomeInvoiceId = pickIncomeInvoiceId(detail, true);
  if (incomeInvoiceId) {
    capturedOrders[orderId].income_invoice_id = incomeInvoiceId;
  }
  saveToStorage();
  updateBadge();
  notifyPopup();
}

function processEscrowDetail(body) {
  if (!body || !body.data) return;
  const detail = body.data;
  const orderId = pickOrderId(detail);
  if (!orderId) return;
  if (!capturedOrders[orderId]) {
    capturedOrders[orderId] = { order_id: orderId };
  }

  const escrow = detail.escrow_detail || detail;

  // Extract items
  const items = detail.items || detail.product_list || escrow.items || [];
  capturedOrders[orderId].items = items.map(item => ({
    name: item.item_name || item.product_name || item.name || '',
    sku: item.model_name || item.variation || item.sku || '',
    quantity: item.quantity || item.amount || item.qty || 0,
    unit_price: item.item_price || item.product_price || item.price || 0,
    subtotal: item.subtotal || (item.quantity || 0) * (item.item_price || item.price || 0),
    refund_qty: firstNumeric(
      item.refunded_qty,
      item.refund_qty,
      item.returned_qty,
      item.return_qty,
      item.cancelled_qty,
      item.canceled_qty,
      item.cancel_qty,
      0
    ) || 0,
    refund_status: deriveRefundStatus(
      item.quantity || item.amount || item.qty || 0,
      firstNumeric(
        item.refunded_qty,
        item.refund_qty,
        item.returned_qty,
        item.return_qty,
        item.cancelled_qty,
        item.canceled_qty,
        item.cancel_qty,
        0
      ) || 0,
      Boolean(
        item.show_return_tag ||
        item.showReturnTag ||
        item.show_cancellation_tag ||
        item.showCancellationTag ||
        item.is_refunded ||
        item.isRefunded
      )
    )
  }));

  capturedOrders[orderId].total_quantity = items.reduce((sum, i) => sum + (i.quantity || i.amount || i.qty || 0), 0);

  // Extract fee breakdown from escrow
  if (escrow) {
    capturedOrders[orderId].admin_fee = normalizeMoneyNumber(escrow.commission_fee || escrow.admin_fee || 0) || 0;
    capturedOrders[orderId].service_fee = normalizeMoneyNumber(escrow.service_fee || 0) || 0;
    capturedOrders[orderId].transaction_fee = normalizeMoneyNumber(escrow.credit_card_fee || escrow.transaction_fee || 0) || 0;
    capturedOrders[orderId].shipping_fee = normalizeMoneyNumber(escrow.actual_shipping_fee || escrow.shipping_fee || 0) || 0;
    capturedOrders[orderId].shipping_fee_rebate = normalizeMoneyNumber(escrow.shipping_fee_discount || escrow.shipping_rebate || 0) || 0;
    capturedOrders[orderId].buyer_shipping_fee = normalizeMoneyNumber(escrow.buyer_paid_shipping_fee || 0) || 0;
    capturedOrders[orderId].shopee_shipping_rebate = normalizeMoneyNumber(escrow.shopee_shipping_rebate || 0) || 0;
    capturedOrders[orderId].voucher_from_shopee = normalizeMoneyNumber(escrow.voucher_from_shopee || 0) || 0;
    capturedOrders[orderId].voucher_from_seller = normalizeMoneyNumber(escrow.voucher_from_seller || 0) || 0;
    capturedOrders[orderId].coins = normalizeMoneyNumber(escrow.coins || escrow.coin_amount || 0) || 0;
    capturedOrders[orderId].order_total = normalizeMoneyNumber(escrow.escrow_amount || escrow.buyer_total_amount || 0) || 0;
    capturedOrders[orderId].net_income = normalizeMoneyNumber(escrow.income || escrow.final_escrow_product_gst_amount || escrow.net_income || 0) || 0;
    const paymentMethod = pickPaymentMethod(
      escrow.payment_method_name,
      detail.payment_method_name,
      escrow.payment_method,
      detail.payment_method
    );
    if (paymentMethod) {
      capturedOrders[orderId].payment_method = paymentMethod;
    }
  }
  const incomeInvoiceId = pickIncomeInvoiceId(detail, true) || pickIncomeInvoiceId(escrow, true);
  if (incomeInvoiceId) {
    capturedOrders[orderId].income_invoice_id = incomeInvoiceId;
  }
  applyOrderGuards(capturedOrders[orderId]);

  saveToStorage();
  updateBadge();
  notifyPopup();
}

function processOrderIncomeComponents(body) {
  if (!body || !body.data || typeof body.data !== 'object') return;
  const data = body.data;
  const orderInfo = data.order_info && typeof data.order_info === 'object'
    ? data.order_info
    : data;

  const orderId = pickOrderId(orderInfo) || pickOrderId(data);
  if (!orderId) return;

  if (!capturedOrders[orderId]) {
    capturedOrders[orderId] = { order_id: orderId };
  }

  mergeOrderFields(capturedOrders[orderId], flattenOrder(orderInfo));
  enrichOrderFromEntity(capturedOrders[orderId], data);
  const hasSellerBreakdown = Array.isArray(data?.seller_income_breakdown?.breakdown)
    && data.seller_income_breakdown.breakdown.length > 0;
  capturedOrders[orderId]._has_explicit_shopee_voucher = hasExplicitShopeeVoucherDetail(data);
  capturedOrders[orderId]._components_voucher_checked = true;

  const voucherOverrides = extractVoucherFieldsFromSellerIncomeBreakdown(data);
  if (voucherOverrides.voucher_from_seller !== undefined) {
    capturedOrders[orderId].voucher_from_seller = voucherOverrides.voucher_from_seller;
    if (voucherOverrides.voucher_from_shopee === undefined) {
      capturedOrders[orderId].voucher_from_shopee = 0;
    }
  }
  if (voucherOverrides.voucher_from_shopee !== undefined) {
    capturedOrders[orderId].voucher_from_shopee = voucherOverrides.voucher_from_shopee;
  }

  const shippingOverrides = extractShippingFieldsFromSellerIncomeBreakdown(data);
  if (shippingOverrides.shipping_fee !== undefined) {
    capturedOrders[orderId].shipping_fee = shippingOverrides.shipping_fee;
  }
  if (shippingOverrides.buyer_shipping_fee !== undefined) {
    capturedOrders[orderId].buyer_shipping_fee = shippingOverrides.buyer_shipping_fee;
  }
  if (shippingOverrides.shopee_shipping_rebate !== undefined) {
    capturedOrders[orderId].shopee_shipping_rebate = shippingOverrides.shopee_shipping_rebate;
  }
  const coinOverride = extractCoinsFromSellerIncomeBreakdown(data);
  if (coinOverride !== undefined) {
    capturedOrders[orderId].coins = coinOverride;
  } else if (hasSellerBreakdown) {
    capturedOrders[orderId].coins = 0;
  }

  if (hasSellerBreakdown) {
    const componentBreakdown = {
      shipping_fee: shippingOverrides.shipping_fee !== undefined ? shippingOverrides.shipping_fee : 0,
      buyer_shipping_fee: shippingOverrides.buyer_shipping_fee !== undefined ? shippingOverrides.buyer_shipping_fee : 0,
      shopee_shipping_rebate: shippingOverrides.shopee_shipping_rebate !== undefined ? shippingOverrides.shopee_shipping_rebate : 0
    };
    if (voucherOverrides.voucher_from_seller !== undefined) {
      componentBreakdown.voucher_from_seller = voucherOverrides.voucher_from_seller;
    }
    if (voucherOverrides.voucher_from_shopee !== undefined) {
      componentBreakdown.voucher_from_shopee = voucherOverrides.voucher_from_shopee;
    } else if (!capturedOrders[orderId]._has_explicit_shopee_voucher) {
      componentBreakdown.voucher_from_shopee = 0;
    }

    capturedOrders[orderId]._components_breakdown_checked = true;
    capturedOrders[orderId]._components_breakdown = componentBreakdown;
  }

  const adjustedNet = normalizeMoneyNumber(
    data.adjustment_info?.amount_after_adjustment ||
    data.adjustment_info?.total_adjustment_amount ||
    data.adjustment_info?.amount ||
    0
  );
  if (adjustedNet !== null && adjustedNet !== 0) {
    capturedOrders[orderId].net_income = pickBetterNumeric(capturedOrders[orderId].net_income, adjustedNet);
    capturedOrders[orderId].order_income = pickBetterNumeric(capturedOrders[orderId].order_income, adjustedNet);
  }

  applyOrderGuards(capturedOrders[orderId]);

  saveToStorage();
  updateBadge();
  notifyPopup();
}

function processGenericResponse(url, body) {
  if (!body || typeof body !== 'object') return;
  const data = normalizeEntityRecord(body.data && typeof body.data === 'object' ? body.data : body);
  const list = extractListFromData(data);
  const includeParentContext = list.length <= 1;
  const parentOrderId = pickOrderId(data);
  const parentIncomeId = pickIncomeInvoiceId(data, true);
  if (list.length === 0) {
    if (!parentOrderId) return;
    if (!capturedOrders[parentOrderId]) {
      capturedOrders[parentOrderId] = { order_id: parentOrderId, _source: url };
    }
    mergeOrderFields(capturedOrders[parentOrderId], flattenOrder(data));
    enrichOrderFromEntity(capturedOrders[parentOrderId], data);
    if (parentIncomeId) {
      capturedOrders[parentOrderId].income_invoice_id = parentIncomeId;
    }
    saveToStorage();
    updateBadge();
    notifyPopup();
    return;
  }

  for (const item of list) {
    const candidates = expandEntityCandidates(item);
    if (candidates.length === 0) {
      const orderId = resolveEntityKey(item, parentOrderId, parentIncomeId);
      if (!orderId) continue;

      if (!capturedOrders[orderId]) {
        capturedOrders[orderId] = { order_id: orderId, _source: url };
      }
      if (!capturedOrders[orderId].order_id) {
        capturedOrders[orderId].order_id = orderId;
      }
      if (includeParentContext) {
        mergeOrderFields(capturedOrders[orderId], flattenOrder(data));
        enrichOrderFromEntity(capturedOrders[orderId], data);
      }
      mergeOrderFields(capturedOrders[orderId], flattenOrder(item));
      enrichOrderFromEntity(capturedOrders[orderId], item);
      const incomeInvoiceId = pickIncomeInvoiceId(item, true) || parentIncomeId;
      if (incomeInvoiceId) {
        capturedOrders[orderId].income_invoice_id = incomeInvoiceId;
      }
      continue;
    }

    for (const candidate of candidates) {
      const orderId = resolveEntityKey(candidate, parentOrderId, parentIncomeId);
      if (!orderId) continue;

      if (!capturedOrders[orderId]) {
        capturedOrders[orderId] = { order_id: orderId, _source: url };
      }
      if (!capturedOrders[orderId].order_id) {
        capturedOrders[orderId].order_id = orderId;
      }
      if (includeParentContext) {
        mergeOrderFields(capturedOrders[orderId], flattenOrder(data));
        enrichOrderFromEntity(capturedOrders[orderId], data);
      }
      mergeOrderFields(capturedOrders[orderId], flattenOrder(candidate));
      enrichOrderFromEntity(capturedOrders[orderId], candidate);
      const incomeInvoiceId = pickIncomeInvoiceId(candidate, true) || parentIncomeId;
      if (incomeInvoiceId) {
        capturedOrders[orderId].income_invoice_id = incomeInvoiceId;
      }
    }
  }

  saveToStorage();
  updateBadge();
  notifyPopup();
}

function mergeOrderFields(target, source) {
  if (!target || !source || typeof source !== 'object') return;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue;
    }

    if (typeof value === 'number' && value === 0) {
      const existing = target[key];
      if (typeof existing === 'number' && existing !== 0) continue;
      if (typeof existing === 'string' && existing.trim() !== '') continue;
    }

    target[key] = value;
  }
}

function flattenOrder(item) {
  const source = normalizeEntityRecord(item) || item || {};
  const orderIncomeInfo =
    source.order_income_info && typeof source.order_income_info === 'object'
      ? source.order_income_info
      : null;
  const orderInfo =
    source.order_info && typeof source.order_info === 'object'
      ? source.order_info
      : null;
  const orderIncome = normalizeMoneyNumber(
    source.order_income ||
    source.orderIncome ||
    source.income ||
    source.net_income ||
    source.income_amount ||
    source.amount ||
    source.escrow_amount ||
    source.escrowAmount ||
    source.final_income ||
    source.finalIncome ||
    0
  ) || 0;
  const createdTs =
    source.create_time ||
    source.createTime ||
    source.create_timestamp ||
    source.createTimestamp ||
    source.created_at ||
    source.createdAt ||
    source.ctime ||
    source.order_create_time ||
    source.orderCreateTime ||
    source.invoice_create_time ||
    source.invoiceCreateTime ||
    source.released_time ||
    source.releasedTime ||
    source.income_released_time ||
    source.incomeReleasedTime ||
    source.income_estimated_escrow_time ||
    source.incomeEstimatedEscrowTime;

  return {
    order_id: pickOrderId(source),
    order_sn:
      source.order_sn ||
      source.orderSn ||
      source.ordersn ||
      '',
    income_invoice_id: pickIncomeInvoiceId(source),
    buyer_name:
      source.buyer_username ||
      source.buyer_name ||
      source.buyerUsername ||
      source.buyerName ||
      source.buyer_nickname ||
      source.request_user_name ||
      source.requestUserName ||
      source.buyer ||
      '',
    order_status:
      source.order_status ||
      source.status ||
      source.orderStatus ||
      source.invoice_status ||
      source.invoiceStatus ||
      source.settle_status ||
      source.sub_type ||
      source.income_category ||
      '',
    create_time: createdTs ? formatTimestamp(createdTs) : '',
    payment_method: pickPaymentMethod(
      source.payment_method_name,
      source.paymentMethodName,
      source.payment_method,
      source.paymentMethod,
      orderIncomeInfo?.payment_method_name,
      orderIncomeInfo?.paymentMethodName,
      orderIncomeInfo?.payment_method,
      orderIncomeInfo?.paymentMethod
    ) || '',
    total_amount: normalizeMoneyNumber(
      source.total_amount ||
      source.buyer_total_amount ||
      source.buyerTotalAmount ||
      source.amount ||
      source.order_amount ||
      source.orderAmount ||
      source.net_income ||
      0
    ) || 0,
    order_income: orderIncome,
    net_income: normalizeMoneyNumber(source.net_income || source.income || orderIncome || 0) || 0,
  };
}

function flattenOrderDetail(detail) {
  const result = flattenOrder(detail);

  const items = detail.items || detail.product_list || detail.order_items || [];
  if (items.length > 0) {
    result.items = items.map(item => ({
      name: item.item_name || item.product_name || item.name || '',
      sku: item.model_name || item.variation || '',
      quantity: item.quantity || item.amount || 0,
      unit_price: item.item_price || item.product_price || 0,
      subtotal: (item.quantity || 0) * (item.item_price || item.product_price || 0),
      refund_qty: firstNumeric(
        item.refunded_qty,
        item.refund_qty,
        item.returned_qty,
        item.return_qty,
        item.cancelled_qty,
        item.canceled_qty,
        item.cancel_qty,
        0
      ) || 0,
      refund_status: deriveRefundStatus(
        item.quantity || item.amount || 0,
        firstNumeric(
          item.refunded_qty,
          item.refund_qty,
          item.returned_qty,
          item.return_qty,
          item.cancelled_qty,
          item.canceled_qty,
          item.cancel_qty,
          0
        ) || 0,
        Boolean(
          item.show_return_tag ||
          item.showReturnTag ||
          item.show_cancellation_tag ||
          item.showCancellationTag ||
          item.is_refunded ||
          item.isRefunded
        )
      )
    }));
    result.total_quantity = items.reduce((sum, i) => sum + (i.quantity || i.amount || 0), 0);
  }

  result.admin_fee = detail.commission_fee || detail.admin_fee || 0;
  result.admin_fee = normalizeMoneyNumber(result.admin_fee) || 0;
  result.service_fee = normalizeMoneyNumber(detail.service_fee || 0) || 0;
  result.transaction_fee = normalizeMoneyNumber(detail.credit_card_fee || detail.transaction_fee || 0) || 0;
  result.shipping_fee = normalizeMoneyNumber(detail.actual_shipping_fee || detail.shipping_fee || 0) || 0;
  result.voucher_from_shopee = normalizeMoneyNumber(detail.voucher_from_shopee || 0) || 0;
  result.voucher_from_seller = normalizeMoneyNumber(detail.voucher_from_seller || 0) || 0;
  result.net_income = normalizeMoneyNumber(detail.income || detail.net_income || detail.escrow_amount || 0) || 0;

  return result;
}

function formatTimestamp(ts) {
  if (!ts) return '';
  if (typeof ts === 'string') {
    const normalized = ts.trim();
    if (/^\d+$/.test(normalized)) {
      ts = Number(normalized);
    } else {
      const parsed = new Date(normalized);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 19).replace('T', ' ');
      }
      return normalized;
    }
  }
  if (typeof ts !== 'number' || Number.isNaN(ts)) return '';
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function pickOrderId(data) {
  if (!data || typeof data !== 'object') return '';
  const source = normalizeEntityRecord(data) || data;
  const direct = normalizeEntityIdValue(
    source.order_id ||
    source.orderId ||
    source.order_sn ||
    source.orderSn ||
    source.ordersn,
    { allowAlpha: true, minLength: 4 }
  );
  if (direct) {
    return direct;
  }
  return findOrderIdByKeysDeep(source);
}

function pickIncomeInvoiceId(data, allowGenericId = false) {
  if (!data || typeof data !== 'object') return '';
  const source = normalizeEntityRecord(data) || data;
  const direct = normalizeEntityIdValue(
    source.invoice_id ||
    source.invoiceId ||
    source.invoice_sn ||
    source.invoiceSn ||
    source.invoice_number ||
    source.invoiceNumber ||
    source.invoice_no ||
    source.income_id ||
    source.incomeId ||
    source.local_income_id ||
    source.localIncomeId ||
    source.seller_income_id ||
    source.sellerIncomeId ||
    source.income_sn ||
    source.incomeSn ||
    source.transaction_id ||
    source.transactionId ||
    (allowGenericId ? source.id : ''),
    { allowAlpha: true, minLength: 4 }
  );
  if (direct) {
    return direct;
  }
  const inferred = inferEntityId(source, { allowOrderKeys: false, allowGenericId });
  if (inferred) {
    return normalizeEntityIdValue(inferred, { allowAlpha: true, minLength: 4 });
  }
  const deep = findEntityIdDeep(source, { allowOrderKeys: false, allowGenericId });
  return normalizeEntityIdValue(deep, { allowAlpha: true, minLength: 4 });
}

function inferEntityId(source, options = {}) {
  if (!source || typeof source !== 'object') return '';
  const allowOrderKeys = options.allowOrderKeys !== false;
  const allowGenericId = options.allowGenericId !== false;

  const allowedHints = allowOrderKeys
    ? ['order', 'invoice', 'income', 'transaction', 'escrow', 'payment']
    : ['invoice', 'income', 'transaction', 'escrow', 'payment'];

  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (rawValue === null || rawValue === undefined) continue;
    const key = String(rawKey).toLowerCase();
    if (key.includes('report')) continue;
    const hasHint = allowedHints.some((hint) => key.includes(hint));
    const isIdLike = key.includes('id') || key.includes('sn') || key.endsWith('_no') || key.endsWith('number') || key.endsWith('_number');
    if (!hasHint || !isIdLike) continue;

    const value = normalizeEntityIdValue(rawValue, { allowAlpha: true, minLength: 4 });
    if (!value) continue;
    return value;
  }

  if (allowGenericId) {
    const value = normalizeEntityIdValue(source.id || '', { allowAlpha: true, minLength: 4 });
    if (value) {
      return value;
    }
  }

  return '';
}

function findOrderIdByKeysDeep(node, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 5) return '';
  if (seen.has(node)) return '';
  seen.add(node);

  if (!Array.isArray(node)) {
    const source = normalizeEntityRecord(node) || node;
    const direct = normalizeEntityIdValue(
      source.order_id ||
      source.orderId ||
      source.order_sn ||
      source.orderSn ||
      source.ordersn,
      { allowAlpha: true, minLength: 4 }
    );
    if (direct) return direct;
  }

  const values = Array.isArray(node) ? node : Object.values(node);
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const found = findOrderIdByKeysDeep(value, depth + 1, seen);
    if (found) return found;
  }

  return '';
}

function findEntityIdDeep(node, options = {}, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 5) return '';
  if (seen.has(node)) return '';
  seen.add(node);

  const normalized = !Array.isArray(node) ? (normalizeEntityRecord(node) || node) : null;
  if (normalized && typeof normalized === 'object') {
    const direct = inferEntityId(normalized, options);
    if (direct) {
      return direct;
    }
  }

  const values = Array.isArray(node) ? node : Object.values(node);
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const found = findEntityIdDeep(value, options, depth + 1, seen);
    if (found) return found;
  }

  return '';
}

function extractListFromData(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.invoices)) return data.invoices;
  if (Array.isArray(data.invoice_list)) return data.invoice_list;
  if (Array.isArray(data.orders)) return data.orders;
  if (Array.isArray(data.order_list)) return data.order_list;
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.transactions)) return data.transactions;
  if (Array.isArray(data.items)) return data.items;

  for (const value of Object.values(data)) {
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (hasEntityIdentity(first)) {
        return value;
      }
    }
  }

  // Some responses use an object map keyed by id instead of arrays.
  const entityObjects = Object.values(data).filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (entityObjects.length > 0 && entityObjects.some((value) => hasEntityIdentity(value))) {
    return entityObjects;
  }

  const deepList = findEntityArrayDeep(data, 0);
  if (deepList.length > 0) return deepList;

  return [];
}

function hasEntityIdentity(entity) {
  if (!entity || typeof entity !== 'object') return false;
  const source = normalizeEntityRecord(entity) || entity;
  if (inferEntityId(source, { allowOrderKeys: true, allowGenericId: false })) {
    return true;
  }
  return Boolean(
    source.order_sn ||
    source.orderSn ||
    source.ordersn ||
    source.order_id ||
    source.orderId ||
    source.invoice_id ||
    source.invoiceId ||
    source.invoice_sn ||
    source.invoiceSn ||
    source.invoice_number ||
    source.invoiceNumber ||
    source.invoice_no ||
    source.income_id ||
    source.incomeId ||
    source.local_income_id ||
    source.localIncomeId ||
    source.seller_income_id ||
    source.sellerIncomeId ||
    source.income_sn ||
    source.incomeSn ||
    source.transaction_id ||
    source.transactionId ||
    source.id
  );
}

function findEntityArrayDeep(node, depth) {
  if (!node || depth > 5) return [];

  if (Array.isArray(node)) {
    if (node.length === 0) return [];
    const firstEntity = node.find((item) => item && typeof item === 'object');
    if (firstEntity && hasEntityIdentity(firstEntity)) {
      return node;
    }
    for (const item of node) {
      if (!item || typeof item !== 'object') continue;
      const nested = findEntityArrayDeep(item, depth + 1);
      if (nested.length > 0) return nested;
    }
    return [];
  }

  if (typeof node === 'object') {
    for (const value of Object.values(node)) {
      const nested = findEntityArrayDeep(value, depth + 1);
      if (nested.length > 0) return nested;
    }
  }

  return [];
}

function notifyPopup() {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    orderCount: Object.keys(capturedOrders).length
  }).catch(() => {}); // popup might not be open
}

function isExportableOrder(order) {
  if (!order || typeof order !== 'object') return false;
  if (order.buyer_name || order.create_time || order.payment_method) return true;
  if (
    order.total_amount || order.order_total || order.order_income || order.net_income ||
    order.admin_fee || order.service_fee || order.transaction_fee || order.shipping_fee
  ) {
    return true;
  }

  if (!Array.isArray(order.items) || order.items.length === 0) {
    return false;
  }

  return order.items.some((item) =>
    item &&
    (item.name || item.sku || item.quantity || item.unit_price || item.subtotal)
  );
}

function isOrderHydrated(order) {
  if (!order || typeof order !== 'object') return false;

  const hasPricedItem = Array.isArray(order.items) && order.items.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const qty = toNumberOrNull(item.quantity) || 0;
    const unitPrice = toNumberOrNull(item.unit_price) || 0;
    const subtotal = toNumberOrNull(item.subtotal) || 0;
    return qty > 0 && (unitPrice > 0 || subtotal > 0);
  });

  const hasBreakdownFields = [
    'admin_fee',
    'service_fee',
    'transaction_fee',
    'shipping_fee',
    'refund_amount',
    'voucher_from_shopee',
    'voucher_from_seller',
    'buyer_shipping_fee',
    'shopee_shipping_rebate'
  ].some((key) => (toNumberOrNull(order[key]) || 0) !== 0);

  const hasIncome = (toNumberOrNull(order.order_income) || 0) !== 0 || (toNumberOrNull(order.net_income) || 0) !== 0;
  return hasPricedItem && (hasBreakdownFields || hasIncome);
}

function getPendingHydrationCount() {
  let pending = 0;
  for (const order of Object.values(capturedOrders)) {
    if (!order || typeof order !== 'object') continue;
    const id = normalizeEntityIdValue(order.order_id, { allowAlpha: false, minLength: 6, maxLength: 20 });
    if (!id) continue;
    if (!isOrderHydrated(order)) {
      pending += 1;
    }
  }
  return pending;
}

function canExportCsvNow() {
  if (syncInFlight) return false;
  return getPendingHydrationCount() === 0;
}

function firstPresent(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    return value;
  }
  return '';
}

const EXPORT_HEADERS = [
  'Order ID',
  'Order SN',
  'Income Invoice ID',
  'Buyer Name',
  'Order Status',
  'Created',
  'Order Date',
  'Payment Method',
  'Product Name',
  'SKU/Variant',
  'Quantity',
  'Unit Price',
  'Product Subtotal',
  'Refund Status',
  'Refund Qty',
  'Item Details',
  'Total Quantity',
  'Order Total (Rp)',
  'Refund Amount (Rp)',
  'Admin Fee (Rp)',
  'Service Fee (Rp)',
  'Transaction Fee (Rp)',
  'Shipping Fee (Rp)',
  'Shipping Fee Rebate (Rp)',
  'Buyer Shipping Fee (Rp)',
  'Shopee Shipping Rebate (Rp)',
  'Voucher Shopee (Rp)',
  'Voucher Seller (Rp)',
  'Coins (Rp)',
  'Order Income (Rp)',
  'Net Income (Rp)'
];

function parseOrderTimestampValue(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) {
    const asNum = Number(trimmed);
    if (!Number.isFinite(asNum)) return 0;
    return asNum > 1e12 ? asNum : asNum * 1000;
  }
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractOrderDateText(createdText) {
  if (!createdText) return '';
  const text = String(createdText).trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }
  const parsed = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'));
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
}

function getOrderSortTimestamp(order) {
  if (!order || typeof order !== 'object') return 0;
  const candidates = [
    order.create_time,
    order.released_time,
    order.income_released_time,
    order.income_estimated_escrow_time,
    order.mtime,
    order.ctime
  ];
  for (const candidate of candidates) {
    const ts = parseOrderTimestampValue(candidate);
    if (ts > 0) return ts;
  }
  return 0;
}

function getExportOrders() {
  return Object.values(capturedOrders)
    .filter(isExportableOrder)
    .sort((left, right) => {
      const tsDiff = getOrderSortTimestamp(right) - getOrderSortTimestamp(left);
      if (tsDiff !== 0) return tsDiff;
      const leftKey = String(firstPresent(left.order_id, left.order_sn, left.income_invoice_id, ''));
      const rightKey = String(firstPresent(right.order_id, right.order_sn, right.income_invoice_id, ''));
      return leftKey.localeCompare(rightKey);
    });
}

function buildExportRows(orders = getExportOrders()) {
  if (orders.length === 0) return [];

  const rows = [];
  let fallbackGroupIndex = 0;

  for (const order of orders) {
    applyOrderGuards(order);
    const items = Array.isArray(order.items) && order.items.length > 0
      ? order.items
      : [{ name: '', sku: '', quantity: '', unit_price: '', subtotal: '' }];
    const groupKey = firstPresent(order.order_id, order.order_sn, order.income_invoice_id, `group_${fallbackGroupIndex++}`);

    items.forEach((item, index) => {
      const name = item.name || '-';
      const sku = item.sku ? ` [${item.sku}]` : '';
      const qty = item.quantity ?? '';
      const price = item.unit_price ?? '';
      const subtotal = item.subtotal ?? '';
      const refundStatus = item.refund_status || '';
      const refundQty = refundStatus ? (item.refund_qty ?? '') : '';
      const refundSuffix = refundStatus
        ? ` | ${refundStatus}${refundQty ? ` x${refundQty}` : ''}`
        : '';
      const itemDetail = `${name}${sku} x${qty} @${price} = ${subtotal}${refundSuffix}`;
      const isFirst = index === 0;
      const createdText = isFirst ? (order.create_time || '') : '';

      rows.push({
        __groupKey: groupKey,
        'Order ID': isFirst ? (order.order_id || '') : '',
        'Order SN': isFirst ? (order.order_sn || '') : '',
        'Income Invoice ID': isFirst ? (order.income_invoice_id || '') : '',
        'Buyer Name': isFirst ? (order.buyer_name || '') : '',
        'Order Status': isFirst ? (order.order_status || '') : '',
        'Created': createdText,
        'Order Date': isFirst ? extractOrderDateText(createdText) : '',
        'Payment Method': isFirst ? (order.payment_method || '') : '',
        'Product Name': item.name || '',
        'SKU/Variant': item.sku || '',
        'Quantity': item.quantity ?? '',
        'Unit Price': item.unit_price ?? '',
        'Product Subtotal': item.subtotal ?? '',
        'Refund Status': item.refund_status || '',
        'Refund Qty': item.refund_qty ?? '',
        'Item Details': itemDetail,
        'Total Quantity': isFirst ? (order.total_quantity || '') : '',
        'Order Total (Rp)': isFirst ? firstPresent(order.total_amount, order.order_total, order.order_income) : '',
        'Refund Amount (Rp)': isFirst ? (order.refund_amount || '') : '',
        'Admin Fee (Rp)': isFirst ? (order.admin_fee || '') : '',
        'Service Fee (Rp)': isFirst ? (order.service_fee || '') : '',
        'Transaction Fee (Rp)': isFirst ? (order.transaction_fee || '') : '',
        'Shipping Fee (Rp)': isFirst ? (order.shipping_fee || '') : '',
        'Shipping Fee Rebate (Rp)': isFirst ? (order.shipping_fee_rebate || '') : '',
        'Buyer Shipping Fee (Rp)': isFirst ? (order.buyer_shipping_fee || '') : '',
        'Shopee Shipping Rebate (Rp)': isFirst ? (order.shopee_shipping_rebate || '') : '',
        'Voucher Shopee (Rp)': isFirst ? (order.voucher_from_shopee || '') : '',
        'Voucher Seller (Rp)': isFirst ? (order.voucher_from_seller || '') : '',
        'Coins (Rp)': isFirst ? (order.coins || '') : '',
        'Order Income (Rp)': isFirst ? firstPresent(order.order_income, order.net_income) : '',
        'Net Income (Rp)': isFirst ? firstPresent(order.net_income, order.order_income) : ''
      });
    });
  }

  return rows;
}

function sumOrderField(orders, field) {
  return orders.reduce((sum, order) => sum + (toNumberOrNull(order?.[field]) || 0), 0);
}

function sumPreferredOrderFields(orders, fields) {
  return orders.reduce((sum, order) => {
    for (const field of fields) {
      const value = toNumberOrNull(order?.[field]);
      if (value === null) continue;
      return sum + value;
    }
    return sum;
  }, 0);
}

function buildExcelTotals(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return [];
  }

  return [
    ['Invoice Totals', ''],
    ['Total Orders', orders.length],
    ['Total Quantity', sumOrderField(orders, 'total_quantity')],
    ['Order Total (Rp)', sumPreferredOrderFields(orders, ['total_amount', 'order_total', 'order_income'])],
    ['Refund Amount (Rp)', sumOrderField(orders, 'refund_amount')],
    ['Admin Fee (Rp)', sumOrderField(orders, 'admin_fee')],
    ['Service Fee (Rp)', sumOrderField(orders, 'service_fee')],
    ['Transaction Fee (Rp)', sumOrderField(orders, 'transaction_fee')],
    ['Shipping Fee (Rp)', sumOrderField(orders, 'shipping_fee')],
    ['Shipping Fee Rebate (Rp)', sumOrderField(orders, 'shipping_fee_rebate')],
    ['Buyer Shipping Fee (Rp)', sumOrderField(orders, 'buyer_shipping_fee')],
    ['Shopee Shipping Rebate (Rp)', sumOrderField(orders, 'shopee_shipping_rebate')],
    ['Voucher Shopee (Rp)', sumOrderField(orders, 'voucher_from_shopee')],
    ['Voucher Seller (Rp)', sumOrderField(orders, 'voucher_from_seller')],
    ['Coins (Rp)', sumOrderField(orders, 'coins')],
    ['Order Income (Rp)', sumPreferredOrderFields(orders, ['order_income', 'net_income'])],
    ['Net Income (Rp)', sumPreferredOrderFields(orders, ['net_income', 'order_income'])]
  ];
}

function buildProductQuantitySummary(orders) {
  const productMap = new Map();

  for (const order of orders) {
    if (!order || !Array.isArray(order.items)) continue;
    const orderKey = firstPresent(order.order_id, order.order_sn, order.income_invoice_id, '');
    for (const item of order.items) {
      if (!item || typeof item !== 'object') continue;
      const name = String(item.name || '-').trim() || '-';
      const sku = String(item.sku || '').trim();
      const orderedQty = toNumberOrNull(item.quantity) || 0;
      const refundedQty = Math.max(toNumberOrNull(item.refund_qty) || 0, 0);
      const soldQty = Math.max(orderedQty - refundedQty, 0);
      const salesSubtotal = toNumberOrNull(item.subtotal) || 0;
      const key = `${name}\u0000${sku}`;

      if (!productMap.has(key)) {
        productMap.set(key, {
          name,
          sku,
          qtyOrdered: 0,
          qtyRefunded: 0,
          qtySold: 0,
          salesSubtotal: 0,
          _orderKeys: new Set()
        });
      }

      const entry = productMap.get(key);
      entry.qtyOrdered += orderedQty;
      entry.qtyRefunded += refundedQty;
      entry.qtySold += soldQty;
      entry.salesSubtotal += salesSubtotal;
      if (orderKey) {
        entry._orderKeys.add(orderKey);
      }
    }
  }

  return Array.from(productMap.values())
    .map((entry) => ({
      name: entry.name,
      sku: entry.sku,
      qtyOrdered: entry.qtyOrdered,
      qtyRefunded: entry.qtyRefunded,
      qtySold: entry.qtySold,
      salesSubtotal: entry.salesSubtotal,
      orderCount: entry._orderKeys.size
    }))
    .sort((left, right) => {
      const soldDiff = right.qtySold - left.qtySold;
      if (soldDiff !== 0) return soldDiff;
      const nameDiff = left.name.localeCompare(right.name);
      if (nameDiff !== 0) return nameDiff;
      return left.sku.localeCompare(right.sku);
    });
}

function generateCSV() {
  const rows = buildExportRows();
  if (rows.length === 0) return '';

  const csvLines = [EXPORT_HEADERS.join(',')];

  for (const row of rows) {
    const values = EXPORT_HEADERS.map((h) => {
      const val = String(row[h] ?? '');
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    });
    csvLines.push(values.join(','));
  }

  return csvLines.join('\n');
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function makeCellSpec(value, type = 'string', options = {}) {
  return {
    __cellSpec: true,
    value,
    type,
    wrap: Boolean(options.wrap)
  };
}

function isCellSpec(value) {
  return Boolean(value && typeof value === 'object' && value.__cellSpec);
}

function formatNumberDisplay(value) {
  const numeric = toNumberOrNull(value);
  if (numeric === null) return '';
  return numeric.toLocaleString('id-ID');
}

function hasRefundedItem(item) {
  if (!item || typeof item !== 'object') return false;
  return Boolean(item.refund_status) || (toNumberOrNull(item.refund_qty) || 0) > 0;
}

function hasRefundedOrder(order) {
  if (!order || typeof order !== 'object') return false;
  if ((toNumberOrNull(order.refund_amount) || 0) !== 0) return true;
  return Array.isArray(order.items) && order.items.some(hasRefundedItem);
}

function getOrderPrimaryTotal(order) {
  return toNumberOrNull(firstPresent(order?.total_amount, order?.order_total, order?.order_income)) || 0;
}

function getOrderPrimaryIncome(order) {
  return toNumberOrNull(firstPresent(order?.order_income, order?.net_income)) || 0;
}

function getOrderPrimaryNetIncome(order) {
  return toNumberOrNull(firstPresent(order?.net_income, order?.order_income)) || 0;
}

function getOrderDateRange(orders) {
  const timestamps = orders
    .map((order) => getOrderSortTimestamp(order))
    .filter((value) => value > 0);

  if (timestamps.length === 0) {
    return { from: '', to: '' };
  }

  const from = new Date(Math.min(...timestamps)).toISOString().slice(0, 10);
  const to = new Date(Math.max(...timestamps)).toISOString().slice(0, 10);
  return { from, to };
}

function buildSummarySheetRows(orders, productSummary) {
  const dateRange = getOrderDateRange(orders);
  const grossSales = sumPreferredOrderFields(orders, ['total_amount', 'order_total', 'order_income']);
  const totalQtyOrdered = productSummary.reduce((sum, item) => sum + (item.qtyOrdered || 0), 0);
  const totalQtyRefunded = productSummary.reduce((sum, item) => sum + (item.qtyRefunded || 0), 0);
  const totalQtySold = productSummary.reduce((sum, item) => sum + (item.qtySold || 0), 0);
  const refundedOrders = orders.filter(hasRefundedOrder).length;
  const refundedLines = orders.reduce((sum, order) => {
    if (!Array.isArray(order.items)) return sum;
    return sum + order.items.filter(hasRefundedItem).length;
  }, 0);

  return [
    { Metric: 'Generated At', Value: formatTimestamp(Date.now()) },
    { Metric: 'Profile Email', Value: profileInfo.email || '' },
    { Metric: 'Date From', Value: dateRange.from },
    { Metric: 'Date To', Value: dateRange.to },
    { Metric: 'Total Orders', Value: makeCellSpec(orders.length, 'integer') },
    { Metric: 'Refunded Orders', Value: makeCellSpec(refundedOrders, 'integer') },
    { Metric: 'Refunded Lines', Value: makeCellSpec(refundedLines, 'integer') },
    { Metric: 'Total Qty Ordered', Value: makeCellSpec(totalQtyOrdered, 'integer') },
    { Metric: 'Total Qty Refunded', Value: makeCellSpec(totalQtyRefunded, 'integer') },
    { Metric: 'Total Qty Sold', Value: makeCellSpec(totalQtySold, 'integer') },
    { Metric: 'Gross Sales (Rp)', Value: makeCellSpec(grossSales, 'currency') },
    { Metric: 'Refund Amount (Rp)', Value: makeCellSpec(sumOrderField(orders, 'refund_amount'), 'currency') },
    { Metric: 'Admin Fee (Rp)', Value: makeCellSpec(sumOrderField(orders, 'admin_fee'), 'currency') },
    { Metric: 'Service Fee (Rp)', Value: makeCellSpec(sumOrderField(orders, 'service_fee'), 'currency') },
    { Metric: 'Transaction Fee (Rp)', Value: makeCellSpec(sumOrderField(orders, 'transaction_fee'), 'currency') },
    { Metric: 'Shipping Fee (Rp)', Value: makeCellSpec(sumOrderField(orders, 'shipping_fee'), 'currency') },
    { Metric: 'Shipping Fee Rebate (Rp)', Value: makeCellSpec(sumOrderField(orders, 'shipping_fee_rebate'), 'currency') },
    { Metric: 'Buyer Shipping Fee (Rp)', Value: makeCellSpec(sumOrderField(orders, 'buyer_shipping_fee'), 'currency') },
    { Metric: 'Shopee Shipping Rebate (Rp)', Value: makeCellSpec(sumOrderField(orders, 'shopee_shipping_rebate'), 'currency') },
    { Metric: 'Voucher Shopee (Rp)', Value: makeCellSpec(sumOrderField(orders, 'voucher_from_shopee'), 'currency') },
    { Metric: 'Voucher Seller (Rp)', Value: makeCellSpec(sumOrderField(orders, 'voucher_from_seller'), 'currency') },
    { Metric: 'Coins (Rp)', Value: makeCellSpec(sumOrderField(orders, 'coins'), 'currency') },
    { Metric: 'Order Income (Rp)', Value: makeCellSpec(sumPreferredOrderFields(orders, ['order_income', 'net_income']), 'currency') },
    { Metric: 'Net Income (Rp)', Value: makeCellSpec(sumPreferredOrderFields(orders, ['net_income', 'order_income']), 'currency') }
  ];
}

function buildOrdersSheetRows(orders) {
  return orders.map((order) => {
    applyOrderGuards(order);
    const items = Array.isArray(order.items) ? order.items : [];
    const itemList = items.map((item) => {
      const name = item?.name || '-';
      const sku = item?.sku ? ` [${item.sku}]` : '';
      const qty = formatNumberDisplay(item?.quantity) || '0';
      return `${name}${sku} x${qty}`;
    }).join('\n');

    return {
      'Order Date': extractOrderDateText(order.create_time || ''),
      Created: order.create_time || '',
      'Order ID': order.order_id || '',
      'Order SN': order.order_sn || '',
      'Income Invoice ID': order.income_invoice_id || '',
      'Buyer Name': order.buyer_name || '',
      'Payment Method': order.payment_method || '',
      'Order Status': order.order_status || '',
      'Item Count': items.length,
      'Total Quantity': toNumberOrNull(order.total_quantity) || 0,
      Refunded: hasRefundedOrder(order) ? 'Yes' : 'No',
      'Order Total (Rp)': getOrderPrimaryTotal(order),
      'Refund Amount (Rp)': toNumberOrNull(order.refund_amount) || 0,
      'Admin Fee (Rp)': toNumberOrNull(order.admin_fee) || 0,
      'Service Fee (Rp)': toNumberOrNull(order.service_fee) || 0,
      'Transaction Fee (Rp)': toNumberOrNull(order.transaction_fee) || 0,
      'Shipping Fee (Rp)': toNumberOrNull(order.shipping_fee) || 0,
      'Shipping Fee Rebate (Rp)': toNumberOrNull(order.shipping_fee_rebate) || 0,
      'Buyer Shipping Fee (Rp)': toNumberOrNull(order.buyer_shipping_fee) || 0,
      'Shopee Shipping Rebate (Rp)': toNumberOrNull(order.shopee_shipping_rebate) || 0,
      'Voucher Shopee (Rp)': toNumberOrNull(order.voucher_from_shopee) || 0,
      'Voucher Seller (Rp)': toNumberOrNull(order.voucher_from_seller) || 0,
      'Coins (Rp)': toNumberOrNull(order.coins) || 0,
      'Order Income (Rp)': getOrderPrimaryIncome(order),
      'Net Income (Rp)': getOrderPrimaryNetIncome(order),
      Items: makeCellSpec(itemList, 'string', { wrap: true })
    };
  });
}

function buildFeesSheetRows(orders) {
  const grossSales = sumPreferredOrderFields(orders, ['total_amount', 'order_total', 'order_income']);
  const entries = [
    ['Refund Amount', sumOrderField(orders, 'refund_amount')],
    ['Admin Fee', sumOrderField(orders, 'admin_fee')],
    ['Service Fee', sumOrderField(orders, 'service_fee')],
    ['Transaction Fee', sumOrderField(orders, 'transaction_fee')],
    ['Shipping Fee', sumOrderField(orders, 'shipping_fee')],
    ['Shipping Fee Rebate', sumOrderField(orders, 'shipping_fee_rebate')],
    ['Buyer Shipping Fee', sumOrderField(orders, 'buyer_shipping_fee')],
    ['Shopee Shipping Rebate', sumOrderField(orders, 'shopee_shipping_rebate')],
    ['Voucher Shopee', sumOrderField(orders, 'voucher_from_shopee')],
    ['Voucher Seller', sumOrderField(orders, 'voucher_from_seller')],
    ['Coins', sumOrderField(orders, 'coins')]
  ];

  return entries.map(([feeType, amount]) => ({
    'Fee Type': feeType,
    'Amount (Rp)': amount,
    'Percent of Gross Sales': grossSales !== 0 ? amount / grossSales : 0
  }));
}

function buildRefundsSheetRows(orders) {
  const rows = [];

  for (const order of orders) {
    applyOrderGuards(order);
    const items = Array.isArray(order.items) ? order.items : [];
    const refundedItems = items.filter(hasRefundedItem);
    const orderRefundAmount = toNumberOrNull(order.refund_amount) || 0;

    if (refundedItems.length === 0 && orderRefundAmount === 0) {
      continue;
    }

    if (refundedItems.length === 0) {
      rows.push({
        'Order Date': extractOrderDateText(order.create_time || ''),
        'Order ID': order.order_id || '',
        'Order SN': order.order_sn || '',
        'Payment Method': order.payment_method || '',
        'Product Name': '',
        'SKU/Variant': '',
        'Qty Ordered': 0,
        'Qty Refunded': 0,
        'Refund Status': 'Order Refund',
        'Product Subtotal (Rp)': 0,
        'Refund Amount (Rp)': orderRefundAmount,
        'Net Income (Rp)': getOrderPrimaryNetIncome(order)
      });
      continue;
    }

    refundedItems.forEach((item, index) => {
      rows.push({
        'Order Date': extractOrderDateText(order.create_time || ''),
        'Order ID': order.order_id || '',
        'Order SN': order.order_sn || '',
        'Payment Method': order.payment_method || '',
        'Product Name': item.name || '',
        'SKU/Variant': item.sku || '',
        'Qty Ordered': toNumberOrNull(item.quantity) || 0,
        'Qty Refunded': toNumberOrNull(item.refund_qty) || 0,
        'Refund Status': item.refund_status || 'Return/Refund',
        'Product Subtotal (Rp)': toNumberOrNull(item.subtotal) || 0,
        'Refund Amount (Rp)': index === 0 ? orderRefundAmount : '',
        'Net Income (Rp)': index === 0 ? getOrderPrimaryNetIncome(order) : ''
      });
    });
  }

  return rows;
}

const EXCEL_BASE_STYLES = `
  <Style ss:ID="header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Alignment ss:Vertical="Center" ss:Horizontal="Center" ss:WrapText="1"/>
   <Interior ss:Color="#ED7D31" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#BFBFBF"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#BFBFBF"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#BFBFBF"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#BFBFBF"/>
   </Borders>
  </Style>
  <Style ss:ID="rowOddText">
   <Alignment ss:Vertical="Top"/>
   <Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>
  <Style ss:ID="rowEvenText">
   <Alignment ss:Vertical="Top"/>
   <Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>
  <Style ss:ID="rowOddWrap">
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
   <Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>
  <Style ss:ID="rowEvenWrap">
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
   <Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>
  <Style ss:ID="rowOddInteger">
   <Alignment ss:Vertical="Top" ss:Horizontal="Right"/>
   <NumberFormat ss:Format="#,##0"/>
   <Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>
  <Style ss:ID="rowEvenInteger">
   <Alignment ss:Vertical="Top" ss:Horizontal="Right"/>
   <NumberFormat ss:Format="#,##0"/>
   <Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>
  <Style ss:ID="rowOddCurrency">
   <Alignment ss:Vertical="Top" ss:Horizontal="Right"/>
   <NumberFormat ss:Format="#,##0"/>
   <Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>
  <Style ss:ID="rowEvenCurrency">
   <Alignment ss:Vertical="Top" ss:Horizontal="Right"/>
   <NumberFormat ss:Format="#,##0"/>
   <Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>
  <Style ss:ID="rowOddPercent">
   <Alignment ss:Vertical="Top" ss:Horizontal="Right"/>
   <NumberFormat ss:Format="0.00%"/>
   <Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>
  <Style ss:ID="rowEvenPercent">
   <Alignment ss:Vertical="Top" ss:Horizontal="Right"/>
   <NumberFormat ss:Format="0.00%"/>
   <Interior ss:Color="#DDEBF7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E0E0E0"/>
   </Borders>
  </Style>`;

const SUMMARY_HEADERS = ['Metric', 'Value'];
const ORDERS_SHEET_HEADERS = [
  'Order Date',
  'Created',
  'Order ID',
  'Order SN',
  'Income Invoice ID',
  'Buyer Name',
  'Payment Method',
  'Order Status',
  'Item Count',
  'Total Quantity',
  'Refunded',
  'Order Total (Rp)',
  'Refund Amount (Rp)',
  'Admin Fee (Rp)',
  'Service Fee (Rp)',
  'Transaction Fee (Rp)',
  'Shipping Fee (Rp)',
  'Shipping Fee Rebate (Rp)',
  'Buyer Shipping Fee (Rp)',
  'Shopee Shipping Rebate (Rp)',
  'Voucher Shopee (Rp)',
  'Voucher Seller (Rp)',
  'Coins (Rp)',
  'Order Income (Rp)',
  'Net Income (Rp)',
  'Items'
];

const PRODUCTS_SHEET_HEADERS = [
  'Product Name',
  'SKU/Variant',
  'Qty Ordered',
  'Qty Refunded',
  'Qty Sold',
  'Sales Subtotal (Rp)',
  'Order Count'
];

const FEES_SHEET_HEADERS = ['Fee Type', 'Amount (Rp)', 'Percent of Gross Sales'];

const REFUNDS_SHEET_HEADERS = [
  'Order Date',
  'Order ID',
  'Order SN',
  'Payment Method',
  'Product Name',
  'SKU/Variant',
  'Qty Ordered',
  'Qty Refunded',
  'Refund Status',
  'Product Subtotal (Rp)',
  'Refund Amount (Rp)',
  'Net Income (Rp)'
];

const ORDER_LINE_COLUMN_CONFIG = {
  'Order ID': { width: 95 },
  'Order SN': { width: 95 },
  'Income Invoice ID': { width: 95 },
  'Buyer Name': { width: 110 },
  'Order Status': { width: 70 },
  'Created': { width: 110 },
  'Order Date': { width: 80 },
  'Payment Method': { width: 110 },
  'Product Name': { width: 240, wrap: true },
  'SKU/Variant': { width: 120, wrap: true },
  'Quantity': { width: 60, type: 'integer' },
  'Unit Price': { width: 85, type: 'currency' },
  'Product Subtotal': { width: 90, type: 'currency' },
  'Refund Status': { width: 100, wrap: true },
  'Refund Qty': { width: 60, type: 'integer' },
  'Item Details': { width: 280, wrap: true },
  'Total Quantity': { width: 70, type: 'integer' },
  'Order Total (Rp)': { width: 90, type: 'currency' },
  'Refund Amount (Rp)': { width: 90, type: 'currency' },
  'Admin Fee (Rp)': { width: 85, type: 'currency' },
  'Service Fee (Rp)': { width: 85, type: 'currency' },
  'Transaction Fee (Rp)': { width: 90, type: 'currency' },
  'Shipping Fee (Rp)': { width: 85, type: 'currency' },
  'Shipping Fee Rebate (Rp)': { width: 95, type: 'currency' },
  'Buyer Shipping Fee (Rp)': { width: 95, type: 'currency' },
  'Shopee Shipping Rebate (Rp)': { width: 105, type: 'currency' },
  'Voucher Shopee (Rp)': { width: 90, type: 'currency' },
  'Voucher Seller (Rp)': { width: 90, type: 'currency' },
  'Coins (Rp)': { width: 75, type: 'currency' },
  'Order Income (Rp)': { width: 90, type: 'currency' },
  'Net Income (Rp)': { width: 90, type: 'currency' }
};

const SUMMARY_COLUMN_CONFIG = {
  Metric: { width: 180, wrap: true },
  Value: { width: 120, wrap: true }
};

const ORDERS_COLUMN_CONFIG = {
  'Order Date': { width: 80 },
  Created: { width: 110 },
  'Order ID': { width: 95 },
  'Order SN': { width: 95 },
  'Income Invoice ID': { width: 95 },
  'Buyer Name': { width: 120, wrap: true },
  'Payment Method': { width: 110, wrap: true },
  'Order Status': { width: 70 },
  'Item Count': { width: 60, type: 'integer' },
  'Total Quantity': { width: 75, type: 'integer' },
  Refunded: { width: 70 },
  'Order Total (Rp)': { width: 90, type: 'currency' },
  'Refund Amount (Rp)': { width: 90, type: 'currency' },
  'Admin Fee (Rp)': { width: 85, type: 'currency' },
  'Service Fee (Rp)': { width: 85, type: 'currency' },
  'Transaction Fee (Rp)': { width: 90, type: 'currency' },
  'Shipping Fee (Rp)': { width: 85, type: 'currency' },
  'Shipping Fee Rebate (Rp)': { width: 95, type: 'currency' },
  'Buyer Shipping Fee (Rp)': { width: 95, type: 'currency' },
  'Shopee Shipping Rebate (Rp)': { width: 105, type: 'currency' },
  'Voucher Shopee (Rp)': { width: 90, type: 'currency' },
  'Voucher Seller (Rp)': { width: 90, type: 'currency' },
  'Coins (Rp)': { width: 75, type: 'currency' },
  'Order Income (Rp)': { width: 90, type: 'currency' },
  'Net Income (Rp)': { width: 90, type: 'currency' },
  Items: { width: 280, wrap: true }
};

const PRODUCTS_COLUMN_CONFIG = {
  'Product Name': { width: 260, wrap: true },
  'SKU/Variant': { width: 120, wrap: true },
  'Qty Ordered': { width: 80, type: 'integer' },
  'Qty Refunded': { width: 80, type: 'integer' },
  'Qty Sold': { width: 80, type: 'integer' },
  'Sales Subtotal (Rp)': { width: 100, type: 'currency' },
  'Order Count': { width: 75, type: 'integer' }
};

const FEES_COLUMN_CONFIG = {
  'Fee Type': { width: 180, wrap: true },
  'Amount (Rp)': { width: 95, type: 'currency' },
  'Percent of Gross Sales': { width: 100, type: 'percent' }
};

const REFUNDS_COLUMN_CONFIG = {
  'Order Date': { width: 80 },
  'Order ID': { width: 95 },
  'Order SN': { width: 95 },
  'Payment Method': { width: 110, wrap: true },
  'Product Name': { width: 260, wrap: true },
  'SKU/Variant': { width: 120, wrap: true },
  'Qty Ordered': { width: 75, type: 'integer' },
  'Qty Refunded': { width: 75, type: 'integer' },
  'Refund Status': { width: 100, wrap: true },
  'Product Subtotal (Rp)': { width: 95, type: 'currency' },
  'Refund Amount (Rp)': { width: 95, type: 'currency' },
  'Net Income (Rp)': { width: 90, type: 'currency' }
};

function sanitizeWorksheetName(name) {
  const text = String(name || 'Sheet').replace(/[:\\\\/?*\\[\\]]/g, ' ').trim();
  return (text || 'Sheet').slice(0, 31);
}

function buildSpreadsheetCell(value, styleId, type = 'String') {
  const normalizedType = type === 'Number' ? 'Number' : 'String';
  const normalizedValue = normalizedType === 'Number'
    ? String(Number(value || 0))
    : String(value ?? '');
  return `<Cell ss:StyleID="${styleId}"><Data ss:Type="${normalizedType}">${escapeXml(normalizedValue)}</Data></Cell>`;
}

function buildSheetCell(value, columnConfig, variant) {
  const config = columnConfig || {};
  const prefix = variant === 'Even' ? 'rowEven' : 'rowOdd';
  let cellValue = value;
  let type = config.type || 'string';
  let wrap = Boolean(config.wrap);

  if (isCellSpec(value)) {
    cellValue = value.value;
    type = value.type || type;
    wrap = Boolean(value.wrap || wrap);
  }

  if (cellValue === '' || cellValue === null || cellValue === undefined) {
    return buildSpreadsheetCell('', wrap ? `${prefix}Wrap` : `${prefix}Text`, 'String');
  }

  if (typeof cellValue === 'string' && cellValue.includes('\n')) {
    wrap = true;
  }

  if (type === 'integer') {
    return buildSpreadsheetCell(toNumberOrNull(cellValue) || 0, `${prefix}Integer`, 'Number');
  }
  if (type === 'currency') {
    return buildSpreadsheetCell(toNumberOrNull(cellValue) || 0, `${prefix}Currency`, 'Number');
  }
  if (type === 'percent') {
    return buildSpreadsheetCell(toNumberOrNull(cellValue) || 0, `${prefix}Percent`, 'Number');
  }

  return buildSpreadsheetCell(cellValue, wrap ? `${prefix}Wrap` : `${prefix}Text`, 'String');
}

function buildWorksheetXml(options) {
  const {
    name,
    headers,
    rows,
    columnConfig = {},
    groupField = ''
  } = options;

  const columnDefs = headers
    .map((header) => `<Column ss:AutoFitWidth="0" ss:Width="${columnConfig[header]?.width || 90}"/>`)
    .join('');
  const headerCells = headers
    .map((header) => `<Cell ss:StyleID="header"><Data ss:Type="String">${escapeXml(header)}</Data></Cell>`)
    .join('');

  let lastGroupValue = null;
  let currentVariant = 'Even';

  const dataRowsXml = rows.map((row, index) => {
    const variant = groupField
      ? (() => {
          const groupValue = String(row?.[groupField] || `row_${index}`);
          if (groupValue !== lastGroupValue) {
            currentVariant = currentVariant === 'Odd' ? 'Even' : 'Odd';
            lastGroupValue = groupValue;
          }
          return currentVariant;
        })()
      : (index % 2 === 0 ? 'Odd' : 'Even');

    const cells = headers
      .map((header) => buildSheetCell(row?.[header], columnConfig[header], variant))
      .join('');
    return `<Row>${cells}</Row>`;
  }).join('');

  return `<Worksheet ss:Name="${escapeXml(sanitizeWorksheetName(name))}">
  <Table>
   ${columnDefs}
   <Row>${headerCells}</Row>
   ${dataRowsXml}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <FreezePanes/>
   <FrozenNoSplit/>
   <SplitHorizontal>1</SplitHorizontal>
   <TopRowBottomPane>1</TopRowBottomPane>
   <ActivePane>2</ActivePane>
   <ProtectObjects>False</ProtectObjects>
   <ProtectScenarios>False</ProtectScenarios>
  </WorksheetOptions>
 </Worksheet>`;
}

function generateColoredExcelXml() {
  const orders = getExportOrders();
  const rows = buildExportRows(orders);
  if (rows.length === 0) return '';
  const productSummary = buildProductQuantitySummary(orders);
  const summaryRows = buildSummarySheetRows(orders, productSummary);
  const orderRows = buildOrdersSheetRows(orders);
  const productRows = productSummary.map((row) => ({
    'Product Name': row.name || '',
    'SKU/Variant': row.sku || '',
    'Qty Ordered': row.qtyOrdered || 0,
    'Qty Refunded': row.qtyRefunded || 0,
    'Qty Sold': row.qtySold || 0,
    'Sales Subtotal (Rp)': row.salesSubtotal || 0,
    'Order Count': row.orderCount || 0
  }));
  const feeRows = buildFeesSheetRows(orders);
  const refundRows = buildRefundsSheetRows(orders);

  const worksheets = [
    buildWorksheetXml({
      name: 'Summary',
      headers: SUMMARY_HEADERS,
      rows: summaryRows,
      columnConfig: SUMMARY_COLUMN_CONFIG
    }),
    buildWorksheetXml({
      name: 'Orders',
      headers: ORDERS_SHEET_HEADERS,
      rows: orderRows,
      columnConfig: ORDERS_COLUMN_CONFIG
    }),
    buildWorksheetXml({
      name: 'Order Lines',
      headers: EXPORT_HEADERS,
      rows,
      columnConfig: ORDER_LINE_COLUMN_CONFIG,
      groupField: '__groupKey'
    }),
    buildWorksheetXml({
      name: 'Products',
      headers: PRODUCTS_SHEET_HEADERS,
      rows: productRows,
      columnConfig: PRODUCTS_COLUMN_CONFIG
    }),
    buildWorksheetXml({
      name: 'Fees',
      headers: FEES_SHEET_HEADERS,
      rows: feeRows,
      columnConfig: FEES_COLUMN_CONFIG
    }),
    buildWorksheetXml({
      name: 'Refunds',
      headers: REFUNDS_SHEET_HEADERS,
      rows: refundRows,
      columnConfig: REFUNDS_COLUMN_CONFIG
    })
  ].join('\n');

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
${EXCEL_BASE_STYLES}
 </Styles>
 ${worksheets}
</Workbook>`;
}

function syncMonitorAlarm() {
  if (monitorEnabled) {
    ensureAlarm('shopeeMonitorTick', MONITOR_ALARM_INTERVAL_MINUTES, 20000);
    return;
  }
  chrome.alarms.clear('shopeeMonitorTick');
}

function ensureAlarm(name, periodInMinutes, delayMs) {
  chrome.alarms.get(name, (alarm) => {
    if (alarm) return;
    chrome.alarms.create(name, {
      periodInMinutes,
      when: Date.now() + delayMs
    });
  });
}

async function waitForCurrentSync() {
  if (!syncPromise) return;
  try {
    await syncPromise;
  } catch (error) {
    // Ignore here; caller should handle fresh sync outcome.
  }
}

async function performScheduledSync(trigger = 'unknown') {
  if (syncPromise) {
    return syncPromise;
  }

  const run = (async () => {
    syncInFlight = true;

    try {
      const hasSession = await hasSellerSession();
      if (!hasSession) {
        console.warn('[Shopee Exporter] Skipping sync - no seller session cookie found');
        return;
      }
      await tryPullSync();
    } catch (error) {
      console.warn(`[Shopee Exporter] Pull sync failed (${trigger})`, error);
      chrome.storage.local.set({
        lastSyncMeta: {
          ts: Date.now(),
          method: 'pull',
          profileEmail: profileInfo.email || '',
          successfulGroups: 0,
          reason: String(error?.message || error || 'pull_failed')
        }
      });
    } finally {
      syncInFlight = false;
    }
  })();

  syncPromise = run;
  try {
    await run;
  } finally {
    if (syncPromise === run) {
      syncPromise = null;
    }
  }
}

function hasSellerSession() {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: 'https://seller.shopee.co.id/', name: 'SPC_EC' }, (cookie) => {
      resolve(Boolean(cookie));
    });
  });
}

async function runMonitorTick(trigger = 'unknown') {
  if (monitorTickInFlight) {
    return;
  }
  monitorTickInFlight = true;

  try {
    if (warmupTabId !== null) {
      return;
    }

    const hasSession = await hasSellerSession();
    if (!hasSession) {
      await closeMonitorTab();
      chrome.storage.local.set({
        monitorMeta: {
          ts: Date.now(),
          status: 'idle_no_session',
          trigger
        }
      });
      return;
    }

    const tabId = await ensureMonitorTab();
    if (typeof tabId !== 'number') {
      return;
    }

    const nextUrl = nextMonitorUrl();
    await updateTabUrl(tabId, nextUrl);
    await waitForTabComplete(tabId, 15000);
    await sleep(1500);

    chrome.storage.local.set({
      monitorMeta: {
        ts: Date.now(),
        status: 'running',
        trigger,
        tabId,
        lastUrl: nextUrl
      }
    });
  } finally {
    monitorTickInFlight = false;
  }
}

async function ensureMonitorTab() {
  if (typeof monitorTabId === 'number') {
    const existing = await getTabById(monitorTabId);
    if (existing) {
      return monitorTabId;
    }
    monitorTabId = null;
  }

  const firstUrl = nextMonitorUrl();
  const tab = await createHiddenTab(firstUrl);
  if (!tab || typeof tab.id !== 'number') {
    return null;
  }

  monitorTabId = tab.id;
  console.log(`[Shopee Exporter] Monitor tab opened: ${firstUrl}`);
  await waitForTabComplete(tab.id, 15000);
  await sleep(1200);
  return tab.id;
}

function nextMonitorUrl() {
  const url = MONITOR_URLS[monitorUrlIndex % MONITOR_URLS.length];
  monitorUrlIndex += 1;
  return url;
}

function nextMonitorUrlPreview() {
  return MONITOR_URLS[monitorUrlIndex % MONITOR_URLS.length];
}

async function tryPullSync() {
  let successCount = 0;
  for (const group of SYNC_ENDPOINT_GROUPS) {
    if (disabledSyncGroups.has(group.name)) {
      continue;
    }
    const ok = await fetchEndpointGroup(group);
    if (ok) {
      successCount += 1;
    }
  }

  if (successCount === 0) {
    throw new Error('No sync endpoints returned usable payloads');
  }

  let hydratedOrderComponents = 0;
  try {
    hydratedOrderComponents = await hydrateOrderIncomeComponents(ORDER_COMPONENTS_FETCH_LIMIT);
  } catch (error) {
    console.warn('[Shopee Exporter] Failed to hydrate order income components', error);
  }

  chrome.storage.local.set({
    lastSyncMeta: {
      ts: Date.now(),
      method: 'pull',
      profileEmail: profileInfo.email || '',
      successfulGroups: successCount,
      hydratedOrderComponents
    }
  });
}

function collectRecentNumericOrders(limit = ORDER_COMPONENTS_FETCH_LIMIT) {
  const incomplete = [];
  const complete = [];
  for (const order of Object.values(capturedOrders)) {
    if (!order || typeof order !== 'object') continue;
    const id = normalizeEntityIdValue(order.order_id, { allowAlpha: false, minLength: 6, maxLength: 20 });
    if (!id) continue;
    const orderSn = normalizeEntityIdValue(
      firstPresent(order.order_sn, order.orderSn, order.ordersn),
      { allowAlpha: true, minLength: 6, maxLength: 40 }
    );
    const status = toNumberOrNull(order.order_status);
    const row = {
      id,
      orderSn: orderSn || '',
      status: status === null ? null : status
    };

    if (isOrderHydrated(order)) {
      complete.push(row);
    } else {
      incomplete.push(row);
    }
  }

  const deduped = new Map();
  for (const row of incomplete.concat(complete)) {
    deduped.set(row.id, row);
  }
  return Array.from(deduped.values()).slice(0, limit);
}

function buildOrderIncomeComponentBodies(orderMeta) {
  const idNum = Number(orderMeta.id);
  const variants = [];

  const withComponents = (baseBody, components) => {
    const cloned = JSON.parse(JSON.stringify(baseBody || {}));
    setIfExistsDeep(cloned, ['components', 'component_ids', 'componentIds'], components);
    if (!hasAnyKeyDeep(cloned, ['components', 'component_ids', 'componentIds'])) {
      cloned.components = components;
    }
    return cloned;
  };

  const pushWithDefaultComponentSets = (baseBody) => {
    variants.push(withComponents(baseBody, [2, 3, 4]));
    variants.push(withComponents(baseBody, [5]));
    variants.push(withComponents(baseBody, [2, 3, 4, 5]));
  };

  const template = requestTemplates.order_income_components_body;
  if (template && typeof template === 'object' && Object.keys(template).length > 0) {
    const cloned = JSON.parse(JSON.stringify(template));
    setIfExistsDeep(cloned, ['order_id', 'orderId', 'id'], idNum);
    if (!hasAnyKeyDeep(cloned, ['order_id', 'orderId', 'id'])) {
      cloned.order_id = idNum;
    }
    pushWithDefaultComponentSets(cloned);
  }

  pushWithDefaultComponentSets({ order_id: idNum });

  const unique = [];
  const seen = new Set();
  for (const body of variants) {
    if (!body || typeof body !== 'object') continue;
    const key = JSON.stringify(body);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(body);
  }
  return unique;
}

async function hydrateOrderIncomeComponents(limit = ORDER_COMPONENTS_FETCH_LIMIT) {
  const orders = collectRecentNumericOrders(limit);
  if (orders.length === 0) {
    return 0;
  }

  const sellerCds = await getSellerCdsToken();
  const csrfToken = await getCookieValue('csrftoken');
  const endpoint = withSellerCdsParams(ORDER_INCOME_COMPONENTS_URL, sellerCds);
  let successCount = 0;

  for (const orderMeta of orders) {
    const bodies = buildOrderIncomeComponentBodies(orderMeta);
    let processedAny = false;
    let foundBreakdown = false;
    let foundAdjustment = false;

    for (let idx = 0; idx < bodies.length; idx += 1) {
      const body = bodies[idx];
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            ...buildForwardedInvoiceHeaders(),
            ...(csrfToken ? { 'x-csrftoken': csrfToken } : {})
          },
          body: JSON.stringify(body)
        });

        console.log(`[Shopee Exporter] order_income_components ${orderMeta.id} [body#${idx + 1}] -> ${response.status}`);
        if (!response.ok) {
          continue;
        }

        const payload = await response.json();
        if (!payload || typeof payload !== 'object') {
          continue;
        }
        if ((payload.code !== undefined && payload.code !== 0) || (payload.error !== undefined && payload.error !== 0)) {
          continue;
        }

        const hasData = payload.data && typeof payload.data === 'object';
        if (!hasData) {
          continue;
        }

        const hasBreakdown = Array.isArray(payload.data?.seller_income_breakdown?.breakdown)
          && payload.data.seller_income_breakdown.breakdown.length > 0;
        const hasAdjustment = payload.data?.adjustment_info
          && typeof payload.data.adjustment_info === 'object';
        const hasItems = Array.isArray(payload.data?.order_item_list?.order_items)
          && payload.data.order_item_list.order_items.length > 0;

        if (hasBreakdown || hasAdjustment || hasItems) {
          handleInterceptedData({ url: endpoint, body: payload });
          processedAny = true;
        }
        if (hasBreakdown) {
          foundBreakdown = true;
        }
        if (hasAdjustment) {
          foundAdjustment = true;
        }
        if (foundBreakdown && foundAdjustment) {
          break;
        }
      } catch (error) {
        console.warn(`[Shopee Exporter] order income components fetch failed order=${orderMeta.id} body#${idx + 1}`, error);
      }
    }

    if (processedAny) {
      successCount += 1;
      if (!foundBreakdown) {
        console.warn(`[Shopee Exporter] order_income_components ${orderMeta.id} returned no seller_income_breakdown`);
      }
    } else {
      console.warn(`[Shopee Exporter] order_income_components ${orderMeta.id} returned no usable payload`);
    }
  }

  return successCount;
}

async function fetchEndpointGroup(group) {
  const init = group.buildInit ? group.buildInit() : (group.init || {});
  if (!init) {
    console.log(`[Shopee Exporter] Skipping ${group.name} - no request template yet`);
    return false;
  }
  const { headers: initHeaders, ...restInit } = init;
  const csrfToken = await getCookieValue('csrftoken');
  const sellerCds = await getSellerCdsToken();
  const requestBodies = buildRequestBodiesForGroup(group, restInit.body, restInit.method);
  let sawUnauthorized = false;
  let all404 = true;

  for (const rawUrl of buildGroupCandidates(group)) {
    const requestUrl = withSellerCdsParams(rawUrl, sellerCds);
    for (let i = 0; i < requestBodies.length; i += 1) {
      const body = requestBodies[i];
      const forwardedHeaders = (
        group.name === 'invoice_list' ||
        group.name === 'income_report_list' ||
        group.name === 'income_detail_list'
      )
        ? buildForwardedInvoiceHeaders()
        : {};
      const response = await fetch(requestUrl, {
        credentials: 'include',
        ...restInit,
        ...(typeof body === 'string' ? { body } : {}),
        headers: {
          'content-type': 'application/json',
          ...(initHeaders || {}),
          ...forwardedHeaders,
          ...(csrfToken ? { 'x-csrftoken': csrfToken } : {})
        }
      });

      const variantLabel = requestBodies.length > 1 ? ` [body#${i + 1}]` : '';
      console.log(`[Shopee Exporter] ${group.name}${variantLabel} ${requestUrl} -> ${response.status}`);

      if (response.status === 404) {
        continue;
      }
      all404 = false;

      if (response.status === 401 || response.status === 403) {
        sawUnauthorized = true;
        continue;
      }

      if (!response.ok) {
        continue;
      }

      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        console.warn(`[Shopee Exporter] Invalid JSON from ${requestUrl}`, error);
        continue;
      }

      if (!parsed || typeof parsed !== 'object') {
        continue;
      }

      const hasDataEnvelope = Object.prototype.hasOwnProperty.call(parsed, 'data');
      const isArrayPayload = Array.isArray(parsed);
      const hasCodeZero = parsed.code === 0;
      const hasErrorZero = parsed.error === 0;
      const hasEntityRows = extractListFromData(parsed).length > 0;

      // Accept legacy and new envelopes: data wrapper, root list rows, or explicit success code.
      if (!hasDataEnvelope && !isArrayPayload && !hasCodeZero && !hasErrorZero && !hasEntityRows) {
        continue;
      }

      const entityList = extractListFromData(parsed?.data || parsed);
      if ((group.name === 'invoice_list' || group.name === 'income_detail_list') && entityList.length === 0) {
        const shape = summarizeResponseShape(parsed);
        if (shape) {
          console.warn(`[Shopee Exporter] ${group.name} body#${i + 1} response shape: ${shape}`);
        }
        console.warn(`[Shopee Exporter] ${group.name} body#${i + 1} returned no rows`);
        continue;
      }

      handleInterceptedData({ url: requestUrl, body: parsed });
      return true;
    }
  }

  if (group.name === 'invoice_list' || group.name === 'income_detail_list') {
    console.warn(`[Shopee Exporter] ${group.name} exhausted all payload variants with no rows`);
  }

  if (all404) {
    const streak = (syncGroup404Streaks.get(group.name) || 0) + 1;
    syncGroup404Streaks.set(group.name, streak);
    if (streak >= 3) {
      disabledSyncGroups.add(group.name);
      console.warn(`[Shopee Exporter] Disabled sync group "${group.name}" after repeated 404`);
    } else {
      console.warn(`[Shopee Exporter] ${group.name} returned 404 (streak ${streak}/3)`);
    }
  } else {
    syncGroup404Streaks.delete(group.name);
  }

  if (sawUnauthorized) {
    throw new Error(`Unauthorized for ${group.name}`);
  }

  return false;
}

function getCookieValue(name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: 'https://seller.shopee.co.id/', name }, (cookie) => {
      resolve(cookie ? cookie.value : '');
    });
  });
}

async function getSellerCdsToken() {
  return getCookieValue('SPC_CDS');
}

function withSellerCdsParams(rawUrl, sellerCds) {
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('SPC_CDS_VER')) {
      url.searchParams.set('SPC_CDS_VER', SELLER_CDS_VER);
    }
    if (sellerCds && !url.searchParams.has('SPC_CDS')) {
      url.searchParams.set('SPC_CDS', sellerCds);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function buildGroupCandidates(group) {
  const base = Array.isArray(group?.candidates) ? [...group.candidates] : [];
  if (!group || group.name !== 'income_detail_list') {
    return base;
  }

  const candidate = requestTemplates.income_detail_list_url;
  if (candidate && typeof candidate === 'string') {
    base.unshift(candidate);
  }

  const unique = [];
  const seen = new Set();
  for (const raw of base) {
    if (!raw) continue;
    const key = String(raw).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

function buildInvoiceListPayload() {
  if (
    requestTemplates.invoice_list_body &&
    typeof requestTemplates.invoice_list_body === 'object' &&
    Object.keys(requestTemplates.invoice_list_body).length > 0
  ) {
    return normalizeInvoiceListPayload(requestTemplates.invoice_list_body);
  }

  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - (86400 * SYNC_LOOKBACK_DAYS);
  return {
    page_number: 1,
    page_size: 100,
    type: 2,
    time_from: timeFrom,
    time_to: now,
    start_time: timeFrom,
    end_time: now
  };
}

function buildIncomeReportListPayload() {
  if (
    requestTemplates.income_report_list_body &&
    typeof requestTemplates.income_report_list_body === 'object' &&
    Object.keys(requestTemplates.income_report_list_body).length > 0
  ) {
    return normalizeIncomeReportListPayload(requestTemplates.income_report_list_body);
  }

  return {};
}

function buildIncomeDetailPayload() {
  if (
    requestTemplates.income_detail_list_body &&
    typeof requestTemplates.income_detail_list_body === 'object' &&
    Object.keys(requestTemplates.income_detail_list_body).length > 0
  ) {
    return normalizeIncomeDetailPayload(requestTemplates.income_detail_list_body);
  }

  return {};
}

function buildRequestBodiesForGroup(group, rawBody, method) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
    return [undefined];
  }

  if (group.name === 'income_detail_list') {
    return buildPayloadVariants(rawBody, normalizeIncomeDetailPayload, []);
  }

  if (group.name === 'income_report_list') {
    return buildPayloadVariants(rawBody, normalizeIncomeReportListPayload, [{}]);
  }

  if (group.name !== 'invoice_list') {
    return [rawBody];
  }

  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - (86400 * SYNC_LOOKBACK_DAYS);
  const variants = [];

  const parsed = parseJsonSafe(rawBody);
  if (parsed && typeof parsed === 'object') {
    variants.push(parsed);

    const withRecentRange = normalizeInvoiceListPayload(parsed);
    variants.push(withRecentRange);

    const withTypeZero = { ...withRecentRange, type: 0 };
    variants.push(withTypeZero);
  }

  variants.push({
    page_number: 1,
    page_size: 100,
    type: 2,
    time_from: timeFrom,
    time_to: now,
    start_time: timeFrom,
    end_time: now
  });

  variants.push({
    page_number: 1,
    page_size: 100,
    type: 0,
    time_from: timeFrom,
    time_to: now,
    start_time: timeFrom,
    end_time: now
  });

  const unique = [];
  const seen = new Set();
  for (const payload of variants) {
    if (!payload || typeof payload !== 'object') continue;
    const serialized = JSON.stringify(payload);
    if (seen.has(serialized)) continue;
    seen.add(serialized);
    unique.push(serialized);
  }

  return unique.length > 0 ? unique : [rawBody];
}

function buildPayloadVariants(rawBody, normalizeFn, fallbackPayloads) {
  const variants = [];
  const parsed = parseJsonSafe(rawBody);
  if (parsed && typeof parsed === 'object') {
    variants.push(parsed);
    variants.push(normalizeFn(parsed));
  }

  for (const fallback of fallbackPayloads || []) {
    variants.push(fallback);
  }

  const unique = [];
  const seen = new Set();
  for (const payload of variants) {
    if (!payload || typeof payload !== 'object') continue;
    const serialized = JSON.stringify(payload);
    if (seen.has(serialized)) continue;
    seen.add(serialized);
    unique.push(serialized);
  }

  return unique.length > 0 ? unique : [rawBody];
}

function normalizeInvoiceListPayload(payload) {
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - (86400 * SYNC_LOOKBACK_DAYS);
  const clone = JSON.parse(JSON.stringify(payload));

  setIfExistsDeep(clone, ['page_number', 'pageNumber', 'page'], 1);
  setIfExistsDeep(clone, ['page_size', 'pageSize', 'limit'], 100);
  setIfExistsDeep(clone, ['offset'], 0);
  setIfExistsDeep(clone, ['time_from', 'timeFrom', 'start_time', 'startTime', 'from_time', 'fromTime'], timeFrom);
  setIfExistsDeep(clone, ['time_to', 'timeTo', 'end_time', 'endTime', 'to_time', 'toTime'], now);

  return clone;
}

function normalizeIncomeReportListPayload(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  setIfExistsDeep(clone, ['page_number', 'pageNumber', 'page_no', 'pageNo', 'page'], 1);
  setIfExistsDeep(clone, ['page_size', 'pageSize', 'size', 'limit'], 100);
  setIfExistsDeep(clone, ['offset'], 0);
  return clone;
}

function normalizeIncomeDetailPayload(payload) {
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - (86400 * SYNC_LOOKBACK_DAYS);
  const clone = JSON.parse(JSON.stringify(payload));
  setIfExistsDeep(clone, ['page_number', 'pageNumber', 'page_no', 'pageNo', 'page'], 1);
  setIfExistsDeep(clone, ['page_size', 'pageSize', 'size', 'limit'], 100);
  setIfExistsDeep(clone, ['offset'], 0);
  setIfExistsDeep(clone, ['time_from', 'timeFrom', 'start_time', 'startTime', 'from_time', 'fromTime'], timeFrom);
  setIfExistsDeep(clone, ['time_to', 'timeTo', 'end_time', 'endTime', 'to_time', 'toTime'], now);
  return clone;
}

function setIfExistsDeep(node, keys, value, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      node[key] = value;
    }
  }
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') {
      setIfExistsDeep(child, keys, value, depth + 1);
    }
  }
}

function summarizeResponseShape(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const rootKeys = Object.keys(payload);
  const data = payload.data;
  if (!data || typeof data !== 'object') {
    const rootSized = rootKeys.map((key) => {
      const value = payload[key];
      if (Array.isArray(value)) return `${key}[${value.length}]`;
      if (value && typeof value === 'object') return `${key}{${Object.keys(value).length}}`;
      return `${key}:${typeof value}`;
    });
    return `root_keys=${rootKeys.join('|') || 'none'} data=missing root_shape=${rootSized.join(',') || 'none'}`;
  }

  const dataKeys = Object.keys(data);
  const sized = dataKeys.map((key) => {
    const value = data[key];
    if (Array.isArray(value)) return `${key}[${value.length}]`;
    if (value && typeof value === 'object') return `${key}{${Object.keys(value).length}}`;
    return `${key}:${typeof value}`;
  });
  return `root_keys=${rootKeys.join('|') || 'none'} data_keys=${sized.join(',') || 'none'}`;
}

function buildForwardedInvoiceHeaders() {
  const headers = {};
  const templateHeaders = requestTemplates.invoice_list_headers;
  if (templateHeaders && typeof templateHeaders === 'object') {
    for (const name of FORWARDED_INVOICE_HEADERS) {
      const value = templateHeaders[name];
      if (!value) continue;
      headers[name] = value;
    }
  }

  if (!headers.referer) {
    headers.referer = INCOME_LIST_URL;
  }
  if (!headers.origin) {
    headers.origin = 'https://seller.shopee.co.id';
  }
  if (!headers['accept-language']) {
    headers['accept-language'] = 'id-ID,id;q=0.9,en;q=0.8';
  }
  if (!headers['x-requested-with']) {
    headers['x-requested-with'] = 'XMLHttpRequest';
  }

  return headers;
}

async function runHiddenIncomeSync() {
  if (warmupTabId !== null) {
    return;
  }

  const tab = await createHiddenTab(INCOME_LIST_URL);
  if (!tab || typeof tab.id !== 'number') {
    return;
  }

  warmupTabId = tab.id;
  console.log(`[Shopee Exporter] Hidden income sync opened: ${INCOME_LIST_URL}`);

  try {
    await waitForTabComplete(tab.id, 15000);
    await sleep(HIDDEN_PAGE_SETTLE_MS);

    const discoveredLinks = await requestIncomeInvoiceLinks(tab.id);
    const discoveredIds = extractIncomeIdsFromLinks(discoveredLinks);
    const apiIds = await fetchIncomeInvoiceIdsFromApi(HIDDEN_INVOICE_VISIT_LIMIT);
    const cachedIds = collectIncomeInvoiceIdsFromCapturedOrders(HIDDEN_INVOICE_VISIT_LIMIT);
    const ids = mergeUniqueValues(discoveredIds, apiIds, cachedIds).slice(0, HIDDEN_INVOICE_VISIT_LIMIT);

    console.log(
      `[Shopee Exporter] Income link sources page=${discoveredIds.length} api=${apiIds.length} cached=${cachedIds.length}`
    );

    let fetchedDetails = 0;
    if (ids.length > 0) {
      fetchedDetails = await fetchIncomeDetailsByIds(ids);
    }

    let visitedInvoices = 0;
    // DOM links are trusted; only navigate those if API detail fetch did not yield data.
    if (fetchedDetails === 0 && discoveredLinks.length > 0) {
      const linksToVisit = discoveredLinks.slice(0, HIDDEN_INVOICE_VISIT_LIMIT);
      console.log(`[Shopee Exporter] Visiting ${linksToVisit.length} income invoices from page links`);
      for (const url of linksToVisit) {
        await updateTabUrl(tab.id, url);
        await waitForTabComplete(tab.id, 15000);
        await sleep(HIDDEN_PAGE_SETTLE_MS);
      }
      visitedInvoices = linksToVisit.length;
    }

    if (fetchedDetails === 0 && visitedInvoices === 0) {
      console.warn('[Shopee Exporter] No invoice links found on income page');
      chrome.storage.local.set({
        lastSyncMeta: {
          ts: Date.now(),
          method: 'hidden',
          profileEmail: profileInfo.email || '',
          visitedInvoices: 0,
          fetchedDetails: 0,
          reason: 'no_links'
        }
      });
      return;
    }
    chrome.storage.local.set({
      lastSyncMeta: {
        ts: Date.now(),
        method: 'hidden',
        profileEmail: profileInfo.email || '',
        visitedInvoices,
        fetchedDetails
      }
    });
  } finally {
    await closeWarmupTab();
  }
}

function createHiddenTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        console.warn('[Shopee Exporter] Failed to open hidden tab', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError || !Array.isArray(tabs)) {
        resolve([]);
        return;
      }
      resolve(tabs);
    });
  });
}

function isSellerTab(tab) {
  return Boolean(tab && typeof tab.id === 'number' && typeof tab.url === 'string' && tab.url.startsWith('https://seller.shopee.co.id/'));
}

function isFinanceIncomeTab(tab) {
  return Boolean(isSellerTab(tab) && typeof tab.url === 'string' && tab.url.includes('/portal/finance/income'));
}

async function findSellerTabForRefresh() {
  const activeTabs = await queryTabs({ active: true, currentWindow: true });
  const activeFinanceTab = activeTabs.find(isFinanceIncomeTab);
  if (activeFinanceTab) {
    return activeFinanceTab;
  }
  const activeSellerTab = activeTabs.find(isSellerTab);
  if (activeSellerTab) {
    return activeSellerTab;
  }

  const currentWindowTabs = await queryTabs({ currentWindow: true });
  const financeTab = currentWindowTabs.find(isFinanceIncomeTab);
  if (financeTab) {
    return financeTab;
  }
  const anySellerTab = currentWindowTabs.find(isSellerTab);
  return anySellerTab || null;
}

function reloadTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.reload(tabId, { bypassCache: true }, () => {
      if (chrome.runtime.lastError) {
        console.warn(`[Shopee Exporter] Failed to reload tab ${tabId}`, chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

async function refreshSellerTabBeforeSync() {
  const tab = await findSellerTabForRefresh();
  if (!tab) {
    return false;
  }

  console.log(`[Shopee Exporter] Refreshing seller tab before sync: ${tab.url}`);
  await reloadTab(tab.id);
  await waitForTabComplete(tab.id, 20000);
  await sleep(2500);
  return true;
}

function updateTabUrl(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        console.warn(`[Shopee Exporter] Failed to navigate hidden tab: ${url}`, chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

function getTabById(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });
}

function waitForTabComplete(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    function tick() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          resolve();
          return;
        }
        if (tab.status === 'complete') {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          resolve();
          return;
        }
        setTimeout(tick, 400);
      });
    }

    tick();
  });
}

function requestIncomeInvoiceLinks(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'COLLECT_INCOME_LINKS', timeoutMs: 12000 }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Shopee Exporter] Could not collect income links', chrome.runtime.lastError.message);
        resolve([]);
        return;
      }
      resolve(Array.isArray(response?.links) ? response.links : []);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectIncomeInvoiceIdsFromCapturedOrders(limit) {
  const ids = [];
  for (const order of Object.values(capturedOrders)) {
    const id = pickIncomeInvoiceId(order);
    if (/^\d{12,20}$/.test(id)) {
      ids.push(id);
    }
  }

  return Array.from(new Set(ids)).slice(-limit);
}

function mergeUniqueValues(...batches) {
  const merged = [];
  for (const batch of batches) {
    merged.push(...(batch || []));
  }
  const unique = [];
  const seen = new Set();

  for (const value of merged) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }

  return unique;
}

function extractIncomeIdsFromLinks(links) {
  const ids = [];
  for (const value of links || []) {
    const id = String(value || '').match(/\/portal\/finance\/income\/(\d+)/)?.[1];
    if (id) {
      ids.push(id);
    }
  }
  return Array.from(new Set(ids));
}

async function fetchIncomeInvoiceIdsFromApi(limit) {
  const groups = SYNC_ENDPOINT_GROUPS.filter((candidate) =>
    candidate.name === 'invoice_list' ||
    candidate.name === 'income_overviews' ||
    candidate.name === 'income_report_list' ||
    candidate.name === 'income_detail_list'
  );
  if (groups.length === 0) return [];

  const csrfToken = await getCookieValue('csrftoken');
  const sellerCds = await getSellerCdsToken();

  for (const group of groups) {
    const init = group.buildInit ? group.buildInit() : (group.init || {});
    if (!init) {
      continue;
    }
    const { headers: initHeaders, ...restInit } = init;

    for (const rawUrl of buildGroupCandidates(group)) {
      const requestUrl = withSellerCdsParams(rawUrl, sellerCds);
      try {
        const response = await fetch(requestUrl, {
          credentials: 'include',
          ...restInit,
          headers: {
            'content-type': 'application/json',
            ...(initHeaders || {}),
            ...((group.name === 'invoice_list' || group.name === 'income_report_list' || group.name === 'income_detail_list')
              ? buildForwardedInvoiceHeaders()
              : {}),
            ...(csrfToken ? { 'x-csrftoken': csrfToken } : {})
          }
        });

        console.log(`[Shopee Exporter] income-id api ${requestUrl} -> ${response.status}`);
        if (!response.ok) {
          continue;
        }

        const payload = await response.json();
        if (payload && typeof payload === 'object' && payload.error && payload.error !== 0) {
          console.warn(`[Shopee Exporter] income-id api error from ${requestUrl}: ${payload.error}`);
        }
        const list = extractListFromData(payload?.data || payload);
        const ids = list
          .map((item) => pickIncomeInvoiceId(item, true))
          .filter(Boolean);
        const uniqueIds = Array.from(new Set(ids)).slice(-limit);

        if (uniqueIds.length > 0) {
          return uniqueIds;
        }
      } catch (error) {
        console.warn(`[Shopee Exporter] Failed to fetch income IDs from ${requestUrl}`, error);
      }
    }
  }

  return [];
}

async function fetchIncomeDetailsByIds(ids) {
  const csrfToken = await getCookieValue('csrftoken');
  let successCount = 0;

  for (const id of ids) {
    const ok = await fetchIncomeDetailById(id, csrfToken);
    if (ok) {
      successCount += 1;
    }
  }

  console.log(`[Shopee Exporter] Income detail API fetched ${successCount}/${ids.length}`);
  return successCount;
}

async function fetchIncomeDetailById(id, csrfToken) {
  const value = String(id || '').trim();
  if (!/^\d{12,20}$/.test(value)) {
    return false;
  }
  const sellerCds = await getSellerCdsToken();

  for (const rawEndpoint of INCOME_DETAIL_ENDPOINTS) {
    const endpoint = withSellerCdsParams(rawEndpoint, sellerCds);
    for (const buildBody of INCOME_DETAIL_BODY_BUILDERS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            ...(csrfToken ? { 'x-csrftoken': csrfToken } : {})
          },
          body: JSON.stringify(buildBody(value))
        });

        if (response.status === 404 || response.status === 400) {
          continue;
        }

        if (!response.ok) {
          continue;
        }

        const payload = await response.json();
        if (!payload || typeof payload !== 'object') {
          continue;
        }

        if (payload.error && payload.error !== 0) {
          continue;
        }

        if (!payload.data) {
          continue;
        }
        if (payload.data && typeof payload.data === 'object') {
          if (!pickOrderId(payload.data)) {
            if (!payload.data.income_id) payload.data.income_id = value;
            if (!payload.data.invoice_id) payload.data.invoice_id = value;
          }

          const list = Array.isArray(payload.data.list) ? payload.data.list : [];
          for (const row of list) {
            if (!row || typeof row !== 'object') continue;
            if (pickOrderId(row)) continue;
            if (!row.income_id) row.income_id = value;
            if (!row.invoice_id) row.invoice_id = value;
          }
        }

        handleInterceptedData({ url: endpoint, body: payload });
        return true;
      } catch (error) {
        console.warn(`[Shopee Exporter] income detail fetch failed id=${value} endpoint=${endpoint}`, error);
      }
    }
  }

  return false;
}

function closeWarmupTab() {
  return new Promise((resolve) => {
    if (warmupTabId === null) {
      resolve();
      return;
    }

    const tabId = warmupTabId;
    warmupTabId = null;
    chrome.tabs.remove(tabId, () => {
      resolve();
    });
  });
}

function closeMonitorTab() {
  return new Promise((resolve) => {
    if (monitorTabId === null) {
      resolve();
      return;
    }

    const tabId = monitorTabId;
    monitorTabId = null;
    chrome.tabs.remove(tabId, () => {
      resolve();
    });
  });
}
