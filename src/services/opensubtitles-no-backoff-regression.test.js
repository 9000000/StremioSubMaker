const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LOG_TO_FILE = 'false';
process.env.LOG_LEVEL = 'error';
process.env.OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY || 'test-api-key';

test('OpenSubtitles Auth does not define login backoff/cooldown controls', () => {
  const OpenSubtitlesService = require('./opensubtitles');
  const source = fs.readFileSync(path.join(__dirname, 'opensubtitles.js'), 'utf8');
  const exportedTestingApi = OpenSubtitlesService.__testing || {};

  for (const token of [
    'OPENSUBTITLES_LOGIN_BACKOFF',
    'LOGIN_RATE_LIMIT_BACKOFF',
    'DISTRIBUTED_LOGIN_BACKOFF',
    'recordOpenSubtitlesLoginRateLimit',
    'getOpenSubtitlesLoginBackoff',
    'clearOpenSubtitlesLoginBackoff',
    'assertOpenSubtitlesLoginBackoffClear',
    'createLoginBackoffError',
    'temporarily cooling down'
  ]) {
    assert.equal(source.includes(token), false, `${token} should not exist in opensubtitles.js`);
  }

  assert.equal('recordOpenSubtitlesLoginRateLimit' in exportedTestingApi, false);
  assert.equal('getOpenSubtitlesLoginBackoff' in exportedTestingApi, false);
  assert.equal('clearOpenSubtitlesLoginBackoff' in exportedTestingApi, false);
});

test('OpenSubtitles Auth caches invalid credentials for 10 minutes', () => {
  const OpenSubtitlesService = require('./opensubtitles');
  assert.equal(OpenSubtitlesService.__testing.AUTH_FAILURE_TTL_MS, 10 * 60 * 1000);
});

test('SubDL caches invalid API keys and blocks repeated searches', async () => {
  const sharedCache = require('../utils/sharedCache');
  const {
    resetProviderAuthFailureCache,
    PROVIDER_AUTH_FAILURE_TTL_MS
  } = require('../utils/providerAuthFailureCache');
  const SubDLService = require('./subdl');
  const originalGetShared = sharedCache.getShared;
  const originalSetShared = sharedCache.setShared;
  const originalDeleteShared = sharedCache.deleteShared;

  sharedCache.getShared = async () => null;
  sharedCache.setShared = async () => true;
  sharedCache.deleteShared = async () => true;
  resetProviderAuthFailureCache();

  try {
    assert.equal(PROVIDER_AUTH_FAILURE_TTL_MS, 10 * 60 * 1000);

    const service = new SubDLService('bad-subdl-key');
    let searchCalls = 0;
    service.client = {
      get: async () => {
        searchCalls += 1;
        const error = new Error('Request failed with status code 403');
        error.response = {
          status: 403,
          data: { message: 'Not Authorized', status: false }
        };
        throw error;
      }
    };

    const params = {
      imdb_id: 'tt1234567',
      type: 'movie',
      languages: ['eng'],
      providerTimeout: 1000
    };

    assert.deepEqual(await service.searchSubtitles(params), []);
    assert.equal(searchCalls, 1);

    assert.deepEqual(await service.searchSubtitles(params), []);
    assert.equal(searchCalls, 1);
  } finally {
    resetProviderAuthFailureCache();
    sharedCache.getShared = originalGetShared;
    sharedCache.setShared = originalSetShared;
    sharedCache.deleteShared = originalDeleteShared;
  }
});

