const axios = require('axios');
const { sanitizeApiKeyForHeader } = require('../utils/security');
const crypto = require('crypto');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError, handleAuthError, parseApiError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { version } = require('../utils/version');
const { appendHiddenInformationalNote } = require('../utils/subtitle');
const { hasExplicitSeasonEpisodeMismatch } = require('../utils/animeSearchResolver');
const log = require('../utils/logger');
const { isTrueishFlag } = require('../utils/subtitleFlags');
const { detectArchiveType, extractSubtitleFromArchive, isArchive, createEpisodeNotFoundSubtitle, createZipTooLargeSubtitle, convertSubtitleToVtt } = require('../utils/archiveExtractor');
const { analyzeResponseContent, createInvalidResponseSubtitle } = require('../utils/responseAnalyzer');

const OPENSUBTITLES_API_URL = 'https://api.opensubtitles.com/api/v1';
const OPENSUBTITLES_VIP_API_URL = 'https://vip-api.opensubtitles.com/api/v1';
const USER_AGENT = `SubMaker v${version}`;
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // hard cap for ZIP downloads (~25MB) to avoid huge packs

const AUTH_FAILURE_TTL_MS = 10 * 60 * 1000; // Suppress repeated bad-credential logins for 10 minutes
const credentialFailureCache = new Map();
const AUTH_FAILURE_PREFIX = 'osauthfail:';

// MULTI-INSTANCE FIX: Token cache is now backed by Redis for cross-pod sharing
// Local Map is used as L1 cache for same-process performance
// Redis is the source of truth, checked when local cache misses
const tokenCacheLocal = new Map();
const TOKEN_CACHE_PREFIX = 'ostoken:';
const TOKEN_TTL_SECONDS = 23 * 60 * 60; // 23 hours (token valid for 24h, 1h buffer)

// Login mutex: prevents multiple concurrent /login calls for the same credentials
// Key: credentialsCacheKey, Value: Promise that resolves when login completes
const loginMutex = new Map();

// ─── OpenSubtitles API rate limiter ───────────────────────────────────────────
// OpenSubtitles enforces a shared per-IP API budget: 5 REST requests / second,
// plus /login has its own 1 request / second rule. Every REST call reserves a
// send timestamp before it is made. /login reserves both gates atomically so the
// actual request cannot slip outside either upstream limit after waiting.
const RATE_LIMIT_MIN_INTERVAL_MS = Math.max(
  250,
  parseInt(process.env.OPENSUBTITLES_API_MIN_INTERVAL_MS || '250', 10) || 250
);
const LOGIN_MIN_INTERVAL_MS = Math.max(
  1250,
  parseInt(process.env.OPENSUBTITLES_LOGIN_MIN_INTERVAL_MS || '1250', 10) || 1250
);
const LOCAL_FALLBACK_MIN_INTERVAL_MS = Math.max(
  RATE_LIMIT_MIN_INTERVAL_MS,
  parseInt(process.env.OPENSUBTITLES_LOCAL_FALLBACK_MIN_INTERVAL_MS || '1100', 10) || 1100
);
const LOCAL_FALLBACK_LOGIN_MIN_INTERVAL_MS = Math.max(
  LOGIN_MIN_INTERVAL_MS,
  parseInt(process.env.OPENSUBTITLES_LOCAL_FALLBACK_LOGIN_MIN_INTERVAL_MS || '2500', 10) || 2500
);
const DEFAULT_RATE_LIMIT_MAX_QUEUE_MS = Math.max(
  0,
  parseInt(process.env.OPENSUBTITLES_API_MAX_QUEUE_MS || '8000', 10) || 8000
);
const RATE_LIMIT_REQUEST_RESERVE_MS = Math.max(
  500,
  parseInt(process.env.OPENSUBTITLES_API_REQUEST_RESERVE_MS || '1500', 10) || 1500
);
const RATE_LIMIT_RETRY_AFTER_FALLBACK_MS = Math.max(
  1000,
  parseInt(process.env.OPENSUBTITLES_RATE_LIMIT_RETRY_AFTER_FALLBACK_MS || '1000', 10) || 1000
);
const RATE_LIMIT_RETRY_AFTER_MAX_MS = Math.max(
  RATE_LIMIT_RETRY_AFTER_FALLBACK_MS,
  parseInt(process.env.OPENSUBTITLES_RATE_LIMIT_RETRY_AFTER_MAX_MS || '60000', 10) || 60000
);
const RATE_LIMIT_HEADER_REMAINING_FLOOR = Math.max(
  0,
  parseInt(process.env.OPENSUBTITLES_HEADER_REMAINING_FLOOR || '0', 10) || 0
);
const LOGIN_SINGLEFLIGHT_LOCK_TTL_MS = Math.max(
  5000,
  parseInt(process.env.OPENSUBTITLES_LOGIN_LOCK_TTL_MS || '30000', 10) || 30000
);
const LOGIN_SINGLEFLIGHT_POLL_MS = Math.max(
  100,
  parseInt(process.env.OPENSUBTITLES_LOGIN_LOCK_POLL_MS || '250', 10) || 250
);
// The Redis hash tag keeps the API and login keys in the same slot on Redis
// Cluster/Sentinel deployments, so the multi-key Lua reservation remains valid.
const DISTRIBUTED_RATE_LIMIT_KEY = '{opensubtitles}:api_next_at';
const DISTRIBUTED_LOGIN_SEND_RATE_LIMIT_KEY = '{opensubtitles}:login_next_at';
const DISTRIBUTED_LOGIN_SINGLEFLIGHT_PREFIX = '{opensubtitles}:login_singleflight:';
const DISTRIBUTED_RATE_LIMIT_TTL_MS = Math.max(60000, RATE_LIMIT_MIN_INTERVAL_MS * 16);
const DISTRIBUTED_LOGIN_SEND_RATE_LIMIT_TTL_MS = Math.max(60000, LOGIN_MIN_INTERVAL_MS * 16);
let _localApiNextAllowedAt = 0;
let _localLoginNextAllowedAt = 0;
let _localRateLimitQueue = Promise.resolve();
let _lastDistributedLimiterWarningAt = 0;
const localLoginSingleflightLocks = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createOpenSubtitlesRateLimitError(message, retryAfterMs = 0) {
  const retryMs = Math.max(0, Math.ceil(Number(retryAfterMs) || 0));
  const error = new Error(message || 'OpenSubtitles API rate limit queue is full');
  error.statusCode = 429;
  error.type = 'rate_limit';
  error.isRetryable = true;
  error.retryAfterMs = retryMs;
  error.openSubtitlesRateLimit = true;
  return error;
}

function createOpenSubtitlesQueueBusyError(message, retryAfterMs = 0) {
  const retryMs = Math.max(0, Math.ceil(Number(retryAfterMs) || 0));
  const error = new Error(message || 'OpenSubtitles API queue is busy');
  error.statusCode = 503;
  error.type = 'service_unavailable';
  error.isRetryable = true;
  error.retryAfterMs = retryMs;
  error.openSubtitlesQueueBusy = true;
  return error;
}

function isOpenSubtitlesRateLimitError(error) {
  return !!(
    error &&
    (
      error.openSubtitlesRateLimit === true ||
      error.type === 'rate_limit' ||
      error.statusCode === 429 ||
      error.response?.status === 429
    )
  );
}

function isOpenSubtitlesTransientProviderError(error) {
  if (!error) {
    return false;
  }

  if (isOpenSubtitlesRateLimitError(error)) {
    return true;
  }

  const statusCode = error.statusCode || error.response?.status;
  const type = error.type;
  const code = error.code || error.originalError?.code;
  return !!(
    error.isRetryable === true ||
    statusCode === 503 ||
    statusCode === 502 ||
    statusCode === 504 ||
    type === 'service_unavailable' ||
    type === 'timeout' ||
    type === 'network' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH'
  );
}

async function getOpenSubtitlesRedisAdapter(options = {}) {
  if (options._forceLocal) {
    return null;
  }

  try {
    const adapter = options.adapter || await require('../utils/sharedCache').getStorageAdapter();
    if (!adapter?.client || typeof adapter._getKey !== 'function') {
      return null;
    }

    if (adapter.client.status && adapter.client.status !== 'ready') {
      return null;
    }

    return adapter;
  } catch (error) {
    log.debug(() => `[OpenSubtitles] Redis coordination unavailable: ${error.message}`);
    return null;
  }
}

function getSessionRedisKey(adapter, key) {
  const { StorageAdapter } = require('../storage');
  return adapter._getKey(key, StorageAdapter.CACHE_TYPES.SESSION);
}

function readLocalLoginSingleflightLock(lockKey) {
  const existing = localLoginSingleflightLocks.get(lockKey);
  if (!existing) {
    return null;
  }

  if (existing.expiresAt <= Date.now()) {
    localLoginSingleflightLocks.delete(lockKey);
    return null;
  }

  return existing;
}

function buildLoginSingleflightLockKey(credentialsCacheKey) {
  return `lock:${DISTRIBUTED_LOGIN_SINGLEFLIGHT_PREFIX}${credentialsCacheKey}`;
}

async function tryAcquireDistributedLoginSingleflightLock(credentialsCacheKey, options = {}) {
  if (!credentialsCacheKey) {
    return { acquired: true, ownerId: 'no-credentials', local: true, credentialsCacheKey };
  }

  const ttlMs = Math.max(1000, Number(options.ttlMs) || LOGIN_SINGLEFLIGHT_LOCK_TTL_MS);
  const ownerId = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const lockKey = buildLoginSingleflightLockKey(credentialsCacheKey);

  const adapter = await getOpenSubtitlesRedisAdapter(options);
  if (!adapter) {
    const existing = readLocalLoginSingleflightLock(lockKey);
    if (existing) {
      return {
        acquired: false,
        ownerId: null,
        local: true,
        credentialsCacheKey,
        lockKey,
        retryAfterMs: Math.max(0, Math.ceil(existing.expiresAt - Date.now()))
      };
    }

    localLoginSingleflightLocks.set(lockKey, {
      ownerId,
      expiresAt: Date.now() + ttlMs
    });
    return { acquired: true, ownerId, local: true, credentialsCacheKey, lockKey, retryAfterMs: 0 };
  }

  try {
    const fullKey = getSessionRedisKey(adapter, lockKey);
    const result = await adapter.client.set(fullKey, ownerId, 'PX', ttlMs, 'NX');
    if (result === 'OK') {
      log.debug(() => `[OpenSubtitles] Acquired distributed login singleflight lock for credentials ${credentialsCacheKey.slice(0, 8)}...`);
      return { acquired: true, ownerId, local: false, credentialsCacheKey, lockKey, retryAfterMs: 0 };
    }

    const ttl = await adapter.client.pttl(fullKey);
    return {
      acquired: false,
      ownerId: null,
      local: false,
      credentialsCacheKey,
      lockKey,
      retryAfterMs: ttl > 0 ? ttl : LOGIN_SINGLEFLIGHT_POLL_MS
    };
  } catch (error) {
    log.warn(() => `[OpenSubtitles] Distributed login singleflight unavailable; using local fallback: ${error.message}`);
    const existing = readLocalLoginSingleflightLock(lockKey);
    if (existing) {
      return {
        acquired: false,
        ownerId: null,
        local: true,
        credentialsCacheKey,
        lockKey,
        retryAfterMs: Math.max(0, Math.ceil(existing.expiresAt - Date.now()))
      };
    }

    localLoginSingleflightLocks.set(lockKey, {
      ownerId,
      expiresAt: Date.now() + ttlMs
    });
    return { acquired: true, ownerId, local: true, credentialsCacheKey, lockKey, retryAfterMs: 0 };
  }
}

