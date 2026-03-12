// This script runs in the PAGE context (not extension context).
// It monkey-patches fetch and XMLHttpRequest to capture Shopee API responses.
// Always-on: captures immediately, no toggle needed.

(function() {
  'use strict';

  // URL patterns we want to capture
  const API_PATTERNS = [
    '/api/v3/finance/',
    '/api/v3/order/',
    '/api/v4/finance/',
    '/api/v4/order/',
    '/api/v4/accounting/pc/seller_income/',
    '/api/v4/invoice/seller/',
    '/api/v2/finance/',
    '/api/v2/order/',
    'get_escrow_detail',
    'income_transaction',
    'get_income_overviews',
    'get_invoice_list',
    'get_invoice_detail',
    'get_order_detail',
    'order_income',
    'get_income_detail'
  ];

  function shouldCapture(url) {
    return API_PATTERNS.some(pattern => url.includes(pattern));
  }

  function serializeRequestBody(body) {
    if (typeof body === 'string') return body;
    if (!body) return '';
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      try {
        return JSON.stringify(Object.fromEntries(body.entries()));
      } catch {
        return '';
      }
    }
    if (typeof body === 'object') {
      try {
        return JSON.stringify(body);
      } catch {
        return '';
      }
    }
    return '';
  }

  function sendCaptured(meta, responseBody) {
    try {
      const parsed = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
      window.postMessage({
        type: 'SHOPEE_API_CAPTURED',
        payload: {
          url: meta.url,
          method: meta.method || 'GET',
          requestBody: meta.requestBody || '',
          body: parsed,
          timestamp: Date.now()
        }
      }, '*');
    } catch (e) {
      // Not JSON, ignore
    }
  }

  // --- Patch fetch ---
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase();
    const requestBody = serializeRequestBody(args[1]?.body);

    return originalFetch.apply(this, args).then(response => {
      if (shouldCapture(url)) {
        response.clone().text().then(text => {
          sendCaptured({ url, method, requestBody }, text);
        }).catch(() => {});
      }
      return response;
    });
  };

  // --- Patch XMLHttpRequest ---
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._shopeeUrl = url;
    this._shopeeMethod = String(method || 'GET').toUpperCase();
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this._shopeeBody = serializeRequestBody(args[0]);
    this.addEventListener('load', function() {
      if (shouldCapture(this._shopeeUrl || '')) {
        sendCaptured({
          url: this._shopeeUrl,
          method: this._shopeeMethod || 'GET',
          requestBody: this._shopeeBody || ''
        }, this.responseText);
      }
    });
    return originalXHRSend.apply(this, args);
  };

  console.log('[Shopee Exporter] API interceptor active (always-on)');
})();
