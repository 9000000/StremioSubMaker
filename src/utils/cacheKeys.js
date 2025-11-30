/**
 * Cache key generation utilities
 *
 * Provides a single source of truth for cache key generation across the application.
 * This ensures consistent scoping for bypass vs permanent cache and prevents
 * cache key mismatches that could break partial cache delivery or cause
 * user isolation issues.
 */

const log = require('./logger');

/**
 * Generate cache keys for translation caching
 *
 * @param {Object} config - User configuration
 * @param {string} sourceFileId - Source file identifier (e.g., "imdb123_en")
 * @param {string} targetLang - Target language code (e.g., "es")
 * @returns {Object} Cache key information
 * @returns {string} .baseKey - Base key without user scoping (e.g., "imdb123_en_es")
 * @returns {string} .cacheKey - Primary cache key (bypass uses user scope, permanent uses shared base)
 * @returns {string} .runtimeKey - Key used for in-flight tracking/partials (scoped per config when available)
 * @returns {boolean} .bypass - Whether bypass mode is enabled in config
 * @returns {boolean} .bypassEnabled - Whether bypass mode is actually active (requires userHash)
 * @returns {string} .userHash - User configuration hash (empty string if not available)
 * @returns {boolean} .allowPermanent - Whether permanent cache reads/writes are allowed (requires userHash)
 */
function generateCacheKeys(config, sourceFileId, targetLang) {
  const baseKey = `${sourceFileId}_${targetLang}`;

  // Determine bypass mode
  const bypass = config.bypassCache === true;
  const bypassCfg = config.bypassCacheConfig || config.tempCache || {}; // Support both old and new names
  let bypassEnabled = bypass && (bypassCfg.enabled !== false);

  // Get user hash for user-scoped caching
  // CRITICAL: userHash must be a valid non-empty string for bypass cache
  // If missing, bypass cache would be shared across all users!
  const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
    ? config.__configHash
    : '';
  const hasUserHash = userHash.length > 0;
  // Only allow permanent caching when we have a scoped config hash
  let allowPermanent = hasUserHash;

  // Security: Fall back to permanent cache if no userHash (prevents sharing bypass cache across users)
  if (bypass && bypassEnabled && !userHash) {
    log.warn(() => `[CacheKeys] Bypass cache requested but no valid configHash available for ${baseKey} - disabling bypass`);
    bypassEnabled = false;
    allowPermanent = false; // do not permit permanent cache writes/reads without a config hash
  }

  // Generate scoped cache key
  // Bypass mode: User-scoped key (e.g., "imdb123_en_es__u_abc123")
  // Permanent mode: Shared key (baseKey) for storage, but runtime tracking is config-scoped when possible
  let cacheKey = baseKey;
  if (bypass && bypassEnabled && hasUserHash) {
    cacheKey = `${baseKey}__u_${userHash}`;  // User-scoped for bypass mode
  } else {
    cacheKey = `${baseKey}`;
  }

  // Runtime/in-flight tracking key:
  // - bypass: user-scoped key
  // - permanent: shared base key so all users see in-flight status
  const runtimeKey = (bypass && bypassEnabled)
    ? cacheKey
    : baseKey;

  if (bypass && bypassEnabled) {
    log.debug(() => `[CacheKeys] Generated user-scoped bypass cache key: ${cacheKey}`);
  } else {
    log.debug(() => `[CacheKeys] Using shared translation cache key for ${baseKey}`);
  }

  return {
    baseKey,        // Base key without user scoping (e.g., "imdb123_en_es")
    cacheKey,       // Scoped key for cache operations (e.g., "imdb123_en_es__u_abc123")
    runtimeKey,     // Key for in-flight/partial tracking (scoped when possible)
    bypass,         // Whether bypass mode is enabled in config
    bypassEnabled,  // Whether bypass mode is actually active (requires userHash)
    userHash,       // User configuration hash (empty string if not available)
    allowPermanent  // Whether permanent cache access is allowed
  };
}

module.exports = {
  generateCacheKeys
};
