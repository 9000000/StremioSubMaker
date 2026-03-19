const fs = require('fs');
const path = require('path');

const { version } = require('./version');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'public', 'configure.html');
const APP_VERSION_JSON_TOKEN = '__APP_VERSION_JSON__';
const APP_VERSION_QUERY_TOKEN = '__APP_VERSION_QUERY__';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

function escapeJsSingleQuotedString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function generateConfigurePage() {
  const appVersion = version || 'dev';
  const template = loadTemplate();

  return template
    .split(APP_VERSION_JSON_TOKEN).join(`'${escapeJsSingleQuotedString(appVersion)}'`)
    .split(APP_VERSION_QUERY_TOKEN).join(escapeHtml(encodeURIComponent(appVersion)));
}

module.exports = { generateConfigurePage };
