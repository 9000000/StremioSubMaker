'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  OutboundConcurrencyLimiter,
  OutboundConcurrencyLimitError
} = require('./outboundConcurrencyLimiter');
const {
  PROVIDER_AUTH_FAILURE_CACHE_MAX,
  getProviderAuthFailureCacheKey,
  hasCachedProviderAuthFailure,
  cacheProviderAuthFailure,
  resetProviderAuthFailureCache,
  getProviderAuthFailureCacheStats
} = require('./providerAuthFailureCache');

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('provider authentication failures use a hard-bounded local LRU', async () => {
  resetProviderAuthFailureCache();
  try {
    const rawKey = 'attacker-controlled-secret';
    const cacheKey = getProviderAuthFailureCacheKey('gemini', rawKey);
    assert.ok(cacheKey);
    assert.equal(cacheKey.includes(rawKey), false);

    for (let index = 0; index < PROVIDER_AUTH_FAILURE_CACHE_MAX + 250; index += 1) {
      await cacheProviderAuthFailure(`gemini:test-${index}`, { shared: false });
    }

    assert.deepEqual(getProviderAuthFailureCacheStats(), {
      size: PROVIDER_AUTH_FAILURE_CACHE_MAX,
      max: PROVIDER_AUTH_FAILURE_CACHE_MAX
    });
    assert.equal(
      await hasCachedProviderAuthFailure(`gemini:test-${PROVIDER_AUTH_FAILURE_CACHE_MAX + 249}`),
      true
    );
  } finally {
    resetProviderAuthFailureCache();
  }
});

test('custom endpoint concurrency is bounded globally and per hostname', async () => {
  const limiter = new OutboundConcurrencyLimiter({ maxGlobal: 2, maxPerHost: 1 });
  const releaseFirst = limiter.acquire('https://models.example.test/v1');

  assert.throws(
    () => limiter.acquire('https://models.example.test:8443/other'),
    error => error instanceof OutboundConcurrencyLimitError && error.scope === 'host'
  );

  const releaseSecond = limiter.acquire('https://other.example.test/v1');
  assert.throws(
    () => limiter.acquire('https://third.example.test/v1'),
    error => error instanceof OutboundConcurrencyLimitError && error.scope === 'global'
  );
  assert.equal(limiter.getStats().activeGlobal, 2);
  assert.equal(limiter.getStats().activeHosts, 2);

  releaseFirst();
  releaseFirst();
  releaseSecond();
  assert.equal(limiter.getStats().activeGlobal, 0);
  assert.equal(limiter.getStats().activeHosts, 0);

  await assert.rejects(
    limiter.run('https://models.example.test/v1', async () => {
      throw new Error('upstream failed');
    }),
    /upstream failed/
  );
  assert.equal(limiter.getStats().activeGlobal, 0);
  assert.equal(limiter.getStats().activeHosts, 0);
});

test('outbound discovery routes require rate limits and a resolved session capability', () => {
  const serverSource = readWorkspaceFile('index.js');
  const configSource = readWorkspaceFile('public/config.js');
  const geminiSource = readWorkspaceFile('src/services/gemini.js');
  const wyzieSource = readWorkspaceFile('src/services/wyzieSubs.js');

  assert.match(serverSource, /app\.post\('\/api\/gemini-models', validationLimiter/);
  assert.match(serverSource, /app\.post\('\/api\/models\/:provider', validationLimiter/);
  assert.match(serverSource, /app\.post\('\/api\/validate-assemblyai', validationLimiter/);
  assert.match(serverSource, /async function resolveModelDiscoveryConfig/);
  assert.match(serverSource, /resolveConfigGuarded\(configStr, req, res, contextLabel, t\)/);
  assert.match(serverSource, /customEndpointConcurrencyLimiter\.run\(/);

  assert.match(configSource, /async function ensureModelDiscoveryConfigToken/);
  assert.match(configSource, /requestBody\.configStr = await ensureModelDiscoveryConfigToken\(\)/);
  assert.match(configSource, /const configStr = await ensureModelDiscoveryConfigToken\(\)/);
  assert.match(configSource, /body: JSON\.stringify\(\{[\s\S]{0,120}configStr/);
  assert.match(serverSource, /bypassAuthFailureCache: true,[\s\S]{0,80}cacheAuthFailures: false/);
  assert.match(serverSource, /wyzie\.validateApiKey\(\{[\s\S]{0,100}cacheAuthFailures: false/);
  assert.match(geminiSource, /cacheAuthFailures && isGeminiAuthFailure\(error\)/);
  assert.match(wyzieSource, /cacheAuthFailures && result\.valid === false/);
});
