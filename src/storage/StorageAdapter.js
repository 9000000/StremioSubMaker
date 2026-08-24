const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

function positiveByteLimit(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === '') return fallback;

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve byte limits once at process startup. The public ElfHosted deployment
 * predates the self-hosted 4 GiB Compose profile and runs a separately managed,
 * unbounded Redis HA deployment. Keep its existing budgets byte-for-byte stable
 * while giving ordinary self-hosters defaults that leave meaningful Redis
 * headroom for sessions, indexes, allocator fragmentation and persistence/
 * replication buffers.
 *
 * Every individual CACHE_LIMIT_* override remains authoritative.
 *
 * @param {NodeJS.ProcessEnv|object} env
 * @returns {Record<string, number|null>}
 */
function resolveSizeLimits(env = process.env) {
  const preserveElfHostedBudgets = env?.ELFHOSTED === 'true';
  const defaults = preserveElfHostedBudgets
    ? {
        translation: 1.5 * GIBIBYTE,
        bypass: 0.5 * GIBIBYTE,
        partial: 0.5 * GIBIBYTE,
        sync: 0.5 * GIBIBYTE,
        autosub: 0.5 * GIBIBYTE,
        embedded: 0.5 * GIBIBYTE,
        history: GIBIBYTE,
        provider_meta: 250 * MEBIBYTE,
        smdb: 2 * GIBIBYTE
      }
    : {
        // 2.5 GiB total: leaves 1.5 GiB (37.5%) of the bundled 4 GiB Redis
        // for sessions, metadata/indexes, fragmentation and Redis overhead.
        translation: 768 * MEBIBYTE,
        bypass: 128 * MEBIBYTE,
        partial: 128 * MEBIBYTE,
        sync: 192 * MEBIBYTE,
        autosub: 192 * MEBIBYTE,
        embedded: 192 * MEBIBYTE,
        history: 256 * MEBIBYTE,
        provider_meta: 64 * MEBIBYTE,
        smdb: 640 * MEBIBYTE
      };

  return {
    translation: positiveByteLimit(env, 'CACHE_LIMIT_TRANSLATION', defaults.translation),
    bypass: positiveByteLimit(env, 'CACHE_LIMIT_BYPASS', defaults.bypass),
    partial: positiveByteLimit(env, 'CACHE_LIMIT_PARTIAL', defaults.partial),
    sync: positiveByteLimit(env, 'CACHE_LIMIT_SYNC', defaults.sync),
    autosub: positiveByteLimit(env, 'CACHE_LIMIT_AUTOSUB', defaults.autosub),
    embedded: positiveByteLimit(env, 'CACHE_LIMIT_EMBEDDED', defaults.embedded),
    session: null,
    history: positiveByteLimit(env, 'CACHE_LIMIT_HISTORY', defaults.history),
    provider_meta: positiveByteLimit(env, 'CACHE_LIMIT_PROVIDER_META', defaults.provider_meta),
    smdb: positiveByteLimit(env, 'CACHE_LIMIT_SMDB', defaults.smdb)
  };
}

/**
 * Storage Adapter Interface
 *
 * This interface defines the contract for storage adapters.
 * All storage adapters (Redis, Filesystem, etc.) must implement these methods.
 */

class StorageAdapter {
  constructor() {
    if (new.target === StorageAdapter) {
      throw new TypeError('Cannot instantiate abstract StorageAdapter class');
    }
  }

  /**
   * Get a value from storage
   * @param {string} key - The cache key
   * @param {string} cacheType - Cache type (TRANSLATION, BYPASS, PARTIAL, SYNC, SESSION)
   * @returns {Promise<any|null>} The cached value or null if not found
   */
  async get(key, cacheType) {
    throw new Error('Method get() must be implemented');
  }

  /**
   * Set a value in storage
   * @param {string} key - The cache key
   * @param {any} value - The value to store
   * @param {string} cacheType - Cache type (TRANSLATION, BYPASS, PARTIAL, SYNC, SESSION)
   * @param {number|null} ttl - Time to live in seconds (null = no expiry)
   * @returns {Promise<boolean>} True if successful
   */
  async set(key, value, cacheType, ttl = null) {
    throw new Error('Method set() must be implemented');
  }

  /**
   * Delete a value from storage
   * @param {string} key - The cache key
   * @param {string} cacheType - Cache type
   * @returns {Promise<boolean>} True if deleted
   */
  async delete(key, cacheType) {
    throw new Error('Method delete() must be implemented');
  }

  /**
   * Delete a value from alternate prefix variants (optional; Redis only).
   * @param {string} key - The cache key
   * @param {string} cacheType - Cache type
   * @returns {Promise<number>} Number of deleted keys
   */
  async deleteFromAlternatePrefixes(_key, _cacheType) {
    return 0;
  }

  /**
   * Check if a key exists
   * @param {string} key - The cache key
   * @param {string} cacheType - Cache type
   * @returns {Promise<boolean>} True if exists
   */
  async exists(key, cacheType) {
    throw new Error('Method exists() must be implemented');
  }