async function getDistributedLoginSingleflightLockTtl(credentialsCacheKey, options = {}) {
  if (!credentialsCacheKey) {
    return 0;
  }

  const lockKey = buildLoginSingleflightLockKey(credentialsCacheKey);
  const adapter = await getOpenSubtitlesRedisAdapter(options);
  if (!adapter) {
    const existing = readLocalLoginSingleflightLock(lockKey);
    return existing ? Math.max(0, Math.ceil(existing.expiresAt - Date.now())) : 0;
  }

  try {
    const fullKey = getSessionRedisKey(adapter, lockKey);
    const ttl = await adapter.client.pttl(fullKey);
    return ttl > 0 ? ttl : 0;
  } catch (error) {
    log.debug(() => `[OpenSubtitles] Failed to read distributed login singleflight TTL: ${error.message}`);
    return 0;
  }
}

async function releaseDistributedLoginSingleflightLock(lock, options = {}) {
  if (!lock?.acquired || !lock.lockKey || !lock.ownerId) {
    return false;
  }

  if (lock.local) {
    const existing = readLocalLoginSingleflightLock(lock.lockKey);
    if (existing && existing.ownerId === lock.ownerId) {
      localLoginSingleflightLocks.delete(lock.lockKey);
      return true;
    }
    return false;
  }

  const adapter = await getOpenSubtitlesRedisAdapter(options);
  if (!adapter) {
    return false;
  }

  try {
    const fullKey = getSessionRedisKey(adapter, lock.lockKey);
    const released = await adapter.client.eval(`
      local owner = redis.call('get', KEYS[1])
      if owner == ARGV[1] then
        return redis.call('del', KEYS[1])
      end
      return 0
    `, 1, fullKey, lock.ownerId);
    return Number(released) === 1;
  } catch (error) {
    log.debug(() => `[OpenSubtitles] Failed to release distributed login singleflight lock: ${error.message}`);
    return false;
  }
}

function logOpenSubtitlesRateLimitFailure(context, error) {
  const retryAfterMs = Math.max(0, Number(error?.retryAfterMs) || 0);
  const retrySuffix = retryAfterMs > 0 ? ` (retry after ~${Math.ceil(retryAfterMs / 1000)}s)` : '';
  const source = error?.response?.status === 429 ? 'upstream 429 after gated request' : 'limiter refusal before upstream request';
  log.warn(() => `[OpenSubtitles] ${context} ${source}${retrySuffix}: ${error?.message || 'rate limited'}`);
}

function clampRateLimitDelay(ms, fallbackMs = 1500, maxMs = 60000) {
  const parsed = Number(ms);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return Math.max(RATE_LIMIT_MIN_INTERVAL_MS, Math.min(Math.ceil(parsed), maxMs));
}

function parseRateLimitDelayMs(headers = {}, fallbackMs = 1500, maxMs = 60000) {
  const normalized = headers || {};
  const retryAfter = normalized['retry-after'];
  if (retryAfter !== undefined && retryAfter !== null) {
    const retryAfterText = String(retryAfter).trim();
    const retryAfterNumber = Number(retryAfterText);
    if (Number.isFinite(retryAfterNumber) && retryAfterNumber > 0) {
      return clampRateLimitDelay(retryAfterNumber * 1000, fallbackMs, maxMs);
    }

    const retryAfterDate = Date.parse(retryAfterText);
    if (Number.isFinite(retryAfterDate)) {
      return clampRateLimitDelay(retryAfterDate - Date.now(), fallbackMs, maxMs);
    }
  }

  const reset = normalized['ratelimit-reset'] || normalized['x-ratelimit-reset'];
  if (reset !== undefined && reset !== null) {
    const resetText = String(reset).trim();
    const resetNumber = Number(resetText);
    if (Number.isFinite(resetNumber) && resetNumber > 0) {
      if (resetNumber > 1000000000000) {
        return clampRateLimitDelay(resetNumber - Date.now(), fallbackMs, maxMs);
      }
      if (resetNumber > 1000000000) {
        return clampRateLimitDelay((resetNumber * 1000) - Date.now(), fallbackMs, maxMs);
      }
      return clampRateLimitDelay(resetNumber * 1000, fallbackMs, maxMs);
    }

    const resetDate = Date.parse(resetText);
    if (Number.isFinite(resetDate)) {
      return clampRateLimitDelay(resetDate - Date.now(), fallbackMs, maxMs);
    }
  }

  return clampRateLimitDelay(fallbackMs, fallbackMs, maxMs);
}

function resolveRateLimitDeadline(options = {}) {
  const now = Date.now();
  const explicitDeadline = Number(options.deadlineAt);
  if (Number.isFinite(explicitDeadline) && explicitDeadline > 0) {
    return explicitDeadline;
  }

  let maxQueueMs = Number(options.maxQueueWaitMs);
  if (!Number.isFinite(maxQueueMs) || maxQueueMs < 0) {
    maxQueueMs = DEFAULT_RATE_LIMIT_MAX_QUEUE_MS;
  }

  const requestTimeoutMs = Number(options.timeoutMs ?? options.timeout);
  if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
    const timeoutBoundQueueMs = Math.max(0, requestTimeoutMs - RATE_LIMIT_REQUEST_RESERVE_MS);
    maxQueueMs = Math.min(maxQueueMs, timeoutBoundQueueMs);
  }

  return now + Math.max(0, maxQueueMs);
}

function getRateLimitQueueBudgetMs(deadlineAt) {
  const parsed = Number(deadlineAt);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Infinity;
  }
  return parsed - Date.now();
}

function assertRateLimitWaitAllowed(waitMs, deadlineAt, context, reason = 'queue wait') {
  const budgetMs = getRateLimitQueueBudgetMs(deadlineAt);
  if (budgetMs === Infinity) {
    return;
  }

  if (waitMs > 0 && (budgetMs <= 0 || waitMs > budgetMs)) {
    throw createOpenSubtitlesQueueBusyError(
      `OpenSubtitles API ${reason} would exceed request budget for ${context}; leaving upstream untouched`,
      Math.max(waitMs, budgetMs)
    );
  }
}

function fallbackDelayFromLimitHeaders(headers = {}, fallbackMs = RATE_LIMIT_MIN_INTERVAL_MS) {
  const limitSecondRaw = headers['x-ratelimit-limit-second'] ?? headers['ratelimit-limit-second'];
  const limitSecond = Number(limitSecondRaw);
  if (!Number.isFinite(limitSecond) || limitSecond <= 0) {
    return fallbackMs;
  }

  // Add a small buffer so integer limits like 5/sec do not land exactly on the
  // upstream boundary.
  const headerDerivedMs = Math.ceil(1000 / limitSecond) + 50;
  return Math.max(fallbackMs, headerDerivedMs);
}

function getRateLimitDelayMs(waitMs, fallbackMs = RATE_LIMIT_RETRY_AFTER_FALLBACK_MS) {
  return clampRateLimitDelay(waitMs, fallbackMs, RATE_LIMIT_RETRY_AFTER_MAX_MS);
}

function buildApiRateLimitSlot() {
  return {
    name: 'api',
    key: DISTRIBUTED_RATE_LIMIT_KEY,
    intervalMs: RATE_LIMIT_MIN_INTERVAL_MS,
    ttlMs: DISTRIBUTED_RATE_LIMIT_TTL_MS,
    localIntervalMs: LOCAL_FALLBACK_MIN_INTERVAL_MS
  };
}

function buildLoginRateLimitSlot() {
  return {
    name: 'login',
    key: DISTRIBUTED_LOGIN_SEND_RATE_LIMIT_KEY,
    intervalMs: LOGIN_MIN_INTERVAL_MS,
    ttlMs: DISTRIBUTED_LOGIN_SEND_RATE_LIMIT_TTL_MS,
    localIntervalMs: LOCAL_FALLBACK_LOGIN_MIN_INTERVAL_MS
  };
}

function buildOpenSubtitlesRateLimitSlots(kind = 'api') {
  const slots = [buildApiRateLimitSlot()];
  if (kind === 'login') {
    slots.push(buildLoginRateLimitSlot());
  }
  return slots;
}

function getLocalNextAllowedAt(slotName) {
  return slotName === 'login' ? _localLoginNextAllowedAt : _localApiNextAllowedAt;
}

function setLocalNextAllowedAt(slotName, value) {
  if (slotName === 'login') {
    _localLoginNextAllowedAt = Math.max(_localLoginNextAllowedAt, value);
  } else {
    _localApiNextAllowedAt = Math.max(_localApiNextAllowedAt, value);
  }
}

function reserveLocalSlots(slots, options = {}) {
  const task = _localRateLimitQueue.then(() => {
    const now = Date.now();
    let scheduledAt = now;

    for (const slot of slots) {
      scheduledAt = Math.max(scheduledAt, getLocalNextAllowedAt(slot.name));
    }

    const waitMs = Math.max(0, Math.ceil(scheduledAt - now));
    assertRateLimitWaitAllowed(waitMs, options.deadlineAt, options.context || 'local fallback', 'queue wait');

    for (const slot of slots) {
      setLocalNextAllowedAt(slot.name, scheduledAt + slot.localIntervalMs);
    }

    return {
      acquired: true,
      local: true,
      scheduledAt,
      retryAfterMs: waitMs,
      waitMs,
      slots: slots.map(slot => slot.name)
    };
  });

  _localRateLimitQueue = task.catch(() => { });
  return task;
}

function applyLocalRateLimitDelay(waitMs, options = {}) {
  const delayMs = getRateLimitDelayMs(waitMs, options.fallbackMs);
  const targetAt = Date.now() + delayMs;
  const slots = buildOpenSubtitlesRateLimitSlots(options.includeLogin ? 'login' : 'api');

  for (const slot of slots) {
    setLocalNextAllowedAt(slot.name, targetAt);
  }
}

