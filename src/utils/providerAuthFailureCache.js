const crypto = require('crypto');
const { LRUCache } = require('lru-cache');
const log = require('./logger');

const PROVIDER_AUTH_FAILURE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_AUTH_FAILURE_CACHE_MAX = 5000;
const PROVIDER_AUTH_FAILURE_PREFIX = 'provider_auth_fail:';
const localAuthFailureCache = new LRUCache({
  max: PROVIDER_AUTH_FAILURE_CACHE_MAX,
  ttl: PROVIDER_AUTH_FAILURE_TTL_MS,
  updateAgeOnGet: false
});

function getProviderAuthFailureCacheKey(provider, apiKey) {
  const providerKey = String(provider || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const normalizedApiKey = String(apiKey || '').trim();
  if (!providerKey || !normalizedApiKey) {
    return '';
  }

  const apiKeyHash = crypto.createHash('sha256').update(normalizedApiKey).digest('hex');
  return `${providerKey}:${apiKeyHash}`;
}

function hasLocalAuthFailure(cacheKey) {
  if (!cacheKey) {
    return false;
  }

  return localAuthFailureCache.get(cacheKey) === true;
}

async function hasCachedProviderAuthFailure(cacheKey) {
  if (hasLocalAuthFailure(cacheKey)) {
    return true;
  }

  if (!cacheKey) {
    return false;
  }

  try {
    const { getShared } = require('./sharedCache');
    const { StorageAdapter } = require('../storage');
    const cached = await getShared(`${PROVIDER_AUTH_FAILURE_PREFIX}${cacheKey}`, StorageAdapter.CACHE_TYPES.SESSION);
    if (cached) {
      localAuthFailureCache.set(cacheKey, true);
      return true;
    }
  } catch (error) {
    log.debug(() => `[ProviderAuthFailureCache] Shared lookup failed: ${error.message}`);
  }

  return false;
}

async function cacheProviderAuthFailure(cacheKey, options = {}) {
  if (!cacheKey) {
    return;
  }

  if (options.local !== false) {
    localAuthFailureCache.set(cacheKey, true);
  }
  if (options.shared === false) {
    return;
  }

  try {
    const { setShared } = require('./sharedCache');
    const { StorageAdapter } = require('../storage');
    await setShared(
      `${PROVIDER_AUTH_FAILURE_PREFIX}${cacheKey}`,
      String(Date.now()),
      StorageAdapter.CACHE_TYPES.SESSION,
      Math.ceil(PROVIDER_AUTH_FAILURE_TTL_MS / 1000)
    );
  } catch (error) {
    log.debug(() => `[ProviderAuthFailureCache] Shared cache write failed: ${error.message}`);
  }
}

async function clearCachedProviderAuthFailure(cacheKey) {
  if (!cacheKey) {
    return;
  }

  localAuthFailureCache.delete(cacheKey);

  try {
    const { deleteShared } = require('./sharedCache');
    const { StorageAdapter } = require('../storage');
    await deleteShared(`${PROVIDER_AUTH_FAILURE_PREFIX}${cacheKey}`, StorageAdapter.CACHE_TYPES.SESSION);
  } catch (error) {
    log.debug(() => `[ProviderAuthFailureCache] Shared cache clear failed: ${error.message}`);
  }
}

function resetProviderAuthFailureCache() {
  localAuthFailureCache.clear();
}

function getProviderAuthFailureCacheStats() {
  return {
    size: localAuthFailureCache.size,
    max: PROVIDER_AUTH_FAILURE_CACHE_MAX
  };
}

module.exports = {
  PROVIDER_AUTH_FAILURE_TTL_MS,
  PROVIDER_AUTH_FAILURE_CACHE_MAX,
  getProviderAuthFailureCacheKey,
  hasCachedProviderAuthFailure,
  cacheProviderAuthFailure,
  clearCachedProviderAuthFailure,
  resetProviderAuthFailureCache,
  getProviderAuthFailureCacheStats
};
