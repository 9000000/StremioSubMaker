'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..', '..');
const { generateConfigurePage } = require('./configurePageGenerator');
const configPageState = require(path.join(projectRoot, 'public', 'js', 'config-page-state.js'));
const { version } = require('./version');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('configure shell exposes release state and discovers the main bundle without a loader waterfall', () => {
  const page = generateConfigurePage();

  assert.match(page, new RegExp(`<script src="/config\\.js\\?v=${version.replace(/\./g, '\\.')}" defer></script>`));
  assert.doesNotMatch(page, /<script[^>]+config-loader\.js/);
  assert.match(page, new RegExp(`<img src="/logo\\.png\\?v=${version.replace(/\./g, '\\.')}"`));
  assert.match(page, new RegExp(`id="version-badge"[^>]*>v${version.replace(/\./g, '\\.')}`));
  assert.match(page, /id="uiLanguageFlags" data-preboot/);
  assert.match(page, /Paint locally-known shell controls as soon as they enter the DOM/);
  assert.ok(
    page.indexOf('Paint locally-known shell controls') < page.indexOf('<form id="configForm"'),
    'the local shell bootstrap must run before the large configuration form is parsed'
  );
});

test('configuration language catalogs share one pair of in-flight requests', async () => {
  const calls = [];
  const payloads = {
    '/api/languages': [{ code: 'eng', name: 'English' }],
    '/api/languages/translation': [{ code: 'spa', name: 'Spanish' }]
  };
  const fetchMock = async (url) => {
    calls.push(url);
    await new Promise(resolve => setTimeout(resolve, 5));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payloads[url]
    };
  };

  const [first, second] = await Promise.all([
    configPageState.loadLanguageCatalogs({ fetch: fetchMock }),
    configPageState.loadLanguageCatalogs({ fetch: fetchMock })
  ]);

  assert.deepEqual(calls.sort(), ['/api/languages', '/api/languages/translation']);
  assert.strictEqual(first, second);
});

test('versioned UI assets are cacheable and expensive install/font work stays off the load path', () => {
  const indexSource = read('index.js');
  const serviceWorkerSource = read('public/sw.js');
  const configSource = read('public/config.js');
  const configureCss = read('public/css/configure.css');
  const noStoreBlock = indexSource.slice(
    indexSource.indexOf('const noStorePaths = ['),
    indexSource.indexOf('];', indexSource.indexOf('const noStorePaths = ['))
  );

  assert.match(indexSource, /function setImmutableVersionedAssetCache/);
  assert.match(indexSource, /Cache-Control', 'public, max-age=31536000, immutable'/);
  assert.doesNotMatch(indexSource, /max-age=31536000000/);
  assert.match(indexSource, /level: 6/);
  assert.doesNotMatch(noStoreBlock, /'\/config\.js'/);
  assert.doesNotMatch(serviceWorkerSource, /const ASSET_URLS/);
  assert.match(serviceWorkerSource, /function isPublicUiApiRequest/);
  assert.doesNotMatch(configureCss, /fonts\/Twemoji\.ttf/);
  assert.match(configSource, /const hydrateInitialSession = async \(\) =>/);
  assert.match(configSource, /hydrateInitialSession\(\)\.then/);
  assert.doesNotMatch(configSource, /await hydrateInitialSession\(\)/);
});
