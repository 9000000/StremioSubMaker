/**
 * Generate HTML page for subtitle synchronization
 * This page allows users to:
 * 1. Extract audio from stream link
 * 2. Select a subtitle to sync
 * 3. Sync using alass-wasm
 * 4. Preview synced result
 * 5. Optionally translate after syncing
 * 6. Download results
 */

const axios = require('axios');
const { getLanguageName, getAllLanguages, buildLanguageLookupMaps } = require('./languages');
const { deriveVideoHash } = require('./videoHash');
const { parseStremioId } = require('./subtitle');
const { version: appVersion } = require('../../package.json');
const { quickNavStyles, quickNavScript, renderQuickNav, renderRefreshBadge } = require('./quickNav');
const { buildClientBootstrap, loadLocale } = require('./i18n');

function escapeHtml(text) {