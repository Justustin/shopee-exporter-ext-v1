const db = require('../db');

function prefersJson(req) {
  if (req.originalUrl && req.originalUrl.startsWith('/api/')) return true;
  const accepted = req.accepts(['html', 'json']);
  return accepted === 'json';
}

function requireStoreOwner(paramName = 'id') {
  return async (req, res, next) => {
    const storeId = parseInt(req.params[paramName], 10);
    if (!storeId) {
      if (prefersJson(req)) {
        return res.status(400).json({ error: 'Invalid store ID' });
      }
      return res.redirect('/dashboard?error=invalid_store_id');
    }

    const store = await db('stores')
      .where({ id: storeId, user_id: req.session.userId })
      .first();

    if (!store) {
      if (prefersJson(req)) {
        return res.status(404).json({ error: 'Store not found' });
      }
      return res.redirect('/dashboard?error=store_not_found');
    }

    req.store = store;
    next();
  };
}

module.exports = { requireStoreOwner };