async function tryReserveDistributedOpenSubtitlesSlots(slots, options = {}) {
  try {
    const adapter = options.adapter || await require('../utils/sharedCache').getStorageAdapter();
    const { StorageAdapter } = require('../storage');

    if (!adapter?.client || typeof adapter._getKey !== 'function') {
      return null;
    }

    if (adapter.client.status && adapter.client.status !== 'ready') {
      return null;
    }

    const keys = slots.map(slot => adapter._getKey(`ratelimit:${slot.key}`, StorageAdapter.CACHE_TYPES.SESSION));
    const intervals = slots.map(slot => slot.intervalMs);
    const ttls = slots.map(slot => slot.ttlMs);
    const maxWaitMs = Number.isFinite(Number(options.maxWaitMs)) ? Math.max(0, Math.floor(Number(options.maxWaitMs))) : -1;

    const result = await adapter.client.eval(`
      local timeParts = redis.call('time')
      local nowMs = (tonumber(timeParts[1]) * 1000) + math.floor(tonumber(timeParts[2]) / 1000)
      local slotCount = #KEYS
      local scheduledAt = nowMs
      local maxWaitMs = tonumber(ARGV[(slotCount * 2) + 1])

      for i = 1, slotCount do
        local nextAt = tonumber(redis.call('get', KEYS[i]) or '0')
        if nextAt > scheduledAt then
          scheduledAt = nextAt
        end
      end

      local waitMs = math.max(0, math.ceil(scheduledAt - nowMs))
      if maxWaitMs >= 0 and waitMs > maxWaitMs then
        return {0, scheduledAt, waitMs, nowMs}
      end

      for i = 1, slotCount do
        local intervalMs = tonumber(ARGV[i])
        local ttlMs = tonumber(ARGV[slotCount + i])
        redis.call('psetex', KEYS[i], ttlMs, scheduledAt + intervalMs)
      end

      return {1, scheduledAt, waitMs, nowMs}
    `, keys.length, ...keys, ...intervals, ...ttls, maxWaitMs);

    const acquired = Number(result?.[0]) === 1;
    const scheduledAt = Number(result?.[1]) || 0;
    const retryAfterMs = Math.max(0, Number(result?.[2]) || 0);
    const nowMs = Number(result?.[3]) || 0;
    return {
      acquired,
      count: acquired ? 1 : 0,
      scheduledAt,
      nextAt: scheduledAt,
      retryAfterMs,
      waitMs: retryAfterMs,
      nowMs,
      slots: slots.map(slot => slot.name)
    };
  } catch (error) {
    log.debug(() => `[OpenSubtitles] Distributed rate limiter unavailable, falling back to local gate: ${error.message}`);
    return null;
  }
}

async function tryAcquireDistributedRateLimitSlot(options = {}) {
  return tryReserveDistributedOpenSubtitlesSlots(buildOpenSubtitlesRateLimitSlots('api'), options);
}

async function tryAcquireDistributedLoginRateLimitSlot(options = {}) {
  return tryReserveDistributedOpenSubtitlesSlots(buildOpenSubtitlesRateLimitSlots('login'), options);
}

async function applyDistributedRateLimitDelay(waitMs, reason = 'upstream rate limit', options = {}) {
  const delayMs = getRateLimitDelayMs(waitMs, options.fallbackMs);
  applyLocalRateLimitDelay(delayMs, options);

  try {
    const adapter = options.adapter || await require('../utils/sharedCache').getStorageAdapter();
    const { StorageAdapter } = require('../storage');

    if (!adapter?.client || typeof adapter._getKey !== 'function') {
      return false;
    }

    if (adapter.client.status && adapter.client.status !== 'ready') {
      return false;
    }

    const slots = buildOpenSubtitlesRateLimitSlots(options.includeLogin ? 'login' : 'api');
    const keys = slots.map(slot => adapter._getKey(`ratelimit:${slot.key}`, StorageAdapter.CACHE_TYPES.SESSION));
    const ttlMs = Math.max(...slots.map(slot => slot.ttlMs), delayMs + 1000);
    const result = await adapter.client.eval(`
      local timeParts = redis.call('time')
      local nowMs = (tonumber(timeParts[1]) * 1000) + math.floor(tonumber(timeParts[2]) / 1000)
      local delayMs = tonumber(ARGV[1])
      local ttlMs = tonumber(ARGV[2])
      local targetNextAt = nowMs + delayMs
      local extended = 0
      local effectiveNextAt = targetNextAt

      for i = 1, #KEYS do
        local currentNextAt = tonumber(redis.call('get', KEYS[i]) or '0')
        if currentNextAt < targetNextAt then
          redis.call('psetex', KEYS[i], ttlMs, targetNextAt)
          extended = 1
        else
          effectiveNextAt = math.max(effectiveNextAt, currentNextAt)
        end
      end

      return {extended, effectiveNextAt}
    `, keys.length, ...keys, delayMs, ttlMs);

    const extended = Number(result?.[0]) === 1;
    const nextAt = Number(result?.[1]) || 0;
    log.warn(() => `[OpenSubtitles] Advanced API limiter after ${reason}: ${delayMs}ms${extended ? '' : ` (existing reservation until ${nextAt})`}`);
    return true;
  } catch (error) {
    log.warn(() => `[OpenSubtitles] Failed to advance distributed API limiter after ${reason}: ${error.message}`);
    return false;
  }
}

async function acquireLoginApiToken(options = {}) {
  return acquireOpenSubtitlesRateLimitSlot('login', { ...options, context: options.context || 'login' });
}

/**
 * Acquire a rate-limit token before making an OpenSubtitles API call.
 * Redis enforces the cross-pod shared-IP budget when available. If Redis is
 * unavailable, fall back to a conservative process-local 1 req/sec gate.
 * @returns {Promise<void>}
 */
async function acquireToken(options = {}) {
  return acquireOpenSubtitlesRateLimitSlot('api', options);
}

async function acquireOpenSubtitlesRateLimitSlot(kind, options = {}) {
  const deadlineAt = options.deadlineAt || resolveRateLimitDeadline(options);
  const context = options.context || 'api gate';
  const slots = buildOpenSubtitlesRateLimitSlots(kind);
  const budgetMs = getRateLimitQueueBudgetMs(deadlineAt);
  const maxWaitMs = budgetMs === Infinity ? -1 : Math.max(0, Math.floor(budgetMs));
  let reservation = await tryReserveDistributedOpenSubtitlesSlots(slots, { ...options, maxWaitMs });

  if (!reservation) {
    const now = Date.now();
    if (now - _lastDistributedLimiterWarningAt > 30000) {
      _lastDistributedLimiterWarningAt = now;
      log.warn(() => `[OpenSubtitles] Distributed API limiter unavailable; using conservative local fallback (api=${LOCAL_FALLBACK_MIN_INTERVAL_MS}ms, login=${LOCAL_FALLBACK_LOGIN_MIN_INTERVAL_MS}ms)`);
    }
    reservation = await reserveLocalSlots(slots, { deadlineAt, context });
  }

  if (!reservation.acquired) {
    throw createOpenSubtitlesQueueBusyError(
      `OpenSubtitles API queue wait would exceed request budget for ${context}; leaving upstream untouched`,
      reservation.retryAfterMs
    );
  }

  const waitMs = Math.max(0, Number(reservation.retryAfterMs) || 0);
  assertRateLimitWaitAllowed(waitMs, deadlineAt, context, 'queue wait');
  if (waitMs > 0) {
    log.debug(() => `[OpenSubtitles] ${reservation.local ? 'Local fallback' : 'Distributed'} API gate: waiting ${waitMs}ms for ${context}`);
    await sleep(waitMs);
  }
}

async function observeOpenSubtitlesRateLimitHeaders(response, context) {
  const headers = response?.headers || {};
  const remainingSecondRaw = headers['x-ratelimit-remaining-second'] ?? headers['ratelimit-remaining'];
  if (remainingSecondRaw === undefined || remainingSecondRaw === null) {
    return;
  }

  const remainingSecond = Number(remainingSecondRaw);
  if (Number.isFinite(remainingSecond) && remainingSecond <= RATE_LIMIT_HEADER_REMAINING_FLOOR) {
    const waitMs = parseRateLimitDelayMs(
      headers,
      fallbackDelayFromLimitHeaders(headers, RATE_LIMIT_MIN_INTERVAL_MS)
    );
    await applyDistributedRateLimitDelay(waitMs, `${context} response headers`, {
      includeLogin: context === 'login'
    });
  }
}

async function noteOpenSubtitlesRateLimit(error, context) {
  const status = error?.response?.status || error?.statusCode;
  if (status !== 429) {
    return null;
  }

  const headers = error?.response?.headers || {};
  const waitMs = parseRateLimitDelayMs(
    headers,
    fallbackDelayFromLimitHeaders(headers, RATE_LIMIT_RETRY_AFTER_FALLBACK_MS),
    RATE_LIMIT_RETRY_AFTER_MAX_MS
  );
  const effectiveWaitMs = getRateLimitDelayMs(waitMs);

  await applyDistributedRateLimitDelay(effectiveWaitMs, `${context} upstream 429`, {
    includeLogin: context === 'login'
  });
  log.warn(() => `[OpenSubtitles] Upstream 429 from ${context} despite preflight limiter; advanced next reservation by ${effectiveWaitMs}ms`);
  return effectiveWaitMs;
}

async function requestOpenSubtitlesApi(requestFn, context, options = {}) {
  const deadlineAt = resolveRateLimitDeadline(options);
  if (context === 'login') {
    await acquireLoginApiToken({ ...options, deadlineAt, context });
  } else {
    await acquireToken({ ...options, deadlineAt, context });
  }
  try {
    const response = await requestFn();
    await observeOpenSubtitlesRateLimitHeaders(response, context);
    return response;
  } catch (error) {
    const waitMs = await noteOpenSubtitlesRateLimit(error, context);
    if (waitMs !== null) {
      error.openSubtitlesRateLimit = true;
      error.retryAfterMs = waitMs;
    }
    throw error;
  }
}

async function keepAliveOpenSubtitlesAuthApi(options = {}) {
  const timeoutMs = Number(options.timeoutMs || options.timeout || 10000);
  const apiKey = sanitizeApiKeyForHeader(getOpenSubtitlesApiKey());
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*'
  };

  if (apiKey) {
    headers['Api-Key'] = apiKey;
  }

  return requestOpenSubtitlesApi(() => axios.get(`${OPENSUBTITLES_API_URL}/infos/formats`, {
    headers,
    httpAgent,
    httpsAgent,
    lookup: dnsLookup,
    timeout: timeoutMs,
    maxRedirects: 0
  }), 'keep-alive', {
    timeoutMs,
    maxQueueWaitMs: 0
  });
}

function resetRateLimiterState() {
  _localApiNextAllowedAt = 0;
  _localLoginNextAllowedAt = 0;
  _localRateLimitQueue = Promise.resolve();
  _lastDistributedLimiterWarningAt = 0;
  localLoginSingleflightLocks.clear();
}
// ─── End rate limiter ─────────────────────────────────────────────────────────

