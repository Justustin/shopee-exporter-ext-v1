// Content script: injects interceptor and forwards captured data to background.
// Always-on — no start/stop toggle needed.

// Listen for intercepted data from page script
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === 'SHOPEE_API_CAPTURED') {
    chrome.runtime.sendMessage({
      type: 'API_INTERCEPTED',
      data: event.data.payload
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'COLLECT_INCOME_LINKS') {
    collectIncomeLinkData(message.timeoutMs || 12000)
      .then((payload) => sendResponse(payload))
      .catch(() => sendResponse({ links: [] }));

    return true;
  }

  if (message?.type === 'GET_STORE_CONTEXT') {
    try {
      sendResponse(extractStoreContextFromDom());
    } catch {
      sendResponse({ storeKey: '', storeName: '', source: '' });
    }
    return true;
  }

  return;
});

// Inject the interceptor script into the page context
const script = document.createElement('script');
script.src = chrome.runtime.getURL('interceptor.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

function collectIncomeLinkData(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    function tick() {
      const payload = extractIncomeLinkDataFromDom();
      if (payload.links.length > 0 || Date.now() >= deadline) {
        resolve(payload);
        return;
      }
      setTimeout(tick, 500);
    }

    tick();
  });
}

function extractIncomeLinkDataFromDom() {
  const found = new Set();
  const anchorLinks = document.querySelectorAll('a[href*="/portal/finance/income/"]');

  for (const anchor of anchorLinks) {
    const href = anchor.getAttribute('href');
    const normalized = normalizeIncomeDetailUrl(href);
    if (normalized) {
      found.add(normalized);
    }
  }

  if (found.size === 0 && document.body) {
    const matches = document.body.innerHTML.match(/\/portal\/finance\/income\/\d+/g) || [];
    for (const path of matches) {
      const normalized = normalizeIncomeDetailUrl(path);
      if (normalized) {
        found.add(normalized);
      }
    }
  }

  return {
    links: Array.from(found)
  };
}

function normalizeIncomeDetailUrl(href) {
  if (!href) return '';
  try {
    const url = new URL(href, window.location.origin);
    if (!/\/portal\/finance\/income\/\d+$/.test(url.pathname)) {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

function extractStoreContextFromDom() {
  const html = document.documentElement?.innerHTML || '';
  const title = document.title || '';
  const scriptText = Array.from(document.scripts || [])
    .map((script) => script.textContent || '')
    .join('\n');
  const haystack = `${scriptText}\n${html}`.slice(0, 1500000);

  const shopId = matchFirst(haystack, [
    /"shop_id"\s*:\s*"?(\d{5,20})"?/i,
    /"shopId"\s*:\s*"?(\d{5,20})"?/i,
    /"main_shop_id"\s*:\s*"?(\d{5,20})"?/i,
    /"shopid"\s*:\s*"?(\d{5,20})"?/i
  ]);

  const shopName = cleanupStoreName(matchFirst(haystack, [
    /"shop_name"\s*:\s*"([^"]{1,200})"/i,
    /"shopName"\s*:\s*"([^"]{1,200})"/i,
    /"seller_name"\s*:\s*"([^"]{1,200})"/i,
    /"sellerName"\s*:\s*"([^"]{1,200})"/i
  ])) || cleanupStoreName(extractStoreNameFromTitle(title));

  if (shopId) {
    return {
      storeKey: `shop:${shopId}`,
      storeName: shopName || '',
      source: 'shop_id'
    };
  }

  if (shopName) {
    return {
      storeKey: `name:${normalizeStoreNameKey(shopName)}`,
      storeName: shopName,
      source: 'shop_name'
    };
  }

  return { storeKey: '', storeName: '', source: '' };
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      return decodeJsonText(match[1]);
    }
  }
  return '';
}

function decodeJsonText(value) {
  return String(value || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u002f/g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function extractStoreNameFromTitle(title) {
  const cleaned = String(title || '').trim();
  if (!cleaned) return '';
  const parts = cleaned.split('|').map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    if (/shopee seller/i.test(part)) continue;
    if (/seller centre|seller center/i.test(part)) continue;
    return part;
  }
  return cleaned;
}

function cleanupStoreName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStoreNameKey(value) {
  return cleanupStoreName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
