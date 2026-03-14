const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const config = require('../config');
const router = express.Router();

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function getAuthErrorMessage(errorCode) {
  if (errorCode === 'registration_disabled') {
    return 'Registration is disabled on this server. Ask the administrator to create your account.';
  }
  return null;
}

router.get('/login', (req, res) => {
  res.render('login', {
    error: getAuthErrorMessage(req.query.error),
    registrationEnabled: config.allowSelfRegistration,
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('login', {
      error: 'Email and password are required',
      registrationEnabled: config.allowSelfRegistration,
    });
  }

  const user = await db('users').where({ email: email.toLowerCase().trim() }).first();
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.render('login', {
      error: 'Invalid email or password',
      registrationEnabled: config.allowSelfRegistration,
    });
  }

  await regenerateSession(req);
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

router.get('/register', (req, res) => {
  if (!config.allowSelfRegistration) {
    return res.redirect('/auth/login?error=registration_disabled');
  }
  return res.render('register', { error: null, registrationEnabled: true });
});

router.post('/register', async (req, res) => {
  if (!config.allowSelfRegistration) {
    return res.redirect('/auth/login?error=registration_disabled');
  }
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.render('register', { error: 'Email and password are required', registrationEnabled: true });
  }
  if (String(password).length < 8) {
    return res.render('register', { error: 'Password must be at least 8 characters', registrationEnabled: true });
  }

  const existing = await db('users').where({ email: email.toLowerCase().trim() }).first();
  if (existing) {
    return res.render('register', { error: 'Email already registered', registrationEnabled: true });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db('users')
    .insert({
      email: email.toLowerCase().trim(),
      password_hash: passwordHash,
      name: name || '',
    })
    .returning('*');

  // Create trial subscription (7 days)
  await db('subscriptions').insert({
    user_id: user.id,
    plan: 'trial',
    status: 'active',
    trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  await regenerateSession(req);
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/auth/login');
  });
});

module.exports = router;
