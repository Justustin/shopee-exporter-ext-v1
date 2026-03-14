const db = require('../db');
const config = require('../config');

function isAdminEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return Boolean(normalized && config.adminEmails.includes(normalized));
}

async function resolveCurrentUser(req) {
  if (Object.prototype.hasOwnProperty.call(req, 'currentUser')) {
    return req.currentUser;
  }
  if (!req.session || !req.session.userId) {
    req.currentUser = null;
    return req.currentUser;
  }

  const user = await db('users')
    .select('id', 'email', 'name')
    .where({ id: req.session.userId })
    .first();
  req.currentUser = user || null;
  return req.currentUser;
}

async function attachCurrentUser(req, res, next) {
  try {
    const user = await resolveCurrentUser(req);
    req.isAdmin = isAdminEmail(user?.email);
    res.locals.user = user;
    res.locals.isAdmin = req.isAdmin;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await resolveCurrentUser(req);
    if (!user || !isAdminEmail(user.email)) {
      if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      return res.redirect('/dashboard?error=admin_required');
    }

    req.isAdmin = true;
    res.locals.user = user;
    res.locals.isAdmin = true;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  attachCurrentUser,
  requireAdmin,
  isAdminEmail,
};
