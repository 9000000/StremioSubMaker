const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { serializeJsonForInlineScript } = require('./inlineScriptJson');
const { generateHistoryPage } = require('./historyPageGenerator');
const { generateSmdbPage } = require('./smdbPageGenerator');
const { generateFileTranslationPage } = require('./fileUploadPageGenerator');
const {
  generateSubToolboxPage,
  generateEmbeddedSubtitlePage,
  generateAutoSubtitlePage
} = require('./toolboxPageGenerator');
const { generateSubtitleSyncPage } = require('./syncPageGenerator');

const BREAKOUT_PAYLOAD = '</script><script id="submaker-xss-marker">globalThis.__xss = true</script>&>\u2028\u2029';

test('inline-script JSON serialization escapes HTML parser breakouts and preserves data', () => {
  const value = {
    payload: BREAKOUT_PAYLOAD,
    nested: ['<', '>', '&', '\u2028', '\u2029'],
    enabled: true
  };
  const serialized = serializeJsonForInlineScript(value);

  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/u);
  assert.match(serialized, /\\u003c/);
  assert.match(serialized, /\\u003e/);
  assert.match(serialized, /\\u0026/);
  assert.match(serialized, /\\u2028/);
  assert.match(serialized, /\\u2029/);

  const restored = vm.runInNewContext(`(${serialized})`);
  assert.equal(JSON.stringify(restored), JSON.stringify(value));
});

test('all reported generated pages contain no attacker-controlled script closing tag', async () => {
  const config = {
    uiLanguage: 'en',
    sourceLanguages: ['eng'],
    targetLanguages: ['por'],
    languageMaps: { eng: 'por' },
    geminiApiKey: 'unused-sync-gemini-secret',
    cloudflareWorkersApiKey: `test-account|${BREAKOUT_PAYLOAD}`,
    assemblyAiApiKey: BREAKOUT_PAYLOAD,
    providers: {
      assemblyai: { apiKey: BREAKOUT_PAYLOAD }
    }
  };

  const pages = {
    history: generateHistoryPage(BREAKOUT_PAYLOAD, [], config, BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD),
    smdb: await generateSmdbPage(BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, config),
    fileUpload: generateFileTranslationPage(BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, config, BREAKOUT_PAYLOAD),
    toolbox: generateSubToolboxPage(BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, config),
    embedded: await generateEmbeddedSubtitlePage(BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD),
    sync: await generateSubtitleSyncPage([], BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, config),
    autoSubs: await generateAutoSubtitlePage(BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, BREAKOUT_PAYLOAD, config)
  };

  for (const [name, html] of Object.entries(pages)) {
    assert.doesNotMatch(html, /<script id="submaker-xss-marker">/i, `${name} emitted an injected script element`);
    assert.ok(!html.includes(BREAKOUT_PAYLOAD), `${name} emitted the raw attacker payload`);
    assert.match(html, /\\u003c\/script\\u003e\\u003cscript id=\\"submaker-xss-marker\\"\\u003e/);

    const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map((match) => match[1])
      .filter((source) => source.trim());
    assert.ok(inlineScripts.length > 0, `${name} should contain an inline script`);
    for (const source of inlineScripts) {
      assert.doesNotThrow(() => new Function(source), `${name} emitted invalid JavaScript`);
    }
  }

  assert.ok(!pages.sync.includes('unused-sync-gemini-secret'), 'Sync must not expose its unused Gemini key');
});

test('page generators do not bypass the centralized inline-script serializer', () => {
  const generatorFiles = [
    'configurePageGenerator.js',
    'fileUploadPageGenerator.js',
    'historyPageGenerator.js',
    'smdbPageGenerator.js',
    'syncPageGenerator.js',
    'toolboxPageGenerator.js'
  ];

  for (const filename of generatorFiles) {
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    assert.doesNotMatch(source, /\$\{JSON\.stringify/, `${filename} bypasses inline-script escaping`);
    assert.doesNotMatch(source, /function safeJsonSerialize/, `${filename} defines a duplicate serializer`);
  }
});
