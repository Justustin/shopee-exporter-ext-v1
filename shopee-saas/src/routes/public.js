const express = require('express');
const config = require('../config');

const router = express.Router();

router.get('/privacy', (req, res) => {
  res.render('privacy', {
    supportEmail: config.support.email,
  });
});

router.get('/support', (req, res) => {
  res.render('support', {
    supportEmail: config.support.email,
    supportWhatsapp: config.support.whatsapp,
  });
});

module.exports = router;