test('Wyzie caches invalid API keys and blocks repeated searches', async () => {
  const sharedCache = require('../utils/sharedCache');
  const { resetProviderAuthFailureCache } = require('../utils/providerAuthFailureCache');
  const WyzieSubsService = require('./wyzieSubs');
  const originalGetShared = sharedCache.getShared;
  const originalSetShared = sharedCache.setShared;
  const originalDeleteShared = sharedCache.deleteShared;

  sharedCache.getShared = async () => null;
  sharedCache.setShared = async () => true;
  sharedCache.deleteShared = async () => true;
  resetProviderAuthFailureCache();

  try {
    const service = new WyzieSubsService('bad-wyzie-key');
    let searchCalls = 0;
    service.client = {
      get: async () => {
        searchCalls += 1;
        const error = new Error('Request failed with status code 403');
        error.response = {
          status: 403,
          data: { details: 'Invalid API key' }
        };
        throw error;
      }
    };

    const params = {
      imdb_id: 'tt1234567',
      type: 'movie',
      languages: ['eng'],
      sources: { opensubtitles: true },
      providerTimeout: 1000
    };

    assert.deepEqual(await service.searchSubtitles(params), []);
    assert.equal(searchCalls, 1);

    assert.deepEqual(await service.searchSubtitles(params), []);
    assert.equal(searchCalls, 1);
  } finally {
    resetProviderAuthFailureCache();
    sharedCache.getShared = originalGetShared;
    sharedCache.setShared = originalSetShared;
    sharedCache.deleteShared = originalDeleteShared;
  }
});

test('OpenAI-compatible model fetch caches invalid API keys', async () => {
  const axios = require('axios');
  const sharedCache = require('../utils/sharedCache');
  const { resetProviderAuthFailureCache } = require('../utils/providerAuthFailureCache');
  const OpenAICompatibleProvider = require('./providers/openaiCompatible');
  const originalAxiosGet = axios.get;
  const originalGetShared = sharedCache.getShared;
  const originalSetShared = sharedCache.setShared;
  const originalDeleteShared = sharedCache.deleteShared;

  sharedCache.getShared = async () => null;
  sharedCache.setShared = async () => true;
  sharedCache.deleteShared = async () => true;
  resetProviderAuthFailureCache();

  try {
    let modelCalls = 0;
    axios.get = async () => {
      modelCalls += 1;
      const error = new Error('Request failed with status code 401');
      error.response = {
        status: 401,
        data: { error: { message: 'Invalid API key' } }
      };
      throw error;
    };

    const provider = new OpenAICompatibleProvider({
      apiKey: 'bad-openai-key',
      providerName: 'openai',
      baseUrl: 'https://api.openai.com/v1'
    });

    assert.deepEqual(await provider.getAvailableModels(), []);
    assert.equal(modelCalls, 1);

    assert.deepEqual(await provider.getAvailableModels(), []);
    assert.equal(modelCalls, 1);
  } finally {
    axios.get = originalAxiosGet;
    resetProviderAuthFailureCache();
    sharedCache.getShared = originalGetShared;
    sharedCache.setShared = originalSetShared;
    sharedCache.deleteShared = originalDeleteShared;
  }
});

test('Gemini model fetch caches invalid API keys', async () => {
  const axios = require('axios');
  const sharedCache = require('../utils/sharedCache');
  const { resetProviderAuthFailureCache } = require('../utils/providerAuthFailureCache');
  const GeminiService = require('./gemini');
  const originalAxiosGet = axios.get;
  const originalGetShared = sharedCache.getShared;
  const originalSetShared = sharedCache.setShared;
  const originalDeleteShared = sharedCache.deleteShared;

  sharedCache.getShared = async () => null;
  sharedCache.setShared = async () => true;
  sharedCache.deleteShared = async () => true;
  resetProviderAuthFailureCache();

  try {
    let modelCalls = 0;
    axios.get = async () => {
      modelCalls += 1;
      const error = new Error('API key not valid');
      error.response = {
        status: 400,
        data: { error: { message: 'API key not valid. Please pass a valid API key.' } }
      };
      throw error;
    };

    const gemini = new GeminiService('bad-gemini-key', 'gemini-flash-lite-latest');

    assert.deepEqual(await gemini.getAvailableModels(), []);
    assert.equal(modelCalls, 1);

    assert.deepEqual(await gemini.getAvailableModels(), []);
    assert.equal(modelCalls, 1);
  } finally {
    axios.get = originalAxiosGet;
    resetProviderAuthFailureCache();
    sharedCache.getShared = originalGetShared;
    sharedCache.setShared = originalSetShared;
    sharedCache.deleteShared = originalDeleteShared;
  }
});

