const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const axios = require('axios');

const GeminiService = require('./gemini');
const { createTranslationProvider } = require('./translationProviderFactory');
const { sanitizeApiKeyForHeader } = require('../utils/security');
const { generateFileTranslationPage } = require('../utils/fileUploadPageGenerator');
const {
  generateEmbeddedSubtitlePage,
  generateAutoSubtitlePage
} = require('../utils/toolboxPageGenerator');
const {
  getDefaultConfig,
  getModelSpecificDefaults,
  normalizeConfig,
  normalizeGeminiModelName
} = require('../utils/config');

const projectRoot = path.resolve(__dirname, '..', '..');

test('AQ authorization keys are preserved and sent through the runtime v1beta model client', async () => {
  const authKey = 'AQ.Ab8RN6_example-auth-key.with.dots_and-symbols';
  const originalGet = axios.get;
  let request = null;

  axios.get = async (url, options) => {
    request = { url, options };
    return {
      data: {
        models: [{
          name: 'models/gemini-3.7-flash',
          displayName: 'Gemini 3.7 Flash',
          supportedGenerationMethods: ['generateContent'],
          inputTokenLimit: 1048576
        }]
      }
    };
  };

  try {
    assert.equal(sanitizeApiKeyForHeader(`  ${authKey}\r\n`), authKey);
    const service = new GeminiService(`  ${authKey}  `, 'gemini-3.7-flash');
    const models = await service.getAvailableModels({ silent: true, throwOnError: true });

    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(request.options.headers['x-goog-api-key'], authKey);
    assert.deepEqual(models.map(model => model.name), ['gemini-3.7-flash']);

    const serverSource = fs.readFileSync(path.join(projectRoot, 'index.js'), 'utf8');
    assert.match(serverSource, /new GeminiService\(geminiApiKey\)[\s\S]{0,200}getAvailableModels\(\{ silent: true, throwOnError: true \}\)/);
    assert.doesNotMatch(serverSource, /generativelanguage\.googleapis\.com\/v1\/models/);
  } finally {
    axios.get = originalGet;
  }
});

test('Gemini 3.x uses thinking levels without legacy sampling fields', () => {
  const service = new GeminiService('test-key', 'models/gemini-3.5-flash', {
    thinkingBudget: 1000,
    thinkingLevel: 'high',
    temperature: 0.5,
    topK: 40,
    topP: 0.95
  });

  assert.equal(service.model, 'gemini-3.5-flash');
  assert.deepEqual(service.buildGenerationConfig(4096), {
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingLevel: 'high' }
  });

  const disabled37 = new GeminiService('test-key', 'gemini-3.7-flash', { thinkingLevel: 'disabled' });
  assert.equal(disabled37.buildGenerationConfig(4096).thinkingConfig.thinkingLevel, 'low');

  const dated37 = new GeminiService('test-key', 'gemini-3.7-flash-001', { thinkingLevel: 'minimal' });
  assert.equal(dated37.buildGenerationConfig(4096).thinkingConfig.thinkingLevel, 'low');

  const latestLite = new GeminiService('test-key', 'gemini-flash-lite-latest', {
    thinkingBudget: 0,
    thinkingLevel: 'minimal',
    temperature: 0.8
  });
  assert.equal(latestLite.isThinkingEnabled(), true);
  assert.deepEqual(latestLite.buildGenerationConfig(4096), {
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingLevel: 'minimal' }
  });
});

test('Gemini 3 translation and structured-output paths send the current request shape', async () => {
  const originalPost = axios.post;
  let requestBody = null;
  const service = new GeminiService('AQ.test-key', 'gemini-3.7-flash', {
    thinkingLevel: 'medium',
    enableJsonOutput: true,
    maxRetries: 0
  });
  service.getModelLimits = async () => ({ inputTokenLimit: 1048576, outputTokenLimit: 65536 });

  axios.post = async (url, body) => {
    assert.match(url, /\/v1beta\/models\/gemini-3\.7-flash:generateContent$/);
    requestBody = body;
    return {
      data: {
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{"entries":["Olá"]}' }] }
        }]
      }
    };
  };

  try {
    const output = await service.translateSubtitle('Hello', 'English', 'Portuguese');
    assert.equal(output, '{"entries":["Olá"]}');
    assert.equal(requestBody.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(requestBody.generationConfig.thinkingConfig, { thinkingLevel: 'medium' });
    assert.equal('thinkingBudget' in requestBody.generationConfig.thinkingConfig, false);
    assert.equal('temperature' in requestBody.generationConfig, false);
    assert.equal('topK' in requestBody.generationConfig, false);
    assert.equal('topP' in requestBody.generationConfig, false);
  } finally {
    axios.post = originalPost;
  }
});

test('legacy numeric thinking budgets and sampling controls remain unchanged for Gemini 2.x', () => {
  const service = new GeminiService('test-key', 'gemini-2.5-flash', {
    thinkingBudget: 1000,
    temperature: 0.5,
    topK: 20,
    topP: 0.9
  });

  assert.deepEqual(service.buildGenerationConfig(4096), {
    maxOutputTokens: 4096,
    temperature: 0.5,
    topK: 20,
    topP: 0.9,
    thinkingConfig: { thinkingBudget: 1000 }
  });
});

