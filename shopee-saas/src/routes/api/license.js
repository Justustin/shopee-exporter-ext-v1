const express = require('express');
const { verifyLicense } = require('../../services/license-service');

const router = express.Router();

function applyPublicCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

router.options('/verify', (req, res) => {
  applyPublicCors(res);
  res.sendStatus(204);
});

router.post('/verify', async (req, res) => {
  applyPublicCors(res);

  try {
    const result = await verifyLicense({
      licenseKey: req.body.licenseKey,
      storeKey: req.body.storeKey,
      storeName: req.body.storeName,
      meta: {
        buildTag: req.body.buildTag,
        profileEmail: req.body.profileEmail,
      },
    });

    if (!result.ok) {
      res.status(403).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      code: 'VERIFY_FAILED',
      error: error.message || 'License verification failed',
    });
  }
});

module.exports = router;
