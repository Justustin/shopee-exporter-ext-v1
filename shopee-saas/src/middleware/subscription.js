const db = require('../db');

function isActiveSubscription(subscription, now = new Date()) {
  if (!subscription || subscription.status !== 'active') {
    return false;
  }

  if (subscription.plan === 'trial' && subscription.trial_ends_at) {
    return new Date(subscription.trial_ends_at) >= now;
  }

  if (subscription.plan !== 'trial' && subscription.paid_until) {
    return new Date(subscription.paid_until) >= now;
  }

  return true;
}

async function fetchSubscription(userId) {
  const active = await db('subscriptions')
    .where({ user_id: userId, status: 'active' })
    .orderBy('updated_at', 'desc')
    .first();

  if (active) {
    return active;
  }

  return db('subscriptions')
    .where({ user_id: userId })
    .orderBy('updated_at', 'desc')
    .first();
}

async function fetchLatestSubscriptionsByUserIds(userIds) {
  const ids = Array.from(new Set((userIds || []).map((value) => parseInt(value, 10)).filter(Number.isFinite)));
  const result = new Map();
  if (!ids.length) {
    return result;
  }

  const rows = await db('subscriptions')
    .whereIn('user_id', ids)
    .orderBy([
      { column: 'user_id', order: 'asc' },
      { column: 'updated_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ]);

  for (const row of rows) {
    if (!result.has(row.user_id)) {
      result.set(row.user_id, row);
    }
  }

  return result;
}

async function ensureSubscription(req) {
  if (Object.prototype.hasOwnProperty.call(req, 'subscription')) {
    return req.subscription;
  }
  if (!req.session || !req.session.userId) {
    req.subscription = null;
    return req.subscription;
  }

  const row = await fetchSubscription(req.session.userId);
  req.subscription = row
    ? {
      ...row,
      isActive: isActiveSubscription(row),
    }
    : null;
  return req.subscription;
}

function renderOrJsonError(req, res, errorCode, statusCode = 402) {
  const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
  const isApiRoute = req.originalUrl && req.originalUrl.startsWith('/api/');
  if (!acceptsHtml || isApiRoute) {
    if (acceptsHtml && req.originalUrl && req.originalUrl.startsWith('/api/stores/')) {
      return res.redirect(`/dashboard?error=${errorCode}`);
    }
    return res.status(statusCode).json({ error: errorCode });
  }
  return res.redirect(`/dashboard?error=${errorCode}`);
}

async function attachSubscription(req, res, next) {
  try {
    const subscription = await ensureSubscription(req);
    res.locals.subscription = subscription;
    next();
  } catch (err) {
    next(err);
  }
}

async function requireActiveSubscription(req, res, next) {
  try {
    const subscription = await ensureSubscription(req);
    if (!subscription || !subscription.isActive) {
      return renderOrJsonError(req, res, 'subscription_required');
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  attachSubscription,
  requireActiveSubscription,
  isActiveSubscription,
  fetchLatestSubscriptionsByUserIds,
};
