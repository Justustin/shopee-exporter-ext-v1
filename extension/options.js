const DEFAULT_SETTINGS = {
  exportFilenamePrefix: 'shopee-export',
  exportLabel: '',
  includeProfileEmailInFilename: false,
  autoClearAfterExport: false
};

const form = document.getElementById('settingsForm');
const statusBox = document.getElementById('statusBox');
const filenamePreview = document.getElementById('filenamePreview');
const btnReset = document.getElementById('btnReset');

const fields = {
  exportFilenamePrefix: document.getElementById('exportFilenamePrefix'),
  exportLabel: document.getElementById('exportLabel'),
  includeProfileEmailInFilename: document.getElementById('includeProfileEmailInFilename'),
  autoClearAfterExport: document.getElementById('autoClearAfterExport')
};

loadSettings();
wirePreview();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = readSettingsFromForm();
  await chrome.storage.local.set({ extensionSettings: settings });
  showStatus('success', 'Settings saved.');
  updatePreview();
});

btnReset.addEventListener('click', async () => {
  applySettings(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ extensionSettings: DEFAULT_SETTINGS });
  showStatus('success', 'Defaults restored.');
  updatePreview();
});

function wirePreview() {
  Object.values(fields).forEach((field) => {
    field.addEventListener('input', updatePreview);
    field.addEventListener('change', updatePreview);
  });
}

async function loadSettings() {
  const result = await chrome.storage.local.get('extensionSettings');
  const settings = normalizeSettings(result.extensionSettings);
  applySettings(settings);
  updatePreview();
}

function readSettingsFromForm() {
  return normalizeSettings({
    exportFilenamePrefix: fields.exportFilenamePrefix.value,
    exportLabel: fields.exportLabel.value,
    includeProfileEmailInFilename: fields.includeProfileEmailInFilename.checked,
    autoClearAfterExport: fields.autoClearAfterExport.checked
  });
}

function applySettings(settings) {
  fields.exportFilenamePrefix.value = settings.exportFilenamePrefix;
  fields.exportLabel.value = settings.exportLabel;
  fields.includeProfileEmailInFilename.checked = settings.includeProfileEmailInFilename;
  fields.autoClearAfterExport.checked = settings.autoClearAfterExport;
}

function updatePreview() {
  const settings = readSettingsFromForm();
  filenamePreview.textContent = buildFilename(settings, 'seller-account');
}

function normalizeSettings(raw) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  settings.exportFilenamePrefix = String(settings.exportFilenamePrefix || DEFAULT_SETTINGS.exportFilenamePrefix).trim() || DEFAULT_SETTINGS.exportFilenamePrefix;
  settings.exportLabel = String(settings.exportLabel || '').trim();
  settings.includeProfileEmailInFilename = Boolean(settings.includeProfileEmailInFilename);
  settings.autoClearAfterExport = Boolean(settings.autoClearAfterExport);
  return settings;
}

function buildFilename(settings, profileTag) {
  const parts = [];
  const prefix = sanitizeFilenamePart(settings.exportFilenamePrefix);
  const label = sanitizeFilenamePart(settings.exportLabel);
  const email = settings.includeProfileEmailInFilename ? sanitizeFilenamePart(profileTag) : '';
  const datePart = new Date().toISOString().slice(0, 10);

  if (prefix) parts.push(prefix);
  if (label) parts.push(label);
  if (email) parts.push(email);
  parts.push(datePart, 'colored');
  return `${parts.join('-')}.xls`;
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function showStatus(type, message) {
  statusBox.className = `status visible ${type}`;
  statusBox.textContent = message;
}
