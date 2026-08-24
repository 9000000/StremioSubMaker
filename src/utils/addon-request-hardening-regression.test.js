const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('normal manifest request tracing is opt-in', () => {
  const source = readWorkspaceFile('index.js');
  const traceStart = source.indexOf('const REQUEST_TRACE_URL_LIMIT');
  const traceEnd = source.indexOf('// FIRST-IN-CHAIN request trace', traceStart);

  assert.notEqual(traceStart, -1, 'request trace settings should be present');
  assert.notEqual(traceEnd, -1, 'request trace middleware marker should be present');

  const traceConfig = source.slice(traceStart, traceEnd);
  assert.match(traceConfig, /TRACE_SUBTITLE_SEARCH_REQUESTS = process\.env\.TRACE_SUBTITLE_SEARCH_REQUESTS !== 'false'/);
  assert.match(traceConfig, /TRACE_MANIFEST_REQUESTS = process\.env\.TRACE_MANIFEST_REQUESTS === 'true'/);
  assert.match(traceConfig, /function redactRequestUrlForLogs/);
  assert.match(traceConfig, /formatRequestTraceUrl[\s\S]*redactRequestUrlForLogs/);
  assert.match(source, /const safeRequestPath = redactRequestUrlForLogs\(requestPath\)/);
  assert.match(source, /const safeRawUrl = redactRequestUrlForLogs\(rawUrl\)/);
});

