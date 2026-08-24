const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { deriveVideoHash } = require('./videoHash');
const {
  selectStreamFilename,
  deriveStreamHashFromUrl
} = require('./streamUrlIdentity');
const {
  generateEmbeddedSubtitlePage,
  generateAutoSubtitlePage
} = require('./toolboxPageGenerator');
const { generateSubtitleSyncPage } = require('./syncPageGenerator');

const STREMIO_LOCAL_URL = 'http://127.0.0.1:11470/6bbd66ccc0adccc8db658f335ed23f55e32b0dd8/0?';
const LINKED_FILENAME = 'RuPauls.Drag.Race.All.Stars.S11E07.1080p.WEB.h264-EDITH.mkv';
const VIDEO_ID = 'tt2301351:11:7';

test('opaque Stremio local and LAN stream routes retain linked filename identity', () => {
  const expectedHash = deriveVideoHash(LINKED_FILENAME, VIDEO_ID);

  assert.equal(selectStreamFilename(STREMIO_LOCAL_URL, LINKED_FILENAME), LINKED_FILENAME);
  assert.equal(
    selectStreamFilename(
      'http://192.168.1.20:11470/6bbd66ccc0adccc8db658f335ed23f55e32b0dd8/0',
      LINKED_FILENAME
    ),
    LINKED_FILENAME
  );

  const identity = deriveStreamHashFromUrl(STREMIO_LOCAL_URL, {
    filename: LINKED_FILENAME,
    videoId: VIDEO_ID
  });
  assert.equal(identity.filename, LINKED_FILENAME);
  assert.equal(identity.hash, expectedHash);
  assert.notEqual(identity.hash, deriveVideoHash('0', VIDEO_ID));
});

test('reliable URL filenames override linked metadata while weak URL hints do not', () => {
  assert.equal(
    selectStreamFilename('https://cdn.example/movie/Other.Release.2026.mkv', LINKED_FILENAME),
    'Other.Release.2026.mkv'
  );
  assert.equal(
    selectStreamFilename('https://resolver.example/resolve/abc?name=Short+Title', LINKED_FILENAME),
    LINKED_FILENAME
  );
  assert.equal(
    selectStreamFilename('https://resolver.example/play?file=0&download=1', LINKED_FILENAME),
    LINKED_FILENAME
  );
  assert.equal(
    selectStreamFilename('https://resolver.example/play?filename=Encoded%20Movie.mkv', LINKED_FILENAME),
    'Encoded Movie.mkv'
  );
});

test('all stream-based toolbox pages embed the shared filename selector', async () => {
  const config = {
    uiLanguage: 'en',
    sourceLanguages: ['eng'],
    targetLanguages: ['por'],
    providers: {}
  };
  const pages = await Promise.all([
    generateEmbeddedSubtitlePage('test-config', '', LINKED_FILENAME, config),
    generateAutoSubtitlePage('test-config', '', LINKED_FILENAME, config),
    generateSubtitleSyncPage([], '', LINKED_FILENAME, 'test-config', config)
  ]);

  for (const html of pages) {
    assert.match(html, /const selectStreamFilename = function selectStreamFilename/);
    assert.match(html, /selectStreamFilename\(streamUrl,/);
    assert.doesNotMatch(html, /Last resort: return pathname last part even without extension/);

    const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map((match) => match[1])
      .filter((source) => source.trim());
    assert.ok(inlineScripts.length > 0);
    for (const source of inlineScripts) {
      assert.doesNotThrow(() => new Function(source));
    }
  }

  const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  assert.match(serverSource, /deriveStreamHashFromUrl\(streamUrl, fallback\)/);
  assert.doesNotMatch(serverSource, /Last resort: use pathname last part even without extension/);
});
