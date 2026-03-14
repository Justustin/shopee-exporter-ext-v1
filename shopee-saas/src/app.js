const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('./config');
const db = require('./db');
const logger = require('./utils/logger');
const { attachCsrfToken, verifyCsrfToken } = require('./middleware/csrf');
const { attachSubscription } = require('./middleware/subscription');

const app = express();

if (config.nodeEnv === 'production') {
  app.set('trust proxy', 1);
}

// Security
app.use(helmet());

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health checks should not depend on session middleware.
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'shopee-saas' });
});

app.get('/health/db', async (req, res) => {
  try {
    await db.raw('select 1 as ok');
    res.json({ ok: true, db: 'up' });
  } catch (error) {
    logger.error('Database health check failed', { error: error.message, stack: error.stack });
    res.status(503).json({ ok: false, db: 'down' });
  }
});

// Views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Sessions stored in PostgreSQL
app.use(session({
  store: new PgSession({
    knex: db,
    tableName: 'session',
    createTableIfMissing: false,
  }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
  },
}));

// CSRF token generation + verification
app.use(attachCsrfToken);
app.use(verifyCsrfToken);

// Make user available to all views
app.use((req, res, next) => {
  res.locals.user = req.session.userId ? { id: req.session.userId } : null;
  next();
});
app.use(attachSubscription);

// Routes
const authRoutes = require('./routes/auth');
const shopeeOAuthRoutes = require('./routes/shopee-oauth');
const dashboardRoutes = require('./routes/dashboard');
const storeApiRoutes = require('./routes/api/stores');
const orderApiRoutes = require('./routes/api/orders');
const exportApiRoutes = require('./routes/api/export');
const reportApiRoutes = require('./routes/api/reports');
const licenseApiRoutes = require('./routes/api/license');

app.use('/auth', authRoutes);
app.use('/shopee', shopeeOAuthRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/api/stores', storeApiRoutes);
app.use('/api/orders', orderApiRoutes);
app.use('/api/export', exportApiRoutes);
app.use('/api/reports', reportApiRoutes);
app.use('/api/license', licenseApiRoutes);

// Root redirect
app.get('/', (req, res) => {
  res.redirect(req.session.userId ? '/dashboard' : '/auth/login');
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(500).render('error', { message: 'Something went wrong' });
});

module.exports = app;