test('addon manifest responses are internally cached and invalidated on session changes', () => {
  const source = readWorkspaceFile('index.js');
  const manifestRouteStart = source.indexOf("app.get('/addon/:config/manifest.json'");
  const manifestRouteEnd = source.indexOf('// Custom route: Handle base addon path', manifestRouteStart);
  const eventStart = source.indexOf('// Keep router cache aligned with latest session config');
  const eventEnd = source.indexOf('// Download cache is now', eventStart);

  assert.notEqual(manifestRouteStart, -1, 'configured manifest route should exist');
  assert.notEqual(manifestRouteEnd, -1, 'manifest route end marker should exist');
  assert.notEqual(eventStart, -1, 'session event handlers should exist');
  assert.notEqual(eventEnd, -1, 'session event handler end marker should exist');

  const manifestRoute = source.slice(manifestRouteStart, manifestRouteEnd);
  assert.match(source, /const manifestResponseCache = new LRUCache/);
  assert.match(manifestRoute, /manifestResponseCache\.get\(manifestCacheKey\)/);
  assert.match(manifestRoute, /deduplicate\(`manifest:\$\{manifestCacheKey\}`/);
  assert.match(manifestRoute, /manifestResponseCache\.set\(manifestCacheKey/);
  assert.match(manifestRoute, /isSafeToCache\(config\) \|\| isInvalidSessionConfig\(config\)/);
  assert.match(manifestRoute, /setNoStore\(res\)/);

  const eventHandlers = source.slice(eventStart, eventEnd);
  assert.ok((eventHandlers.match(/invalidateManifestCache\(token\)/g) || []).length >= 4);
});

test('missing session tokens are short-cached and invalidated on session events', () => {
  const source = readWorkspaceFile('index.js');
  const resolverStart = source.indexOf('// Resolve config synchronously for base64');
  const resolverEnd = source.indexOf('// Custom route: Download subtitle', resolverStart);
  const eventStart = source.indexOf('// Keep router cache aligned with latest session config');
  const eventEnd = source.indexOf('// Download cache is now', eventStart);

  assert.notEqual(resolverStart, -1, 'resolver marker should exist');
  assert.notEqual(resolverEnd, -1, 'resolver end marker should exist');
  assert.notEqual(eventStart, -1, 'session event handlers should exist');
  assert.notEqual(eventEnd, -1, 'session event handler end marker should exist');

  const resolverSource = source.slice(resolverStart, resolverEnd);
  assert.match(source, /const missingSessionTokenCache = new LRUCache/);
  assert.match(resolverSource, /missingSessionTokenCache\.has\(configStr\)/);
  assert.match(resolverSource, /missingSessionTokenCache\.set\(configStr, true\)/);
  assert.match(source, /function createMissingSessionConfig/);

  const eventHandlers = source.slice(eventStart, eventEnd);
  assert.match(eventHandlers, /sessionCreated/);
  assert.ok((eventHandlers.match(/invalidateMissingSessionTokenCache\(token\)/g) || []).length >= 4);
});

test('addon subtitle searches are rate limited before SDK router fan-out', () => {
  const source = readWorkspaceFile('index.js');
  const limiterDefinition = source.indexOf('const addonSubtitleSearchLimiter = rateLimit');
  const limiterMount = source.indexOf("app.use('/addon/:config/subtitles', addonSubtitleSearchLimiter);");
  const routerMount = source.indexOf('// Mount Stremio SDK router for each configuration');

  assert.notEqual(limiterDefinition, -1, 'addon subtitle limiter should be defined');
  assert.notEqual(limiterMount, -1, 'addon subtitle limiter should be mounted');
  assert.notEqual(routerMount, -1, 'SDK router mount marker should exist');
  assert.ok(limiterMount < routerMount, 'subtitle limiter must run before SDK router construction');

  const limiterSource = source.slice(limiterDefinition, source.indexOf('});', limiterDefinition) + 3);
  assert.match(limiterSource, /ADDON_SUBTITLE_SEARCH_RATE_LIMIT_PER_MINUTE/);
  assert.match(limiterSource, /json\(\{ subtitles: \[\] \}\)/);
});

test('toolbox provider searches and embedded delivery conversion are rate limited', () => {
  const source = readWorkspaceFile('index.js');

  assert.match(
    source,
    /app\.get\('\/api\/subtitle-sync\/subtitles', searchLimiter, async \(req, res\) =>/
  );
  assert.match(source, /const embeddedDeliveryLimiter = rateLimit\(\{/);
  assert.match(source, /createRateLimitRedisStore\('rl:embeddeddelivery:'\)/);
  assert.match(
    source,
    /app\.post\('\/api\/prepare-embedded-track-delivery', embeddedDeliveryLimiter, async \(req, res\) =>/
  );
});

test('API-key subtitle providers are skipped before fan-out when unconfigured', () => {
  const handlerSource = readWorkspaceFile('src/handlers/subtitles.js');
  const configSource = readWorkspaceFile('src/utils/config.js');

  assert.match(handlerSource, /const wyzieApiKey = normalizeProviderApiKey/);
  assert.match(handlerSource, /config\.subtitleProviders\?\.wyzie\?\.enabled && wyzieApiKey/);
  assert.match(handlerSource, /Wyzie Subs provider has no API key; treating it as not selected/);
  assert.match(handlerSource, /const subsroApiKey = normalizeProviderApiKey/);
  assert.match(handlerSource, /config\.subtitleProviders\?\.subsro\?\.enabled && subsroApiKey/);
  assert.match(configSource, /normalizeApiKeySubtitleProvider\(mergedConfig, config, 'subsro'\)/);
  assert.match(configSource, /const normalizedEnabled = wyzieConfig\.enabled === true && !!normalizedApiKey/);
});

test('session-backed requests fail fast while storage is still initializing', () => {
  const source = readWorkspaceFile('index.js');
  const readinessStart = source.indexOf('const SESSION_READINESS_REQUEST_TIMEOUT_MS');
  const readinessEnd = source.indexOf("app.get('/configure/:config/'", readinessStart);

  assert.notEqual(readinessStart, -1, 'bounded readiness wait should be configured');
  assert.notEqual(readinessEnd, -1, 'readiness middleware end marker should exist');

  const readinessSource = source.slice(readinessStart, readinessEnd);
  assert.match(readinessSource, /Promise\.race\(\[sessionManager\.waitUntilReady\(\), timeout\]\)/);
  assert.match(readinessSource, /SESSION_READINESS_TIMEOUT/);
  assert.match(readinessSource, /setHeader\('Retry-After', '5'\)/);
  assert.match(readinessSource, /status\(503\)/);
  assert.match(readinessSource, /retryable: true/);
});

test('configuration service worker versioning does not normally depend on session storage', () => {
  const source = readWorkspaceFile('public/sw.js');

  assert.match(source, /function getRegisteredAppVersion\(\)/);
  assert.match(source, /searchParams\.get\('_cb'\)/);
  assert.match(source, /if \(registeredVersion\) return registeredVersion/);
  assert.match(source, /VERSION_LOOKUP_TIMEOUT_MS = 3000/);
  assert.match(source, /signal: controller\.signal/);
});

test('session creation is confined to the limited POST endpoint', () => {
  const source = readWorkspaceFile('index.js');
  const configSource = readWorkspaceFile('public/config.js');
  const quickSetupSource = readWorkspaceFile('public/js/quick-setup.js');

  const createStart = source.indexOf("app.post('/api/create-session'");
  const updateStart = source.indexOf("app.post('/api/update-session/:token'");
  const getStart = source.indexOf("app.get('/api/get-session/:token'");
  const getEnd = source.indexOf('// API endpoint to translate uploaded subtitle file', getStart);
  const errorStart = source.indexOf("app.get('/addon/:config/error-subtitle/:errorType.srt'");
  const errorEnd = source.indexOf('// Custom route: Perform translation', errorStart);

  assert.notEqual(createStart, -1);
  assert.notEqual(updateStart, -1);
  assert.notEqual(getStart, -1);
  assert.notEqual(getEnd, -1);
  assert.notEqual(errorStart, -1);
  assert.notEqual(errorEnd, -1);

  assert.match(source.slice(createStart, updateStart), /sessionCreationLimiter/);
  assert.match(source.slice(createStart, updateStart), /sessionManager\.createSession\(config\)/);
  assert.doesNotMatch(source.slice(updateStart, getStart), /sessionManager\.createSession/);
  assert.match(source.slice(updateStart, getStart), /status\(404\)/);
  assert.doesNotMatch(source.slice(getStart, getEnd), /createSession|regenerateDefaultConfig|autoRegenerate/);
  assert.doesNotMatch(source.slice(errorStart, errorEnd), /sessionManager\.createSession|regenerateDefaultConfig|allowRegenerate/);
  assert.doesNotMatch(source, /function regenerateDefaultConfig/);
  assert.doesNotMatch(configSource, /autoRegenerate=true/);

  assert.match(quickSetupSource, /resp\.status === 404 \|\| resp\.status === 410/);
  assert.match(quickSetupSource, /fetch\('\/api\/create-session'/);
});

test('session creation persists before populating the bounded memory cache', () => {
  const source = readWorkspaceFile('src/utils/sessionManager.js');
  const createStart = source.indexOf('async createSession(config)');
  const createEnd = source.indexOf('/**\n     * Get a session by token', createStart);
  const createSource = source.slice(createStart, createEnd);

  const durableAdmission = createSource.indexOf('await adapter.createSession(');
  const memoryAdmission = createSource.indexOf('this.cache.set(token, sessionData)');

  assert.ok(durableAdmission >= 0, 'new sessions must use storage admission');
  assert.ok(memoryAdmission > durableAdmission, 'storage admission must happen before memory LRU insertion');
  assert.doesNotMatch(createSource, /verification = await adapter\.get/);
});

test('session capacity handling cannot purge live sessions or add ElfHosted byte bookkeeping', () => {
  const source = readWorkspaceFile('src/utils/sessionManager.js');

  assert.doesNotMatch(source, /purgeOldestSessions/);
  assert.match(source, /const storageBytes = this\.storageMaxBytes\s*\? await adapter\.size/);
  assert.match(source, /indexedCount !== actualCount \|\| this\.storageMaxBytes/);
});
