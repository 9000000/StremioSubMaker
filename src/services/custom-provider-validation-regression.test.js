'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const axios = require('axios');
const OpenAICompatibleProvider = require('./providers/openaiCompatible');
const { MAX_AI_RESPONSE_BYTES } = require('../utils/resourceLimits');

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
    assert.equal(request.options.maxContentLength, MAX_AI_RESPONSE_BYTES);
  } finally {
    axios.post = originalPost;
  }
});

test('custom provider streaming responses use the same hard byte ceiling', async () => {
  const originalPost = axios.post;
  let request;
  axios.post = async (url, body, options) => {
    request = { url, body, options };
    return {
      headers: { 'content-type': 'text/event-stream' },
      data: Readable.from([
        'data: {"choices":[{"delta":{"content":"Olá"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    };
  };

  try {
    const provider = new OpenAICompatibleProvider({
      providerName: 'custom',
      baseUrl: 'https://llm.example.test/v1/',
      apiKey: 'custom-secret-key',
      model: 'local-model:latest',
      maxRetries: 0
    });

    const result = await provider.streamTranslateSubtitle('Hello', 'English', 'Portuguese');
    assert.equal(result, 'Olá');
    assert.equal(request.options.responseType, 'stream');
    assert.equal(request.options.maxContentLength, MAX_AI_RESPONSE_BYTES);
  } finally {
    axios.post = originalPost;
  }
});

test('oversized custom-provider responses fail without retry amplification', async () => {
  const originalPost = axios.post;
  let calls = 0;
  axios.post = async () => {
    calls++;
    const error = new Error(`maxContentLength size of ${MAX_AI_RESPONSE_BYTES} exceeded`);
    error.code = 'ERR_BAD_RESPONSE';
    throw error;
  };

  try {
    const provider = new OpenAICompatibleProvider({
      providerName: 'custom',
      baseUrl: 'https://llm.example.test/v1/',
      model: 'local-model:latest',
      maxRetries: 3
    });

    await assert.rejects(
      provider.translateSubtitle('Hello', 'English', 'Portuguese'),
      error => error.translationErrorType === 'RESPONSE_TOO_LARGE'
    );
    assert.equal(calls, 1);
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