test('OpenSubtitles Auth reuses a valid JWT for search without logging in', async () => {
  const sharedCache = require('../utils/sharedCache');
  const OpenSubtitlesService = require('./opensubtitles');
  const originalGetStorageAdapter = sharedCache.getStorageAdapter;
  sharedCache.getStorageAdapter = async () => ({ client: null });
  OpenSubtitlesService.__testing.resetRateLimiterState();

  try {
    const service = new OpenSubtitlesService({
      username: 'user',
      password: 'pass'
    });
    service.token = 'cached-jwt';
    service.tokenExpiry = Date.now() + 60 * 60 * 1000;

    let loginCalls = 0;
    let searchCalls = 0;
    service.login = async () => {
      loginCalls += 1;
      throw new Error('login should not be called with a valid JWT');
    };
    let authorizationHeader = null;
    service.client.defaults.adapter = async (requestConfig) => {
      searchCalls += 1;
      authorizationHeader = requestConfig.headers?.get
        ? requestConfig.headers.get('Authorization')
        : requestConfig.headers?.Authorization;
      return {
        data: { data: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: requestConfig
      };
    };

    const results = await service.searchSubtitles({
      imdb_id: 'tt1234567',
      type: 'movie',
      languages: ['eng'],
      providerTimeout: 12000
    });

    assert.deepEqual(results, []);
    assert.equal(searchCalls, 1);
    assert.equal(loginCalls, 0);
    assert.equal(authorizationHeader, 'Bearer cached-jwt');
  } finally {
    sharedCache.getStorageAdapter = originalGetStorageAdapter;
    OpenSubtitlesService.__testing.resetRateLimiterState();
  }
});

test('OpenSubtitles Auth does not relogin on 406 download quota responses', async () => {
  const sharedCache = require('../utils/sharedCache');
  const OpenSubtitlesService = require('./opensubtitles');
  const originalGetStorageAdapter = sharedCache.getStorageAdapter;
  sharedCache.getStorageAdapter = async () => ({ client: null });
  OpenSubtitlesService.__testing.resetRateLimiterState();

  try {
    const service = new OpenSubtitlesService({
      username: 'user',
      password: 'pass'
    });
    service.token = 'cached-jwt';
    service.tokenExpiry = Date.now() + 60 * 60 * 1000;

    let loginCalls = 0;
    let postCalls = 0;
    service.login = async () => {
      loginCalls += 1;
      return 'fresh-jwt';
    };
    service.client.post = async () => {
      postCalls += 1;
      const error = new Error('OpenSubtitles daily quota reached');
      error.response = {
        status: 406,
        headers: {},
        data: {
          message: 'You have downloaded your allowed 20 subtitles for 24h. Your quota will be renewed later.'
        }
      };
      throw error;
    };

    await assert.rejects(
      () => service.downloadSubtitle('12345', { timeout: 12000 }),
      (error) => {
        assert.equal(error.statusCode, 406);
        assert.equal(error.type, 'quota_exceeded');
        return true;
      }
    );

    assert.equal(postCalls, 1);
    assert.equal(loginCalls, 0);
    assert.equal(service.token, 'cached-jwt');
  } finally {
    sharedCache.getStorageAdapter = originalGetStorageAdapter;
    OpenSubtitlesService.__testing.resetRateLimiterState();
  }
});

test('subtitle download delivery routes are not behind the generic search limiter', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

  for (const route of [
    "app.get('/addon/:config/subtitle/:fileId/:language.srt'",
    "app.get('/addon/:config/subtitle/:fileId/:language.sub'",
    "app.get('/addon/:config/subtitle/:fileId/:language'",
    "app.get('/addon/:config/subtitle-resolve/:fileId/:language'",
    "app.get('/addon/:config/subtitle-content/:fileId/:language.:ext'"
  ]) {
    const routeIndex = source.indexOf(route);
    assert.notEqual(routeIndex, -1, `${route} should exist`);
    const routeLine = source.slice(routeIndex, source.indexOf('\n', routeIndex));
    assert.equal(routeLine.includes('searchLimiter'), false, `${route} should not use searchLimiter`);
  }
});