test('saved model IDs and Gemini 3.x defaults normalize without breaking old configs', () => {
  assert.equal(normalizeGeminiModelName(' models/gemini-3.7-flash '), 'gemini-3.7-flash');
  assert.equal(normalizeGeminiModelName('gemini-3.1-flash-lite-preview'), 'gemini-3.1-flash-lite');
  assert.equal(normalizeGeminiModelName('gemini-3-pro-preview'), 'gemini-flash-lite-latest');

  const defaults = getDefaultConfig('gemini-3.6-flash');
  assert.equal(defaults.geminiModel, 'gemini-3.6-flash');
  assert.equal(defaults.advancedSettings.thinkingBudget, -1);
  assert.equal(defaults.advancedSettings.thinkingLevel, 'high');

  const oldFlashDefaults = getModelSpecificDefaults('gemini-3-flash-preview');
  for (const model of ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash-preview']) {
    assert.deepEqual(getModelSpecificDefaults(model), oldFlashDefaults);
  }
  const oldLiteDefaults = getModelSpecificDefaults('gemini-3.1-flash-lite');
  for (const model of ['gemini-3.5-flash-lite', 'gemini-3.8-flash-lite-preview']) {
    assert.deepEqual(getModelSpecificDefaults(model), oldLiteDefaults);
  }

  const normalized = normalizeConfig({
    geminiApiKey: 'AQ.saved.key',
    geminiModel: 'models/gemini-3.5-flash-lite',
    advancedSettings: {
      enabled: true,
      geminiModel: 'models/gemini-3.7-flash',
      thinkingLevel: 'HIGH'
    }
  });
  assert.equal(normalized.geminiApiKey, 'AQ.saved.key');
  assert.equal(normalized.geminiModel, 'gemini-3.5-flash-lite');
  assert.equal(normalized.advancedSettings.geminiModel, 'gemini-3.7-flash');
  assert.equal(normalized.advancedSettings.thinkingLevel, 'high');
});

test('base-model selections apply their cloned runtime defaults without enabling advanced overrides', async () => {
  const flashConfig = getDefaultConfig('gemini-3.6-flash');
  flashConfig.geminiApiKey = 'AQ.test-key';
  flashConfig.advancedSettings.enabled = false;

  const currentFlash = await createTranslationProvider(flashConfig);
  assert.equal(currentFlash.provider.model, 'gemini-3.6-flash');
  assert.equal(currentFlash.provider.thinkingBudget, -1);
  assert.equal(currentFlash.provider.thinkingLevel, 'high');
  assert.equal(currentFlash.provider.temperature, 0.5);

  const legacyFlashConfig = getDefaultConfig('gemini-2.5-flash');
  legacyFlashConfig.geminiApiKey = 'legacy-test-key';
  legacyFlashConfig.advancedSettings.enabled = false;

  const legacyFlash = await createTranslationProvider(legacyFlashConfig);
  assert.equal(legacyFlash.provider.model, 'gemini-2.5-flash');
  assert.equal(legacyFlash.provider.thinkingBudget, -1);
  assert.equal(legacyFlash.provider.thinkingLevel, '');
  assert.equal(legacyFlash.provider.temperature, 0.5);
});

test('Configure and Toolbox pages expose current Gemini choices and model-aware controls', async () => {
  const html = fs.readFileSync(path.join(projectRoot, 'public', 'partials', 'main.html'), 'utf8');
  const requiredModels = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash'
  ];

  for (const model of requiredModels) {
    assert.match(html, new RegExp(`value=["']${model}["']`));
  }
  assert.match(html, /id="advancedThinkingLevel"/);
  assert.doesNotMatch(html, /value="gemini-3-pro-preview"/);

  const uploadPage = generateFileTranslationPage(
    'tt-test',
    'test-config',
    getDefaultConfig('gemini-3.7-flash'),
    'test.srt'
  );
  assert.match(uploadPage, /id="advancedThinkingLevel"/);
  assert.match(uploadPage, /thinkingLevel: usesThinkingLevel \? thinkingLevel : undefined/);
  assert.match(uploadPage, /function getGeminiModelFamilyDefaults/);
  assert.match(uploadPage, /applyGeminiModelDefaults\(advancedModel\.value\)/);

  const toolboxConfig = getDefaultConfig('gemini-3.7-flash');
  toolboxConfig.geminiApiKey = 'AQ.test-key';
  toolboxConfig.multiProviderEnabled = true;
  toolboxConfig.mainProvider = 'gemini';
  const [embeddedPage, autoPage] = await Promise.all([
    generateEmbeddedSubtitlePage('test-config', '', '', toolboxConfig),
    generateAutoSubtitlePage('test-config', '', '', toolboxConfig)
  ]);
  assert.match(embeddedPage, /Gemini \(gemini-3\.7-flash\)/);
  assert.match(autoPage, /Gemini \(gemini-3\.7-flash\)/);

  for (const page of [uploadPage, embeddedPage, autoPage]) {
    for (const match of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (match[1].trim()) new vm.Script(match[1]);
    }
  }
});
