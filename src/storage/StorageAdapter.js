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
  TRANSLATION: 'translation',      // Permanent translation cache (50GB)
  BYPASS: 'bypass',                // Temporary user-scoped cache (10GB, 12h TTL)
  PARTIAL: 'partial',              // In-flight partial translations (10GB, 1h TTL)
  SYNC: 'sync',                    // Synced subtitles (50GB)
  SESSION: 'session'               // Session persistence (no limit)
};

// Cache size limits in bytes
// These limits apply ONLY when using Redis storage (STORAGE_TYPE=redis)
// For filesystem storage, these are soft limits (enforced by cleanup routines)
//
// IMPORTANT: Total cache size should be LESS than Redis maxmemory setting
// Default: 3GB total (fits in 4GB Redis with 1GB overhead for Redis internals)
//
// Environment variables to override:
// - CACHE_LIMIT_TRANSLATION (default: 1.5GB)
// - CACHE_LIMIT_BYPASS (default: 0.5GB)
// - CACHE_LIMIT_PARTIAL (default: 0.5GB)
// - CACHE_LIMIT_SYNC (default: 0.5GB)
//
// Example for larger deployments:
// CACHE_LIMIT_TRANSLATION=50000000000 (50GB) - requires Redis with 120GB+ RAM
StorageAdapter.SIZE_LIMITS = {
  [StorageAdapter.CACHE_TYPES.TRANSLATION]: parseInt(process.env.CACHE_LIMIT_TRANSLATION) || (1.5 * 1024 * 1024 * 1024), // 1.5GB - was 6GB (for 16GB Redis)
  [StorageAdapter.CACHE_TYPES.BYPASS]: parseInt(process.env.CACHE_LIMIT_BYPASS) || (0.5 * 1024 * 1024 * 1024),           // 0.5GB - was 2GB (for 16GB Redis)
  [StorageAdapter.CACHE_TYPES.PARTIAL]: parseInt(process.env.CACHE_LIMIT_PARTIAL) || (0.5 * 1024 * 1024 * 1024),         // 0.5GB - was 2GB (for 16GB Redis)
  [StorageAdapter.CACHE_TYPES.SYNC]: parseInt(process.env.CACHE_LIMIT_SYNC) || (0.5 * 1024 * 1024 * 1024),               // 0.5GB - was 2GB (for 16GB Redis)
  [StorageAdapter.CACHE_TYPES.SESSION]: null                                                                              // No limit
};

// Default TTL in seconds
StorageAdapter.DEFAULT_TTL = {
  [StorageAdapter.CACHE_TYPES.TRANSLATION]: null,     // No expiry
  [StorageAdapter.CACHE_TYPES.BYPASS]: 12 * 60 * 60, // 12 hours
  [StorageAdapter.CACHE_TYPES.PARTIAL]: 60 * 60,     // 1 hour
  [StorageAdapter.CACHE_TYPES.SYNC]: null,            // No expiry
  [StorageAdapter.CACHE_TYPES.SESSION]: null          // No expiry
};

module.exports = StorageAdapter;