  /**
   * List keys matching a pattern
   * @param {string} cacheType - Cache type
   * @param {string} pattern - Pattern to match (optional)
   * @returns {Promise<string[]>} Array of matching keys
   */
  async list(cacheType, pattern = '*') {
    throw new Error('Method list() must be implemented');
  }

  /**
   * Get the total size of a cache type in bytes
   * @param {string} cacheType - Cache type
   * @returns {Promise<number>} Total size in bytes
   */
  async size(cacheType) {
    throw new Error('Method size() must be implemented');
  }

  /**
   * Get metadata about a cached entry
   * @param {string} key - The cache key
   * @param {string} cacheType - Cache type
   * @returns {Promise<object|null>} Metadata {size, createdAt, expiresAt} or null
   */
  async metadata(key, cacheType) {
    throw new Error('Method metadata() must be implemented');
  }

  /**
   * Clean up expired entries and enforce size limits
   * @param {string} cacheType - Cache type
   * @returns {Promise<{deleted: number, bytesFreed: number}>}
   */
  async cleanup(cacheType) {
    throw new Error('Method cleanup() must be implemented');
  }

  /**
   * Initialize the storage adapter
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('Method initialize() must be implemented');
  }

  /**
   * Close/cleanup the storage adapter
   * @returns {Promise<void>}
   */
  async close() {
    throw new Error('Method close() must be implemented');
  }

  /**
   * Health check for the storage adapter
   * @returns {Promise<boolean>} True if healthy
   */
  async healthCheck() {
    throw new Error('Method healthCheck() must be implemented');
  }
}

// Cache types
StorageAdapter.CACHE_TYPES = {
  TRANSLATION: 'translation',      // Permanent translation cache
  BYPASS: 'bypass',                // Temporary user-scoped cache (12h TTL)
  PARTIAL: 'partial',              // In-flight partial translations (1h TTL)
  SYNC: 'sync',                    // Synced subtitles
  AUTOSUB: 'autosub',              // AutoSubs outputs (separate from manual sync cache)
  EMBEDDED: 'embedded',            // Extracted/translated embedded subtitles
  SESSION: 'session',              // Session persistence (bounded by count/age, not bytes)
  HISTORY: 'history',              // Translation history
  PROVIDER_METADATA: 'provider_meta', // Provider-specific metadata (IMDB→movieId, etc.)
  SMDB: 'smdb'                     // SubMaker Database community subtitle cache
};

// Cache size limits in bytes
// Redis enforces these limits atomically. Filesystem storage treats them as soft
// limits enforced by cleanup routines.
//
// Ordinary self-hosted default: 2.5 GiB total. This deliberately leaves 1.5 GiB
// of the bundled 4 GiB Redis for sessions, metadata/indexes, fragmentation and
// Redis persistence/replication overhead. ELFHOSTED=true preserves the existing
// managed-deployment budgets; it does not trigger cache eviction during upgrade.
//
// Environment variables to override:
// - CACHE_LIMIT_TRANSLATION (default: 768 MiB)
// - CACHE_LIMIT_BYPASS (default: 128 MiB)
// - CACHE_LIMIT_PARTIAL (default: 128 MiB)
// - CACHE_LIMIT_SYNC (default: 192 MiB)
// - CACHE_LIMIT_AUTOSUB (default: 192 MiB)
// - CACHE_LIMIT_EMBEDDED (default: 192 MiB)
// - CACHE_LIMIT_HISTORY (default: 256 MiB)
// - CACHE_LIMIT_PROVIDER_META (default: 64 MiB)
// - CACHE_LIMIT_SMDB (default: 640 MiB)
//
// Example for larger deployments:
// CACHE_LIMIT_TRANSLATION=50000000000 (50GB) - requires Redis with 120GB+ RAM
StorageAdapter.getSizeLimits = resolveSizeLimits;
StorageAdapter.SIZE_LIMITS = resolveSizeLimits();

// Default TTL in seconds
StorageAdapter.DEFAULT_TTL = {
  [StorageAdapter.CACHE_TYPES.TRANSLATION]: null,     // No expiry
  [StorageAdapter.CACHE_TYPES.BYPASS]: 12 * 60 * 60, // 12 hours
  [StorageAdapter.CACHE_TYPES.PARTIAL]: 60 * 60,     // 1 hour
  [StorageAdapter.CACHE_TYPES.SYNC]: null,            // No expiry
  [StorageAdapter.CACHE_TYPES.AUTOSUB]: null,         // No expiry
  [StorageAdapter.CACHE_TYPES.EMBEDDED]: null,        // No expiry (shared cache across users)
  [StorageAdapter.CACHE_TYPES.SESSION]: null,         // No expiry
  [StorageAdapter.CACHE_TYPES.HISTORY]: 30 * 24 * 60 * 60, // 30 days
  [StorageAdapter.CACHE_TYPES.PROVIDER_METADATA]: 30 * 24 * 60 * 60, // 30 days - movieIds don't change
  [StorageAdapter.CACHE_TYPES.SMDB]: null // No expiry - oldest-first LRU eviction when size limit hit
};

module.exports = StorageAdapter;
