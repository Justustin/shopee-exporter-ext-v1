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
  if (message?.type !== 'COLLECT_INCOME_LINKS') {
    return;
  }

  collectIncomeLinkData(message.timeoutMs || 12000)
    .then((payload) => sendResponse(payload))
    .catch(() => sendResponse({ links: [] }));

  return true;
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
