const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  createLicense,
  listLicenses,
  getLicenseDetail,
  updateLicenseStatus,
  extendLicenseExpiry,
  resetLicenseStore,
  resetAllLicenseStores,
} = require('../services/license-service');
const logger = require('../utils/logger');

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

function setFlash(req, flash) {
  req.session.adminFlash = flash;
}

function consumeFlash(req) {
  const flash = req.session.adminFlash || null;
  delete req.session.adminFlash;
  return flash;
}

router.get('/licenses', async (req, res, next) => {
  try {
    const filters = {
      email: req.query.email || '',
      plan: req.query.plan || '',
      status: req.query.status || '',
      store: req.query.store || '',
    };

    const licenses = await listLicenses(filters);
    res.render('admin-licenses', {
      licenses,
      filters,
      flash: consumeFlash(req),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/licenses', async (req, res) => {
  try {
    const durationDays = parseInt(req.body.duration_days || req.body.days || '30', 10);
    const maxStores = parseInt(req.body.max_stores || '', 10);
    const result = await createLicense({
      customerEmail: req.body.customer_email || '',
      customerName: req.body.customer_name || '',
      plan: req.body.plan || 'starter',
      durationDays: Number.isFinite(durationDays) ? durationDays : 30,
      notes: req.body.notes || '',
      maxStores: Number.isFinite(maxStores) ? maxStores : null,
    });

    logger.info('Admin created license', {
      actorEmail: req.currentUser?.email || '',
      licenseId: result.license.id,
      customerEmail: result.license.customerEmail,
      plan: result.license.plan,
      maxStores: result.license.maxStores,
    });

    setFlash(req, {
      type: 'success',
      message: 'License created successfully.',
      licenseKey: result.licenseKey,
    });
    return res.redirect('/admin/licenses');
  } catch (error) {
    setFlash(req, {
      type: 'error',
      message: error.message || 'Failed to create license.',
    });
    return res.redirect('/admin/licenses');
  }
});

router.get('/licenses/:id', async (req, res) => {
  try {
    const detail = await getLicenseDetail(req.params.id);
    if (!detail) {
      setFlash(req, { type: 'error', message: 'License not found.' });
      return res.redirect('/admin/licenses');
    }

    return res.render('admin-license-detail', {
      license: detail.license,
      verifications: detail.verifications,
      flash: consumeFlash(req),
    });
  } catch (error) {
    setFlash(req, { type: 'error', message: error.message || 'Failed to update license.' });
    return res.redirect('/admin/licenses');
  }
});

router.post('/licenses/:id/revoke', async (req, res) => {
  try {
    await updateLicenseStatus(req.params.id, 'inactive');
    logger.info('Admin revoked license', { actorEmail: req.currentUser?.email || '', licenseId: req.params.id });
    setFlash(req, { type: 'success', message: 'License revoked.' });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  } catch (error) {
    setFlash(req, { type: 'error', message: error.message || 'Failed to update license.' });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  }
});

router.post('/licenses/:id/reactivate', async (req, res) => {
  try {
    await updateLicenseStatus(req.params.id, 'active');
    logger.info('Admin reactivated license', { actorEmail: req.currentUser?.email || '', licenseId: req.params.id });
    setFlash(req, { type: 'success', message: 'License reactivated.' });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  } catch (error) {
    setFlash(req, { type: 'error', message: error.message || 'Failed to update license.' });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  }
});

router.post('/licenses/:id/extend', async (req, res) => {
  try {
    const days = parseInt(req.body.days || '0', 10);
    await extendLicenseExpiry(req.params.id, days);
    logger.info('Admin extended license expiry', {
      actorEmail: req.currentUser?.email || '',
      licenseId: req.params.id,
      days,
    });
    setFlash(req, { type: 'success', message: `License extended by ${days} day(s).` });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  } catch (error) {
    setFlash(req, { type: 'error', message: error.message || 'Failed to extend expiry.' });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  }
});

router.post('/licenses/:id/reset-store/:storeId', async (req, res) => {
  try {
    await resetLicenseStore(req.params.id, req.params.storeId);
    logger.info('Admin reset one bound store', {
      actorEmail: req.currentUser?.email || '',
      licenseId: req.params.id,
      boundStoreId: req.params.storeId,
    });
    setFlash(req, { type: 'success', message: 'Bound store removed.' });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  } catch (error) {
    setFlash(req, { type: 'error', message: error.message || 'Failed to reset bound stores.' });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  }
});

router.post('/licenses/:id/reset-stores', async (req, res) => {
  try {
    await resetAllLicenseStores(req.params.id);
    logger.info('Admin reset all bound stores', {
      actorEmail: req.currentUser?.email || '',
      licenseId: req.params.id,
    });
    setFlash(req, { type: 'success', message: 'All bound stores removed.' });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  } catch (error) {
    setFlash(req, { type: 'error', message: error.message || 'Failed to reset bound stores.' });
    return res.redirect(`/admin/licenses/${req.params.id}`);
  }
});

module.exports = router;
