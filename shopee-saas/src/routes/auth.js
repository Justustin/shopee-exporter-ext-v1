const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const router = express.Router();

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('login', { error: 'Email and password are required' });
  }

  const user = await db('users').where({ email: email.toLowerCase().trim() }).first();
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.render('login', { error: 'Invalid email or password' });
  }

  await regenerateSession(req);
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

router.get('/register', (req, res) => {
  res.render('register', { error: null });
});

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.render('register', { error: 'Email and password are required' });
  }
  if (String(password).length < 8) {
    return res.render('register', { error: 'Password must be at least 8 characters' });
  }

  const existing = await db('users').where({ email: email.toLowerCase().trim() }).first();
  if (existing) {
    return res.render('register', { error: 'Email already registered' });
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
