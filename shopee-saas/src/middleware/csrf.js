const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureCsrfToken(req) {
  if (!req.session) {
    return null;
  }
  if (!req.session.csrfToken || typeof req.session.csrfToken !== 'string') {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function attachCsrfToken(req, res, next) {
  const token = ensureCsrfToken(req);
  req.csrfToken = () => token;
  res.locals.csrfToken = token;
  next();
}

function rejectCsrf(req, res) {
  if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  return res.status(403).render('error', {
    message: 'Invalid request token. Refresh the page and try again.',
  });
}

function verifyCsrfToken(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }
  if (req.originalUrl === '/api/license/verify') {
    return next();
  }

  const sessionToken = req.session && req.session.csrfToken;
  const requestToken =
    (req.body && req.body._csrf) ||
    req.get('x-csrf-token') ||
    req.get('csrf-token');

  if (!sessionToken || !requestToken || requestToken !== sessionToken) {
    return rejectCsrf(req, res);
  }

  return next();
}

module.exports = { attachCsrfToken, verifyCsrfToken };