function buildOpenSubtitlesQueryString(queryParams = {}) {
  const searchParams = new URLSearchParams();

  for (const key of Object.keys(queryParams).sort()) {
    const value = queryParams[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    searchParams.append(key, String(value).trim().toLowerCase());
  }

  return searchParams.toString();
}


/**
 * Get cached token for credentials (if valid)
 * MULTI-INSTANCE: Checks local cache first, then Redis
 * @param {string} cacheKey - Credentials cache key
 * @returns {Promise<{ token: string, expiry: number, baseUrl?: string } | null>}
 */
async function getCachedToken(cacheKey) {
  if (!cacheKey) return null;

  // L1: Check local cache first (fast path)
  const local = tokenCacheLocal.get(cacheKey);
  if (local) {
    // Check if token is still valid (with 1 minute buffer)
    if (Date.now() < local.expiry - 60000) {
      return local;
    }
    tokenCacheLocal.delete(cacheKey);
  }

  // L2: Check Redis (cross-pod cache)
  try {
    const { getShared } = require('../utils/sharedCache');
    const { StorageAdapter } = require('../storage');
    const redisKey = `${TOKEN_CACHE_PREFIX}${cacheKey}`;
    const cached = await getShared(redisKey, StorageAdapter.CACHE_TYPES.SESSION);

    if (cached) {
      const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
      if (parsed && parsed.token && parsed.expiry) {
        // Check if token is still valid
        if (Date.now() < parsed.expiry - 60000) {
          // Populate local cache for future same-process calls
          tokenCacheLocal.set(cacheKey, parsed);
          log.debug(() => '[OpenSubtitles] Token loaded from Redis (cross-pod cache)');
          return parsed;
        }
      }
    }
  } catch (err) {
    // Redis unavailable - fall through
    log.debug(() => `[OpenSubtitles] Redis token lookup failed: ${err.message}`);
  }

  return null;
}

/**
 * Store token in cache (both local and Redis)
 * @param {string} cacheKey - Credentials cache key
 * @param {string} token - JWT token
 * @param {number} expiry - Expiry timestamp
 * @param {string} [baseUrl] - Optional VIP API base URL
 */
async function setCachedToken(cacheKey, token, expiry, baseUrl = null) {
  if (!cacheKey || !token) return;

  const data = { token, expiry };
  // Include VIP base URL if provided (for VIP members)
  if (baseUrl) {
    data.baseUrl = baseUrl;
  }

  // L1: Store in local cache
  tokenCacheLocal.set(cacheKey, data);

  // L2: Store in Redis for cross-pod sharing
  try {
    const { setShared } = require('../utils/sharedCache');
    const { StorageAdapter } = require('../storage');
    const redisKey = `${TOKEN_CACHE_PREFIX}${cacheKey}`;
    await setShared(redisKey, JSON.stringify(data), StorageAdapter.CACHE_TYPES.SESSION, TOKEN_TTL_SECONDS);
    log.debug(() => '[OpenSubtitles] Token cached in Redis (cross-pod)');
  } catch (err) {
    // Redis unavailable - local cache still works
    log.debug(() => `[OpenSubtitles] Redis token cache failed: ${err.message}`);
  }
}

/**
 * Clear cached token (both local and Redis)
 * @param {string} cacheKey - Credentials cache key
 */
async function clearCachedToken(cacheKey) {
  if (!cacheKey) return;

  // L1: Clear local cache
  tokenCacheLocal.delete(cacheKey);

  // L2: Clear from Redis
  try {
    const { deleteShared } = require('../utils/sharedCache');
    const { StorageAdapter } = require('../storage');
    const redisKey = `${TOKEN_CACHE_PREFIX}${cacheKey}`;
    await deleteShared(redisKey, StorageAdapter.CACHE_TYPES.SESSION);
  } catch (err) {
    log.debug(() => `[OpenSubtitles] Redis token delete failed: ${err.message}`);
  }
}

function inferFormatFromFilename(filename) {
  if (!filename) return null;
  const lower = String(filename).toLowerCase();
  const extMatch = lower.match(/\.([a-z0-9]{2,4})$/);
  if (extMatch && extMatch[1]) {
    const ext = extMatch[1];
    if (['srt', 'vtt', 'ass', 'ssa', 'sub'].includes(ext)) {
      return ext;
    }
  }
  return null;
}

function stripExtension(filename) {
  if (!filename) return filename;
  return filename.replace(/\.[^.]+$/, '');
}

function getCredentialsCacheKey(username, password) {
  if (!username) {
    return null;
  }
  const normalized = String(username || '').trim().toLowerCase();
  const secret = `${normalized}:${password || ''}`;
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function isAuthenticationFailure(error) {
  if (!error) {
    return false;
  }

  const status = error.response?.status;

  // 401 Unauthorized and 403 Forbidden are clear auth failures
  if (status === 401 || status === 403) {
    return true;
  }

  // Check error message for auth-related keywords
  // This handles 400 errors that might be auth-related, as well as other edge cases
  const message = String(error.response?.data?.message || error.message || '').toLowerCase();
  if (message.includes('invalid username') || message.includes('invalid credentials') || message.includes('usernamepassword') || message.includes('unauthorized') || message.includes('wrong password')) {
    return true;
  }

  // 400 Bad Request is NOT automatically an auth failure - it could be many things
  // (malformed request, missing fields, etc.) - only the message content tells us

  return false;
}

function hasCachedAuthFailure(cacheKey) {
  if (!cacheKey) {
    return false;
  }

  const timestamp = credentialFailureCache.get(cacheKey);
  if (!timestamp) {
    return false;
  }

  if (Date.now() - timestamp > AUTH_FAILURE_TTL_MS) {
    credentialFailureCache.delete(cacheKey);
    return false;
  }

  return true;
}

async function hasCachedAuthFailureAsync(cacheKey) {
  if (hasCachedAuthFailure(cacheKey)) {
    return true;
  }

  if (!cacheKey) {
    return false;
  }

  try {
    const { getShared } = require('../utils/sharedCache');
    const { StorageAdapter } = require('../storage');
    const cached = await getShared(`${AUTH_FAILURE_PREFIX}${cacheKey}`, StorageAdapter.CACHE_TYPES.SESSION);
    if (cached) {
      credentialFailureCache.set(cacheKey, Date.now());
      return true;
    }
  } catch (err) {
    log.debug(() => `[OpenSubtitles] Redis auth-failure lookup failed: ${err.message}`);
  }

  return false;
}

async function cacheAuthFailure(cacheKey) {
  if (!cacheKey) {
    return;
  }

  credentialFailureCache.set(cacheKey, Date.now());

  try {
    const { setShared } = require('../utils/sharedCache');
    const { StorageAdapter } = require('../storage');
    await setShared(
      `${AUTH_FAILURE_PREFIX}${cacheKey}`,
      String(Date.now()),
      StorageAdapter.CACHE_TYPES.SESSION,
      Math.ceil(AUTH_FAILURE_TTL_MS / 1000)
    );
  } catch (err) {
    log.debug(() => `[OpenSubtitles] Redis auth-failure cache failed: ${err.message}`);
  }
}

async function clearCachedAuthFailure(cacheKey) {
  if (!cacheKey) {
    return;
  }

  credentialFailureCache.delete(cacheKey);

  try {
    const { deleteShared } = require('../utils/sharedCache');
    const { StorageAdapter } = require('../storage');
    await deleteShared(`${AUTH_FAILURE_PREFIX}${cacheKey}`, StorageAdapter.CACHE_TYPES.SESSION);
  } catch (err) {
    log.debug(() => `[OpenSubtitles] Redis auth-failure clear failed: ${err.message}`);
  }
}

/**
 * Get OpenSubtitles API key at runtime (not at module load time)
 * This ensures Docker ENV vars and runtime environment changes are picked up
 * @returns {string} API key or empty string
 */
function getOpenSubtitlesApiKey() {
  return process.env.OPENSUBTITLES_API_KEY || '';
}

class OpenSubtitlesService {
  // Static flag to track if initialization logs have been shown
  static initLogged = false;

  constructor(config = {}) {
    // Config requires username/password for user authentication (mandatory)
    this.config = {
      username: config.username || '',
      password: config.password || ''
    };

    this.credentialsCacheKey = getCredentialsCacheKey(this.config.username, this.config.password);

    // MULTI-INSTANCE: Token loading from Redis happens lazily in login()/isTokenExpired()
    // Constructor only checks local cache for fast startup
    const local = tokenCacheLocal.get(this.credentialsCacheKey);
    if (local && Date.now() < local.expiry - 60000) {
      this.token = local.token;
      this.tokenExpiry = local.expiry;
      // Apply VIP base_url if cached
      if (local.baseUrl) {
        this.baseUrl = local.baseUrl;
      }
    } else {
      this.token = null;
      this.tokenExpiry = null;
      this.baseUrl = null;
    }

    // Read API key at runtime (not at module load time)
    const apiKey = getOpenSubtitlesApiKey();

    // Base axios configuration
    const defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': '*/*', // OpenSubtitles docs: "make sure you always add to every request Accept header: Accept: */*"
      'Accept-Encoding': 'gzip, deflate, br'
    };

    // Add API key if configured (only for search/auth flows)
    const sanitizedApiKey = sanitizeApiKeyForHeader(apiKey);
    if (sanitizedApiKey) {
      defaultHeaders['Api-Key'] = sanitizedApiKey;
      // Only log once at startup
      if (!OpenSubtitlesService.initLogged) {
        log.debug(() => '[OpenSubtitles] API key loaded successfully from environment');
      }
    }

    const baseAxiosConfig = {
      baseURL: OPENSUBTITLES_API_URL,
      headers: defaultHeaders,
      httpAgent,
      httpsAgent,
      lookup: dnsLookup,
      timeout: 12000,
      maxRedirects: 5,
      decompress: true
    };

    // Primary client (search/auth) uses Api-Key
    this.client = axios.create(baseAxiosConfig);

    // Download client also uses Api-Key - per OpenSubtitles docs:
    // "In every request should be present these HTTP headers... Api-Key"
    this.downloadClient = axios.create(baseAxiosConfig);

    // Only log initialization messages once at startup
    if (!OpenSubtitlesService.initLogged) {
      // Validate API key is configured
      if (!apiKey) {
        log.warn(() => '[OpenSubtitles] WARNING: OPENSUBTITLES_API_KEY not found in environment variables');
        log.warn(() => '[OpenSubtitles] Set it via: .env file, Docker ENV, or docker-compose environment');
        log.warn(() => '[OpenSubtitles] API requests may fail or have very limited rate limits');
      }

      // Validate that credentials are provided
      if (!this.config.username || !this.config.password) {
        log.warn(() => '[OpenSubtitles] Username and password are optional - searches will use basic API access (limited to 5 downloads/24h per IP)');
      } else {
        log.debug(() => '[OpenSubtitles] Initialized with user account authentication for higher rate limits');
      }

      // Mark as logged
      OpenSubtitlesService.initLogged = true;
    }

    // Add request interceptor to handle token refresh for user authentication
    const addAuthInterceptor = (axiosInstance) => {
      axiosInstance.interceptors.request.use((config) => {
        // Use instance token if valid - Redis check happens in login()
        // Interceptor is synchronous, so we only use local state here
        if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
          config.headers['Authorization'] = `Bearer ${this.token}`;
        }
        return config;
      });
    };
    addAuthInterceptor(this.client);
    addAuthInterceptor(this.downloadClient);

    // Apply cached VIP base_url to axios clients (if loaded from local cache in constructor)
    if (this.baseUrl) {
      this.client.defaults.baseURL = this.baseUrl;
      this.downloadClient.defaults.baseURL = this.baseUrl;
    }
  }

  /**
   * Check if token is expired (also checks Redis cache)
   * MULTI-INSTANCE: Async to support Redis lookup
   * Uses 60s safety margin to prevent race conditions:
   * Without this, a token with e.g. 500ms TTL could pass the check
   * but expire before the actual API request fires (especially after
   * acquireToken() wait), causing the auth interceptor to silently
   * drop the Bearer header → API sees unauthenticated request → 20/day limit.
   * @returns {Promise<boolean>}
   */
  async isTokenExpired() {
    // Use 60s safety margin to prevent race between check and actual request
    // This matches the constructor's existing margin (line 348)
    const SAFETY_MARGIN_MS = 60000;

    // If we have a valid local token (with safety margin), use it
    if (this.tokenExpiry && Date.now() < this.tokenExpiry - SAFETY_MARGIN_MS) {
      return false;
    }

    // Check Redis for a token from another pod
    const cached = await getCachedToken(this.credentialsCacheKey);
    if (cached) {
      this.token = cached.token;
      this.tokenExpiry = cached.expiry;
      // Apply VIP base_url if cached
      if (cached.baseUrl && !this.baseUrl) {
        this.baseUrl = cached.baseUrl;
        this.client.defaults.baseURL = cached.baseUrl;
        this.downloadClient.defaults.baseURL = cached.baseUrl;
      }
      // Also apply safety margin to Redis-fetched tokens
      return Date.now() >= this.tokenExpiry - SAFETY_MARGIN_MS;
    }

    return true;
  }

  /**
   * Login with username and password to get JWT token
   * @param {string} username - OpenSubtitles username
   * @param {string} password - OpenSubtitles password
   * @param {number} timeout - Optional timeout in ms
   * @returns {Promise<string>} - JWT token
   */
  async loginWithCredentials(username, password, timeout) {
    try {
      log.debug(() => ['[OpenSubtitles] Authenticating user:', username]);

      // Use provided timeout or fall back to client default
      const requestConfig = timeout ? { timeout } : {};
      const loginDeadlineAt = Date.now() + Math.max(
        0,
        (Number(timeout) || this.client.defaults.timeout || 12000) - RATE_LIMIT_REQUEST_RESERVE_MS
      );

      log.debug(() => '[OpenSubtitles] Executing login request through shared API/login gates...');
      const response = await requestOpenSubtitlesApi(() => this.client.post('/login', {
        username: username,
        password: password
      }, requestConfig), 'login', {
        deadlineAt: loginDeadlineAt,
        timeoutMs: timeout || this.client.defaults.timeout
      });

      if (!response.data?.token) {
        throw new Error('No token received from authentication');
      }

      this.token = response.data.token;
      // Token is valid for 24 hours
      this.tokenExpiry = Date.now() + (24 * 60 * 60 * 1000);

      // VIP users get a special base_url - use it for faster/less rate-limited access
      let vipBaseUrl = null;
      if (response.data.base_url) {
        const rawBaseUrl = String(response.data.base_url).trim();
        // Only use vip-api endpoint if returned by OpenSubtitles
        if (rawBaseUrl.includes('vip-api.opensubtitles.com')) {
          vipBaseUrl = rawBaseUrl.startsWith('http') ? rawBaseUrl : `https://${rawBaseUrl}`;
          // Ensure it ends with /api/v1
          if (!vipBaseUrl.endsWith('/api/v1')) {
            vipBaseUrl = vipBaseUrl.replace(/\/?$/, '/api/v1');
          }
          this.baseUrl = vipBaseUrl;
          // Update axios clients to use VIP endpoint
          this.client.defaults.baseURL = vipBaseUrl;
          this.downloadClient.defaults.baseURL = vipBaseUrl;
          log.info(() => `[OpenSubtitles] VIP user detected - switching to VIP API endpoint`);
        }
      }

      // Store before releasing the distributed login lock so other pods observe
      // the token instead of starting a second login immediately after us.
      await setCachedToken(this.credentialsCacheKey, this.token, this.tokenExpiry, vipBaseUrl);

      log.debug(() => '[OpenSubtitles] User authentication successful');
      await clearCachedAuthFailure(this.credentialsCacheKey);
      return this.token;

    } catch (error) {
      // Classify the error so we don't mis-treat rate limits as bad credentials
      const parsed = parseApiError(error, 'OpenSubtitles');

      // OpenSubtitles returns 403 "You cannot consume this service" when API key is rate-limited/blocked
      // Treat this like a rate limit, not an auth failure
      const errMsg = String(error.response?.data?.message || error.message || '').toLowerCase();
      const looksLikeRateLimit = errMsg.includes('throttle') || errMsg.includes('rate limit') || errMsg.includes('too many') || errMsg.includes('cannot consume');
      if (parsed.statusCode === 403 && looksLikeRateLimit) {
        log.warn(() => `[OpenSubtitles] 403 response looks like rate limiting, not auth failure: "${errMsg}"`);
        const retryAfterMs = parseRateLimitDelayMs(
          error.response?.headers || {},
          LOGIN_MIN_INTERVAL_MS,
          RATE_LIMIT_RETRY_AFTER_MAX_MS
        );
        await applyDistributedRateLimitDelay(retryAfterMs, 'login 403 rate-limit-like response', { includeLogin: true });
        const e = new Error('OpenSubtitles API key temporarily blocked due to rate limiting');
        e.statusCode = 429;
        e.type = 'rate_limit';
        e.isRetryable = true;
        e.openSubtitlesRateLimit = true;
        e.retryAfterMs = retryAfterMs;
        throw e;
      }

      // Never cache an auth failure for retryable cases like 429/503
      // Also skip caching if the error message looks like rate limiting regardless of status code
      if (parsed.type !== 'rate_limit' && parsed.statusCode !== 503 && parsed.statusCode !== 429 && !looksLikeRateLimit && isAuthenticationFailure(error)) {
        await cacheAuthFailure(this.credentialsCacheKey);
      }

      // For rate limits or service unavailability, bubble up so callers can render a proper message
      if (parsed.statusCode === 429 || parsed.type === 'rate_limit' || parsed.statusCode === 503) {
        const e = new Error(parsed.userMessage || parsed.message || 'Service temporarily unavailable');
        e.statusCode = parsed.statusCode || 503;
        e.type = parsed.type || 'service_unavailable';
        e.isRetryable = true;
        if (isOpenSubtitlesRateLimitError(error)) {
          e.statusCode = 429;
          e.type = 'rate_limit';
          e.openSubtitlesRateLimit = true;
          e.retryAfterMs = error.retryAfterMs || RATE_LIMIT_RETRY_AFTER_FALLBACK_MS;
        }
        throw e;
      }

      // For timeout and network errors, also bubble up so they don't get misinterpreted as invalid credentials
      if (parsed.type === 'timeout' || parsed.type === 'network' || parsed.type === 'dns') {
        const e = new Error(parsed.userMessage || parsed.message || 'Network error during authentication');
        e.statusCode = parsed.statusCode || 0;
        e.type = parsed.type;
        e.isRetryable = parsed.type !== 'dns'; // DNS errors are not retryable
        throw e;
      }

      // For genuine auth failures, throw so the caller knows it's an auth error (401)
      if (parsed.statusCode === 401 || isAuthenticationFailure(error)) {
        const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
        authErr.statusCode = 401;
        authErr.authError = true;
        // Also log via handler for consistency
        handleAuthError(error, 'OpenSubtitles');
        throw authErr;
      }

      // For other unexpected errors, log via auth handler and return null
      return handleAuthError(error, 'OpenSubtitles');
    }
  }

  /**
   * Login to OpenSubtitles REST API (optional, for higher download limits)
   * Uses a process-local mutex plus a Redis singleflight lock so only one pod
   * refreshes a given credential's JWT at a time.
   * @param {number} timeout - Optional timeout in ms for the login request
   * @returns {Promise<string|null>} - JWT token if credentials provided, null otherwise
   */
  _applyCachedToken(cached, source = 'cache') {
    if (!cached?.token) {
      return null;
    }

    this.token = cached.token;
    this.tokenExpiry = cached.expiry;
    if (cached.baseUrl) {
      this.baseUrl = cached.baseUrl;
      this.client.defaults.baseURL = cached.baseUrl;
      this.downloadClient.defaults.baseURL = cached.baseUrl;
      log.debug(() => `[OpenSubtitles] VIP base URL applied from ${source}`);
    }

    return this.token;
  }

  _createAuthFailureError() {
    const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
    authErr.statusCode = 401;
    authErr.authError = true;
    return authErr;
  }

  _resolveLoginDeadlineAt(timeout) {
    const timeoutMs = Number(timeout) || this.client.defaults.timeout || 12000;
    return Date.now() + Math.max(1000, timeoutMs - Math.min(1000, RATE_LIMIT_REQUEST_RESERVE_MS));
  }

  async _waitForDistributedLoginResult(deadlineAt) {
    while (Date.now() < deadlineAt) {
      const cached = await getCachedToken(this.credentialsCacheKey);
      if (cached) {
        return this._applyCachedToken(cached, 'distributed login owner');
      }

      if (await hasCachedAuthFailureAsync(this.credentialsCacheKey)) {
        throw this._createAuthFailureError();
      }

      const lockTtlMs = await getDistributedLoginSingleflightLockTtl(this.credentialsCacheKey);
      if (lockTtlMs <= 0) {
        return null;
      }

      const remainingMs = Math.max(0, deadlineAt - Date.now());
      if (remainingMs <= 0) {
        break;
      }

      await sleep(Math.min(LOGIN_SINGLEFLIGHT_POLL_MS, lockTtlMs, remainingMs));
    }

    const retryAfterMs = await getDistributedLoginSingleflightLockTtl(this.credentialsCacheKey);
    throw createOpenSubtitlesQueueBusyError(
      'OpenSubtitles login refresh is already in progress and exceeded this request budget',
      retryAfterMs || LOGIN_SINGLEFLIGHT_POLL_MS
    );
  }

  async _performDistributedLogin(timeout) {
    const deadlineAt = this._resolveLoginDeadlineAt(timeout);

    while (Date.now() < deadlineAt) {
      if (await hasCachedAuthFailureAsync(this.credentialsCacheKey)) {
        log.warn(() => '[OpenSubtitles] Authentication blocked: cached invalid credentials detected');
        throw this._createAuthFailureError();
      }

      const cached = await getCachedToken(this.credentialsCacheKey);
      if (cached) {
        log.debug(() => '[OpenSubtitles] Using cached token (cross-pod Redis cache)');
        return this._applyCachedToken(cached, 'cross-pod cache');
      }

      const remainingMs = Math.max(0, deadlineAt - Date.now());
      const lock = await tryAcquireDistributedLoginSingleflightLock(this.credentialsCacheKey, {
        ttlMs: Math.max(LOGIN_SINGLEFLIGHT_LOCK_TTL_MS, remainingMs + 2000)
      });

      if (lock.acquired) {
        try {
          const cachedAfterLock = await getCachedToken(this.credentialsCacheKey);
          if (cachedAfterLock) {
            return this._applyCachedToken(cachedAfterLock, 'cache after login lock');
          }
          return await this.loginWithCredentials(this.config.username, this.config.password, timeout);
        } finally {
          await releaseDistributedLoginSingleflightLock(lock);
        }
      }

      log.debug(() => `[OpenSubtitles] Waiting for distributed login owner (${Math.ceil((lock.retryAfterMs || 0) / 1000)}s lock TTL)`);
      const token = await this._waitForDistributedLoginResult(deadlineAt);
      if (token) {
        return token;
      }
    }

    throw createOpenSubtitlesQueueBusyError(
      'OpenSubtitles login refresh could not acquire a distributed slot within this request budget',
      LOGIN_SINGLEFLIGHT_POLL_MS
    );
  }

  async login(timeout) {
    if (!this.config.username || !this.config.password) {
      // No credentials provided, use basic API access
      return null;
    }

    if (await hasCachedAuthFailureAsync(this.credentialsCacheKey)) {
      log.warn(() => '[OpenSubtitles] Authentication blocked: cached invalid credentials detected');
      throw this._createAuthFailureError();
    }

    // Check if there's already a valid token in cache (local + Redis)
    const cached = await getCachedToken(this.credentialsCacheKey);
    if (cached) {
      log.debug(() => '[OpenSubtitles] Using cached token (cross-pod Redis cache)');
      return this._applyCachedToken(cached, 'cross-pod cache');
    }

    // Check if another request is already logging in with these credentials
    const existingMutex = loginMutex.get(this.credentialsCacheKey);
    if (existingMutex) {
      log.debug(() => '[OpenSubtitles] Waiting for existing login to complete (mutex)');
      try {
        const result = await existingMutex;
        // After mutex resolves, check cache again
        const freshCached = await getCachedToken(this.credentialsCacheKey);
        if (freshCached) {
          return this._applyCachedToken(freshCached, 'process mutex');
        }
        return result;
      } catch (err) {
        if (await hasCachedAuthFailureAsync(this.credentialsCacheKey)) {
          throw this._createAuthFailureError();
        }
        throw err;
      }
    }

    // Create a mutex promise for this login attempt
    let resolveMutex;
    let rejectMutex;
    const mutexPromise = new Promise((resolve, reject) => {
      resolveMutex = resolve;
      rejectMutex = reject;
    });
    // Prevent unhandled rejection if no one awaits this mutex when it rejects
    // This happens when the first request fails and no concurrent requests were waiting
    mutexPromise.catch(() => { /* swallow - rejection is handled by the try/catch below */ });
    loginMutex.set(this.credentialsCacheKey, mutexPromise);

    try {
      const result = await this._performDistributedLogin(timeout);
      resolveMutex(result);
      return result;
    } catch (err) {
      rejectMutex(err);
      throw err;
    } finally {
      // Clean up mutex after a short delay to handle race conditions
      setTimeout(() => {
        if (loginMutex.get(this.credentialsCacheKey) === mutexPromise) {
          loginMutex.delete(this.credentialsCacheKey);
        }
      }, 100);
    }
  }

  /**
   * Search for subtitles using the new REST API
   * @param {Object} params - Search parameters
   * @param {string} params.imdb_id - IMDB ID (with 'tt' prefix)
   * @param {string} params.type - 'movie' or 'episode'
   * @param {number} params.season - Season number (for episodes)
   * @param {number} params.episode - Episode number (for episodes)
   * @param {Array<string>} params.languages - Array of ISO-639-2 language codes
   * @returns {Promise<Array>} - Array of subtitle objects
   */
  async searchSubtitles(params) {
    try {
      // Extract providerTimeout early so it can be used for login as well as search
      const { providerTimeout } = params;

      // Authenticate with user credentials (required)
      if (!this.config.username || !this.config.password) {
        log.warn(() => '[OpenSubtitles] Username and password are required. Please configure your OpenSubtitles credentials.');
        return [];
      }

      // Check for cached authentication failure (known bad credentials)
      if (hasCachedAuthFailure(this.credentialsCacheKey)) {
        throw this._createAuthFailureError();
      }

      if (await this.isTokenExpired()) {
        // login() coordinates Redis singleflight and throws typed
        // transient errors so orchestration does not cache incomplete results.
        const loginResult = await this.login(providerTimeout);

        if (!loginResult) {
          throw createOpenSubtitlesQueueBusyError(
            'OpenSubtitles login did not return a token',
            RATE_LIMIT_RETRY_AFTER_FALLBACK_MS
          );
        }
      }

      const { imdb_id, type, season, episode, languages, excludeHearingImpairedSubtitles, videoHash } = params;

      if (!imdb_id) {
        log.warn(() => '[OpenSubtitles] No IMDB ID provided, skipping search');
        return [];
      }

      // Convert imdb_id to OpenSubtitles' canonical numeric format:
      // no "tt" prefix and no leading zeroes, otherwise the API may redirect.
      const imdbId = imdb_id.replace(/^tt/i, '').replace(/^0+/, '') || '0';

      // Convert ISO-639-2 (3-letter) codes to ISO-639-1 (2-letter) codes for OpenSubtitles API
      // IMPORTANT: OpenSubtitles API is strict about which codes it accepts.
      // The /infos/languages endpoint returns the canonical list (74 codes).
      // Codes NOT in that list (e.g., 'pt', 'zh', 'ea', 'nb', 'nn') silently return 0 results.
      const convertedLanguages = languages.map(lang => {
        const lower = lang.toLowerCase().trim();

        // Handle special case for Portuguese Brazilian
        if (lower === 'pob' || lower === 'ptbr' || lower === 'pt-br') {
          return 'pt-br';
        }

        // Handle European Portuguese: OS Auth requires 'pt-pt', NOT bare 'pt'
        // (bare 'pt' returns 0 results — confirmed via live API test)
        if (lower === 'por') {
          return 'pt-pt';
        }

        // Handle Latin American Spanish: OS Auth does NOT support 'ea' (returns 0 results).
        // Fall back to 'es' (Castilian) — closest available match.
        if (lower === 'spn') {
          return 'es';
        }

        // Handle generic Chinese: OS Auth does NOT support bare 'zh' (returns 0 results).
        // Map to 'zh-cn' (Simplified) as the closest default.
        if (lower === 'chi' || lower === 'zho') {
          return 'zh-cn';
        }

        // Handle Norwegian variants: OS Auth does NOT support 'nb' or 'nn' (return 0 results).
        // Map both to 'no' (generic Norwegian) which returns results.
        if (lower === 'nob' || lower === 'nno') {
          return 'no';
        }

        // Handle Filipino/Tagalog: fil has a 3-letter ISO 639-1 code (non-standard),
        // map both fil and tgl to 'tl' (Tagalog 2-letter code accepted by OpenSubtitles)
        if (lower === 'fil' || lower === 'tgl') {
          return 'tl';
        }

        // Handle Dari (prs): OS Auth doesn't have a separate Dari code.
        // Map to 'fa' (Persian/Farsi) — same script and subtitle content.
        if (lower === 'prs') {
          return 'fa';
        }

        // Handle Kurdish Sorani (ckb): OS Auth doesn't have a separate Sorani code.
        // Map to 'ku' (generic Kurdish).
        if (lower === 'ckb') {
          return 'ku';
        }

        // If already 2 letters, return as-is
        if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
          return lower;
        }

        // If 3 letters (ISO-639-2), convert to ISO-639-1
        if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
          const iso1Code = toISO6391(lower);
          if (iso1Code) {
            return iso1Code;
          }
        }

        // Return original if can't convert
        return lower;
      }).filter(lang => lang); // Remove any nulls/undefined

      log.debug(() => ['[OpenSubtitles] Converted languages from ISO-639-2 to ISO-639-1:', languages.join(','), '->', convertedLanguages.join(',')]);

      // Build query parameters for REST API
      const queryParams = {
        imdb_id: imdbId,
        languages: convertedLanguages.join(',')
      };

      if ((type === 'episode' || type === 'anime-episode') && episode) {
        // Default to season 1 if not specified (common for anime)
        queryParams.season_number = season || 1;
        queryParams.episode_number = episode;
      }

      if (excludeHearingImpairedSubtitles === true) {
        queryParams.hearing_impaired = 'exclude';
      }

      // Send moviehash when a real Stremio video hash is available
      // OpenSubtitles API will return moviehash_match=true for exact file matches
      if (videoHash) {
        queryParams.moviehash = videoHash;
        log.debug(() => '[OpenSubtitles] Including moviehash in search for hash-based matching');
      }

      log.debug(() => ['[OpenSubtitles] Searching with params:', JSON.stringify(queryParams)]);
      if (this.token) {
        log.debug(() => '[OpenSubtitles] Using user account authentication');
      } else {
        log.debug(() => '[OpenSubtitles] Using basic API access');
      }

      const queryString = buildOpenSubtitlesQueryString(queryParams);
      const searchPath = queryString ? `/subtitles?${queryString}` : '/subtitles';

      // Use providerTimeout from config if provided, otherwise use client default
      const requestConfig = {};
      if (providerTimeout) requestConfig.timeout = providerTimeout;

      // Rate-limit gate: every OpenSubtitles REST API call goes through the shared gate.
      let response;
      try {
        response = await requestOpenSubtitlesApi(
          () => this.client.get(searchPath, requestConfig),
          'search',
          { timeoutMs: providerTimeout || this.client.defaults.timeout }
        );
      } catch (searchErr) {
        const status = searchErr?.response?.status;
        const errMsg = String(searchErr?.response?.data?.message || searchErr?.message || '').toLowerCase();

        // RETRY LOGIC: Handle invalid token (401 Unauthorized or 500 "invalid")
        // OpenSubtitles docs: "In response check if JWT is valid (look for HTTP response code 500 with message invalid) otherwise re-authenticate user."
        if (status === 401 || (status === 500 && errMsg.includes('invalid'))) {
          log.warn(() => `[OpenSubtitles] Token rejected (${status}), clearing cache and retrying search...`);

          // 1. Clear invalid token from cache (local + Redis)
          await clearCachedToken(this.credentialsCacheKey);
          this.token = null;
          this.tokenExpiry = null;
          this.baseUrl = null;
          this.client.defaults.baseURL = OPENSUBTITLES_API_URL;
          this.downloadClient.defaults.baseURL = OPENSUBTITLES_API_URL;

          // 2. Login again (implicitly handles token refresh and rate limiting)
          // Note: login() will check cache first, but we just cleared it, so it will force a new login
          const freshToken = await this.login(providerTimeout);
          if (!freshToken) {
            throw createOpenSubtitlesQueueBusyError(
              'OpenSubtitles token refresh unavailable during search retry',
              RATE_LIMIT_RETRY_AFTER_FALLBACK_MS
            );
          }

          // 3. Retry search with new token through the same API gate
          try {
            response = await requestOpenSubtitlesApi(
              () => this.client.get(searchPath, requestConfig),
              'search-retry-after-login',
              { timeoutMs: providerTimeout || this.client.defaults.timeout }
            );
          } catch (retryErr) {
            // If it fails again, throw the original error (or the new one) to be handled by standard error handler
            throw retryErr;
          }
        }
        else if (status === 429) {
          // Do not retry in-band; requestOpenSubtitlesApi already recorded the
          // upstream signal and the next call will reserve a later send time.
          throw searchErr;
        } else {
          throw searchErr;
        }
      }

      if (!response.data || !response.data.data || response.data.data.length === 0) {
        log.debug(() => '[OpenSubtitles] No subtitles found in response');
        return [];
      }

      let subtitles = response.data.data.map(sub => {

        const originalLang = sub.attributes.language;
        const normalizedLang = this.normalizeLanguageCode(originalLang);
        const fileId = sub.attributes.files?.[0]?.file_id || sub.id;
        const fileName = sub.attributes.files?.[0]?.file_name || '';
        const detectedFormat = sub.attributes.format || inferFormatFromFilename(fileName) || 'srt';
        const releaseName = sub.attributes.release || '';
        const cleanedName = stripExtension(fileName);
        const displayName = releaseName || cleanedName || sub.attributes.feature_details?.movie_name || 'Unknown';

        // OpenSubtitles API returns moviehash_match when moviehash was sent in query
        const isHashMatch = sub.attributes.moviehash_match === true;

        return {
          id: String(fileId),
          language: originalLang,
          languageCode: normalizedLang,
          name: displayName,
          downloads: parseInt(sub.attributes.download_count) || 0,
          rating: parseFloat(sub.attributes.ratings) || 0,
          uploadDate: sub.attributes.upload_date,
          format: detectedFormat,
          fileId: String(fileId),
          downloadLink: sub.attributes.url,
          originalFilename: fileName || null,
          hearing_impaired: isTrueishFlag(sub.attributes.hearing_impaired),
          foreign_parts_only: sub.attributes.foreign_parts_only || false,
          machine_translated: sub.attributes.machine_translated || false,
          uploader: sub.attributes.uploader?.name || 'Unknown',
          provider: 'opensubtitles',
          hashMatch: isHashMatch,
          hashMatchPriority: isHashMatch ? 0 : undefined
        };
      });

      return this._postProcessSearchResults(subtitles, type, season, episode, convertedLanguages);

    } catch (error) {
      if (isOpenSubtitlesRateLimitError(error)) {
        logOpenSubtitlesRateLimitFailure('Search', error);
        throw error;
      }
      if (isOpenSubtitlesTransientProviderError(error)) {
        log.warn(() => `[OpenSubtitles] Search transient provider failure: ${error.message || error}`);
        throw error;
      }
      return handleSearchError(error, 'OpenSubtitles');
    }
  }

  /**
   * Post-process raw mapped search results: episode filtering, season pack
   * detection, and per-language limiting.
   * Extracted to keep live API mapping separate from filtering/limiting.
   * @param {Array} subtitles - Raw mapped subtitle objects
   * @param {string} type - Content type (movie, episode, anime-episode)
   * @param {number} season - Season number
   * @param {number} episode - Episode number
   * @param {string[]} convertedLanguages - Languages used in the query (for logging)
   * @returns {Array} - Filtered and limited subtitle results
   * @private
   */
  _postProcessSearchResults(subtitles, type, season, episode, convertedLanguages) {
    // Client-side episode filtering and season pack detection
    if ((type === 'episode' || type === 'anime-episode') && episode) {
      const targetSeason = season || 1;
      const targetEpisode = episode;

      const beforeCount = subtitles.length;

      subtitles = subtitles.filter(sub => {
        const name = String(sub.name || '').toLowerCase();

        if (hasExplicitSeasonEpisodeMismatch(name, targetSeason, targetEpisode)) return false;

        // Season pack patterns
        const seasonPackPatterns = [
          new RegExp(`(?:complete|full|entire)?\\s*(?:season|s)\\s*0*${targetSeason}(?:\\s+(?:complete|full|pack))?(?!.*e0*\\\d)`, 'i'),
          new RegExp(`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+season(?!.*episode)`, 'i'),
          new RegExp(`s0*${targetSeason}\\s*(?:complete|full|pack)`, 'i')
        ];

        // Anime pack patterns
        const animeSeasonPackPatterns = [
          /(?:complete|batch|full(?:\s+series)?|\d{1,2}\s*[-~]\s*\d{1,2})/i,
          /\[(?:batch|complete|full)\]/i,
          /(?:episode\s*)?(?:01|001)\s*[-~]\s*(?:\d{2}|\d{3})/i
        ];

        let isSeasonPack = false;
        if (type === 'anime-episode') {
          isSeasonPack = animeSeasonPackPatterns.some(p => p.test(name)) &&
            !new RegExp(`(?:^|[^0-9])0*${targetEpisode}(?:v\\d+)?(?:[^0-9]|$)`, 'i').test(name);
        } else {
          isSeasonPack = seasonPackPatterns.some(p => p.test(name)) &&
            !/s0*\d+e0*\d+|\d+x\d+|episode\s*\d+|ep\s*\d+/i.test(name);
        }

        if (isSeasonPack) {
          sub.is_season_pack = true;
          sub.season_pack_season = targetSeason;
          sub.season_pack_episode = targetEpisode;
          const originalFileId = sub.fileId || sub.id;
          sub.fileId = `${originalFileId}_seasonpack_s${targetSeason}e${targetEpisode}`;
          sub.id = sub.fileId;
          log.debug(() => `[OpenSubtitles] Detected season pack: ${sub.name}`);
          return true;
        }

        // Episode match patterns
        const seasonEpisodePatterns = [
          new RegExp(`s0*${targetSeason}e0*${targetEpisode}(?![0-9])`, 'i'),
          new RegExp(`${targetSeason}x0*${targetEpisode}(?![0-9])`, 'i'),
          new RegExp(`s0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'), // S01xE01, S01x1
          new RegExp(`0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'),  // 01xE01, 1xE01
          new RegExp(`s0*${targetSeason}\\.e0*${targetEpisode}(?![0-9])`, 'i'),
          new RegExp(`season\\s*0*${targetSeason}.*episode\\s*0*${targetEpisode}(?![0-9])`, 'i')
        ];
        if (seasonEpisodePatterns.some(p => p.test(name))) return true;

        return true; // keep ambiguous
      });

      const filteredOut = beforeCount - subtitles.length;
      const seasonPackCount = subtitles.filter(s => s.is_season_pack).length;
      if (filteredOut > 0 || seasonPackCount > 0) {
        log.debug(() => `[OpenSubtitles] Episode filtering kept ${subtitles.length}/${beforeCount} (season packs: ${seasonPackCount})`);
      }
    }

    // Limit to 14 results per language to control response size
    const MAX_RESULTS_PER_LANGUAGE = 14;
    const groupedByLanguage = {};

    for (const sub of subtitles) {
      const lang = sub.languageCode || 'unknown';
      if (!groupedByLanguage[lang]) {
        groupedByLanguage[lang] = [];
      }
      if (groupedByLanguage[lang].length < MAX_RESULTS_PER_LANGUAGE) {
        groupedByLanguage[lang].push(sub);
      }
    }

    const limitedSubtitles = Object.values(groupedByLanguage).flat();
    log.debug(() => `[OpenSubtitles] Found ${subtitles.length} subtitles total, limited to ${limitedSubtitles.length} (max ${MAX_RESULTS_PER_LANGUAGE} per language)`);
    return limitedSubtitles;
  }

  /**
   * Download subtitle content via REST API
   * @param {string} fileId - File ID from search results
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId, options = {}) {
    const timeout = options?.timeout || 12000; // Default 12s
    try {
      log.debug(() => ['[OpenSubtitles] Downloading subtitle via REST API:', fileId]);

      // Parse season pack info encoded in fileId if present
      let baseFileId = String(fileId);
      let isSeasonPack = false;
      let seasonPackSeason = null;
      let seasonPackEpisode = null;
      const seasonPackMatch = String(fileId).match(/^(.*)_seasonpack_s(\d+)e(\d+)$/i);
      if (seasonPackMatch) {
        isSeasonPack = true;
        baseFileId = seasonPackMatch[1];
        seasonPackSeason = parseInt(seasonPackMatch[2], 10);
        seasonPackEpisode = parseInt(seasonPackMatch[3], 10);
        log.debug(() => `[OpenSubtitles] Season pack download detected for S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')}`);
      }

      // Authenticate with user credentials (required)
      if (!this.config.username || !this.config.password) {
        log.warn(() => '[OpenSubtitles] Username and password are required. Please configure your OpenSubtitles credentials.');
        throw new Error('OpenSubtitles credentials not configured');
      }

      if (hasCachedAuthFailure(this.credentialsCacheKey)) {
        const authErr = new Error('OpenSubtitles authentication failed: invalid username/password');
        authErr.statusCode = 401;
        authErr.authError = true;
        throw authErr;
      }

      if (await this.isTokenExpired()) {
        const loginResult = await this.login(timeout);
        if (!loginResult) {
          // Check if credentials are now cached as failed
          if (await hasCachedAuthFailureAsync(this.credentialsCacheKey)) {
            throw new Error('OpenSubtitles authentication failed: invalid username/password');
          }
          // Queue congestion or another transient issue. This is not a user
          // rate limit and should not be rendered as a provider 429 subtitle.
          throw createOpenSubtitlesQueueBusyError(
            'OpenSubtitles temporarily unavailable because the API queue is busy',
            RATE_LIMIT_RETRY_AFTER_FALLBACK_MS
          );
        }
      }

      // First, request download link
      // Use the primary client so Api-Key is sent (required by OpenSubtitles for /download)
      const logDownloadAuthState = () => {
        // Diagnostic: Log auth state immediately before download request
        // This helps diagnose cases where the Bearer token is silently dropped
        const tokenTTL = this.tokenExpiry ? Math.max(0, this.tokenExpiry - Date.now()) : 0;
        const hasToken = !!(this.token && this.tokenExpiry && Date.now() < this.tokenExpiry);
        log.debug(() => `[OpenSubtitles] Download auth state: token=${hasToken ? 'present' : 'MISSING'}, TTL=${Math.round(tokenTTL / 1000)}s, baseUrl=${this.baseUrl ? 'VIP' : 'standard'}`);
        if (!hasToken && this.config.username) {
          log.warn(() => '[OpenSubtitles] WARNING: About to POST /download WITHOUT Bearer token despite having credentials configured! Token may have expired during request preparation.');
        }
      };

      let downloadResponse;
      try {
        downloadResponse = await requestOpenSubtitlesApi(() => {
          logDownloadAuthState();
          return this.client.post('/download', {
            file_id: parseInt(baseFileId)
          });
        }, 'download-link', { timeoutMs: timeout });
      } catch (downloadErr) {
        const status = downloadErr?.response?.status;
        const errMsg = String(downloadErr?.response?.data?.message || downloadErr?.message || '').toLowerCase();

        // RETRY LOGIC: Handle invalid token only. OpenSubtitles may return
        // 406 for real daily quota exhaustion too; that must not trigger a
        // fresh /login on every download attempt.
        const isInvalidToken406 = status === 406 && errMsg.includes('invalid token');
        if (status === 401 || (status === 500 && errMsg.includes('invalid')) || isInvalidToken406) {
          log.warn(() => `[OpenSubtitles] Download token rejected (${status}), clearing cache and retrying...`);

          // 1. Clear invalid token from cache (local + Redis)
          await clearCachedToken(this.credentialsCacheKey);
          this.token = null;
          this.tokenExpiry = null;
          this.baseUrl = null;
          this.client.defaults.baseURL = OPENSUBTITLES_API_URL;
          this.downloadClient.defaults.baseURL = OPENSUBTITLES_API_URL;

          // 2. Login again (implicitly handles token refresh and rate limiting)
          const freshToken = await this.login(timeout);
          if (!freshToken) {
            const retryUnavailable = createOpenSubtitlesQueueBusyError(
              'OpenSubtitles token refresh unavailable during download retry',
              RATE_LIMIT_RETRY_AFTER_FALLBACK_MS
            );
            throw retryUnavailable;
          }

          // 3. Retry download with new token through the same API gate
          downloadResponse = await requestOpenSubtitlesApi(() => {
            logDownloadAuthState();
            return this.client.post('/download', {
              file_id: parseInt(baseFileId)
            });
          }, 'download-link-retry-after-login', { timeoutMs: timeout });
        }
        // Do not relogin on normal 406 responses. They include real daily
        // quota exhaustion and invalid file IDs; another /login cannot fix
        // those and can create login-rate storms.
        else if (status === 406 && this.config.username && this.config.password) {
          const quotaMsg = String(downloadErr?.response?.data?.message || '');
          log.warn(() => `[OpenSubtitles] /download returned 406 with configured credentials; not re-authenticating. API message: "${quotaMsg}"`);
          throw downloadErr;
        } else {
          throw downloadErr;
        }
      }

      if (!downloadResponse.data || !downloadResponse.data.link) {
        throw new Error('No download link received');
      }

      const downloadLink = downloadResponse.data.link;

      // Log remaining downloads from API response for diagnostics
      // The /download response includes: remaining, requests, message, reset_time, reset_time_utc
      const remaining = downloadResponse.data.remaining;
      const requests = downloadResponse.data.requests;
      if (remaining !== undefined) {
        log.info(() => `[OpenSubtitles] Download quota: ${remaining} remaining${requests !== undefined ? ` (${requests} used)` : ''}`);
      }

      log.debug(() => ['[OpenSubtitles] Got download link:', downloadLink]);

      // Download the subtitle file as raw bytes to handle BOM/ZIP cases efficiently
      // Use a clean axios request for CDN downloads - don't send Api-Key/Authorization/Content-Type
      // headers to the CDN; those are only needed for the OpenSubtitles API, not the file CDN
      let subtitleResponse;
      try {
        subtitleResponse = await axios.get(downloadLink, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': '*/*'
          },
          httpAgent,
          httpsAgent,
          lookup: dnsLookup,
          timeout: timeout,
          maxRedirects: 5,
          decompress: true,
          maxContentLength: MAX_ZIP_BYTES
        });
      } catch (cdnError) {
        // CDN download errors (403/410 from Varnish) should NOT be reported as "Authentication failed"
        // These are file-level availability issues on OpenSubtitles' CDN, not credential problems
        const cdnStatus = cdnError.response?.status;
        if (cdnStatus === 403 || cdnStatus === 410) {
          const bodyStr = cdnError.response?.data
            ? (Buffer.isBuffer(cdnError.response.data)
              ? cdnError.response.data.toString('utf8').substring(0, 200)
              : String(cdnError.response.data).substring(0, 200))
            : '';
          const isVarnish = bodyStr.includes('Varnish') || bodyStr.includes('Guru Meditation');
          const hint = cdnStatus === 410 ? 'expired download link' : (isVarnish ? 'file unavailable on CDN' : 'CDN access denied');
          log.warn(() => `[OpenSubtitles] CDN download failed (${cdnStatus}): ${hint}`);
          const err = new Error(`Subtitle file unavailable on OpenSubtitles CDN (${cdnStatus} ${hint}). Try a different subtitle.`);
          err.statusCode = cdnStatus;
          err.type = 'cdn_unavailable';
          err._alreadyLogged = true;
          throw err;
        }
        throw cdnError; // re-throw other errors for default handling
      }

      const buf = Buffer.isBuffer(subtitleResponse.data)
        ? subtitleResponse.data
        : Buffer.from(subtitleResponse.data);

      // Analyze response content to detect HTML error pages, Cloudflare blocks, etc.
      const contentAnalysis = analyzeResponseContent(buf);

      // Check for archive by magic bytes (ZIP, RAR, Gzip, 7z, Tar, etc.)
      const archiveType = detectArchiveType(buf);

      if (archiveType) {
        log.debug(() => `[OpenSubtitles] Detected ${archiveType.toUpperCase()} archive`);

        // Use the centralized archive extractor
        return await extractSubtitleFromArchive(buf, {
          providerName: 'OpenSubtitles',
          maxBytes: MAX_ZIP_BYTES,
          isSeasonPack: isSeasonPack,
          season: seasonPackSeason,
          episode: seasonPackEpisode,
          languageHint: options.languageHint || null,
          skipAssConversion: options.skipAssConversion
        });
      }

      // If not an archive, check if it's an error response (HTML, Cloudflare, etc.)
      if (contentAnalysis.type !== 'subtitle' && contentAnalysis.type !== 'unknown') {
        if (contentAnalysis.type.startsWith('html') || contentAnalysis.type === 'json_error' || contentAnalysis.type === 'text_error' || contentAnalysis.type === 'empty' || contentAnalysis.type === 'truncated') {
          log.error(() => `[OpenSubtitles] Download failed: ${contentAnalysis.type} - ${contentAnalysis.hint}`);
          return createInvalidResponseSubtitle('OpenSubtitles', contentAnalysis, buf.length);
        }
      }

      // Non-ZIP: use centralized encoding detector for proper Arabic/Hebrew/RTL support
      let text = detectAndConvertEncoding(buf, 'OpenSubtitles', options.languageHint || null);

      const trimmed = (text || '').trimStart();
      if (trimmed.startsWith('WEBVTT')) {
        log.debug(() => '[OpenSubtitles] Detected VTT; returning original VTT');
        return text;
      }

      // If content looks like ASS/SSA, convert to VTT using centralized converter
      if (/\[events\]/i.test(text) || /^dialogue\s*:/im.test(text)) {
        log.debug(() => '[OpenSubtitles] Detected ASS/SSA format, using centralized converter');
        return await convertSubtitleToVtt(text, 'subtitle.ass', 'OpenSubtitles', { skipAssConversion: options.skipAssConversion });
      }

      log.debug(() => '[OpenSubtitles] Subtitle downloaded successfully');
      return text;

    } catch (error) {
      handleDownloadError(error, 'OpenSubtitles', { logResponseData: true, truncateResponseData: 400 });
    }
  }

  /**
   * Normalize language code to ISO-639-2 for Stremio
   * @param {string} language - Language code or name from OpenSubtitles (ISO-639-2)
   * @returns {string} - ISO-639-2 language code (3-letter)
   */
  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    // Map OpenSubtitles language names to ISO-639-2 codes
    const languageNameMap = {
      'english': 'eng',
      'spanish': 'spa',
      'french': 'fre',
      'german': 'ger',
      'italian': 'ita',
      'portuguese': 'por',
      'russian': 'rus',
      'japanese': 'jpn',
      'chinese': 'chi',
      'korean': 'kor',
      'arabic': 'ara',
      'dutch': 'dut',
      'polish': 'pol',
      'turkish': 'tur',
      'swedish': 'swe',
      'norwegian': 'nor',
      'danish': 'dan',
      'finnish': 'fin',
      'greek': 'gre',
      'hebrew': 'heb',
      'hindi': 'hin',
      'czech': 'cze',
      'hungarian': 'hun',
      'romanian': 'rum',
      'thai': 'tha',
      'vietnamese': 'vie',
      'indonesian': 'ind',
      'malay': 'may',
      'ukrainian': 'ukr',
      'bulgarian': 'bul',
      'croatian': 'hrv',
      'serbian': 'srp',
      'slovak': 'slo',
      'slovenian': 'slv',
      'estonian': 'est',
      'latvian': 'lav',
      'lithuanian': 'lit',
      'farsi': 'per',
      'persian': 'per',
      'bengali': 'ben',
      'catalan': 'cat',
      'basque': 'baq',
      'galician': 'glg',
      'bosnian': 'bos',
      'macedonian': 'mac',
      'albanian': 'alb',
      'belarusian': 'bel',
      'azerbaijani': 'aze',
      'georgian': 'geo',
      'malayalam': 'mal',
      'tamil': 'tam',
      'telugu': 'tel',
      'urdu': 'urd',
      'tagalog': 'tgl',
      'icelandic': 'ice',
      'kurdish': 'kur',
      'afrikaans': 'afr',
      'armenian': 'arm',
      'kazakh': 'kaz',
      'mongolian': 'mon',
      'nepali': 'nep',
      'punjabi': 'pan',
      'sinhala': 'sin',
      'swahili': 'swa',
      'uzbek': 'uzb',
      'amharic': 'amh',
      'burmese': 'bur',
      'khmer': 'khm',
      'central khmer': 'khm',
      'lao': 'lao',
      'pashto': 'pus',
      'somali': 'som',
      'sinhalese': 'sin'
    };

    // Check if it's a full language name
    if (languageNameMap[lower]) {
      return languageNameMap[lower];
    }

    // Handle special cases for regional variants per OpenSubtitles API format
    if (lower.includes('portuguese') && (lower.includes('brazil') || lower.includes('br'))) {
      return 'pob';
    }
    if (lower === 'brazilian' || lower === 'pt-br' || lower === 'ptbr') {
      return 'pob';
    }

    // Spanish (Latin America) short code sometimes appears as 'ea'
    if (lower === 'ea') {
      return 'spn';
    }

    // OS two-letter or variant codes requiring explicit mapping
    if (lower === 'sx') return 'sat'; // Santali
    if (lower === 'at') return 'ast'; // Asturian
    if (lower === 'pr') return 'per'; // Dari -> Persian macro
    if (lower === 'ex') return 'ext'; // Extremaduran (639-3)
    if (lower === 'ma') return 'mni'; // Manipuri
    if (lower === 'pm') return 'por'; // Portuguese (Mozambique)
    if (lower === 'sp') return 'spa'; // Spanish (EU)
    if (lower === 'sy') return 'syr'; // Syriac
    if (lower === 'tm-td') return 'tet'; // Tetum
    if (lower === 'tp') return 'tok'; // Toki Pona (639-3)

    // Handle Chinese variants per OpenSubtitles API format
    if (lower === 'zh-cn' || lower === 'zhcn' || (lower.includes('chinese') && lower.includes('simplified'))) {
      return 'zhs';
    }
    if (lower === 'zh-tw' || lower === 'zhtw' || (lower.includes('chinese') && lower.includes('traditional'))) {
      return 'zht';
    }
    if (lower === 'ze' || lower === 'chinese bilingual') {
      return 'ze';
    }

    // Handle Montenegrin
    if (lower === 'me' || lower === 'montenegrin') {
      return 'mne';
    }

    // Normalize region-style codes like 'pt-PT', 'az-ZB' to base ISO-639-2
    // Keep 'pt-br' handled above to map specifically to 'pob'
    const regionMatch = lower.match(/^([a-z]{2})-[a-z0-9]{2,}$/);
    if (regionMatch) {
      const base = regionMatch[1];
      // Map 'pt-pt' explicitly to Portuguese
      if (lower === 'pt-pt') {
        return 'por';
      }
      const iso2Codes = toISO6392(base);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2; // Convert base to ISO-639-2
      }
    }

    // If it's already 3 letters, assume it's ISO-639-2
    if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
      return lower;
    }

    // If it's 2 letters, convert from ISO-639-1 to ISO-639-2
    if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2; // Return the first ISO-639-2 code
      }
    }

    // Unknown language
    log.warn(() => `[OpenSubtitles] Unknown language format: "${language}", filtering out`);
    return null;
  }
}

// Support both `require()` direct and `{ OpenSubtitlesService }` destructured imports
module.exports = OpenSubtitlesService;
module.exports.OpenSubtitlesService = OpenSubtitlesService;
module.exports.getCachedToken = getCachedToken;
module.exports.getCredentialsCacheKey = getCredentialsCacheKey;
module.exports.keepAliveOpenSubtitlesAuthApi = keepAliveOpenSubtitlesAuthApi;
module.exports.__testing = {
  acquireToken,
  applyDistributedRateLimitDelay,
  AUTH_FAILURE_TTL_MS,
  buildOpenSubtitlesQueryString,
  createOpenSubtitlesRateLimitError,
  createOpenSubtitlesQueueBusyError,
  keepAliveOpenSubtitlesAuthApi,
  isOpenSubtitlesRateLimitError,
  requestOpenSubtitlesApi,
  resolveRateLimitDeadline,
  releaseDistributedLoginSingleflightLock,
  tryAcquireDistributedLoginRateLimitSlot,
  tryAcquireDistributedLoginSingleflightLock,
  tryAcquireDistributedRateLimitSlot,
  resetRateLimiterState
};
