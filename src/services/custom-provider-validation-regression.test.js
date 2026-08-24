'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const OpenAICompatibleProvider = require('./providers/openaiCompatible');

const projectRoot = path.resolve(__dirname, '..', '..');

test('custom provider validation sends a minimal request with the entered URL, key, and model', async () => {
  const originalPost = axios.post;
  let request;
  axios.post = async (url, body, options) => {
    request = { url, body, options };
    return { data: { choices: [{ message: { content: 'OK' } }] } };
  };

  try {
    const provider = new OpenAICompatibleProvider({
      providerName: 'custom',
      baseUrl: 'https://llm.example.test/v1/',
      apiKey: 'custom-secret-key',
      model: 'local-model:latest',
      temperature: 0,
      topP: 1,
      maxOutputTokens: 16,
      translationTimeout: 15,
      maxRetries: 0
    });

    assert.equal(await provider.validateConfiguration(), true);
    assert.equal(request.url, 'https://llm.example.test/v1/chat/completions');
    assert.equal(request.body.model, 'local-model:latest');
    assert.equal(request.body.max_tokens, 16);
    assert.equal(request.body.stream, false);
    assert.match(request.body.messages[1].content, /Reply with exactly: OK/);
    assert.equal(request.options.headers.Authorization, 'Bearer custom-secret-key');
    assert.equal(request.options.timeout, 15000);
  } finally {
    axios.post = originalPost;
  }
});

test('custom provider test UI and endpoint retain server-side request protections', () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, 'index.js'), 'utf8');
  const configSource = fs.readFileSync(path.join(projectRoot, 'public', 'config.js'), 'utf8');
  const mainPartial = fs.readFileSync(path.join(projectRoot, 'public', 'partials', 'main.html'), 'utf8');

  assert.match(mainPartial, /id="validateCustomProvider"[\s\S]{0,250}config\.providersUi\.testConnection/);
  assert.match(configSource, /validateCustomProviderConfiguration\(\)/);
  assert.match(configSource, /fetch\('\/api\/validate-custom-provider'/);
  assert.match(configSource, /key !== 'custom'[\s\S]{0,180}fetchProviderModels/);

  assert.match(serverSource, /app\.post\('\/api\/validate-custom-provider', validationLimiter/);
  assert.match(serverSource, /validateCustomBaseUrl\(rawBaseUrl\)/);
  assert.match(serverSource, /createProviderInstance\([\s\S]{0,120}'custom'/);
  assert.match(serverSource, /maxOutputTokens: 16/);
  assert.match(serverSource, /translationTimeout: 15/);
  assert.match(serverSource, /await provider\.validateConfiguration\(\)/);
  assert.match(serverSource, /setNoStore\(res\)/);
  assert.match(serverSource, /'\/api\/validate-custom-provider'/);
});
