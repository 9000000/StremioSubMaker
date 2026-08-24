const log = require('../utils/logger');
const StorageAdapter = require('./StorageAdapter');
const { StorageUnavailableError } = require('./errors');
const Redis = require('ioredis');
const crypto = require('crypto');
const { getIsolationKey } = require('../utils/isolation');
const { getRedisPassword } = require('../utils/redisHelper');
const { handleCaughtError } = require('../utils/errorClassifier');

const SESSION_INDEX_KEY = 'session:index';
const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 5000;

// The size check and all writes that make up one cache entry must happen in one
// Redis operation. A pipeline only batches commands; it does not isolate them
// from concurrent writers in other SubMaker pods.
const ATOMIC_CACHE_WRITE_SCRIPT = `
local contentSize = tonumber(ARGV[2]) or 0
local now = ARGV[3]
local expiresAt = ARGV[4]
local ttl = tonumber(ARGV[5]) or 0
local sizeLimit = tonumber(ARGV[6]) or 0
local member = ARGV[7]
local isSession = ARGV[8] == '1'

local currentSize = tonumber(redis.call('GET', KEYS[4]) or '0') or 0
if currentSize < 0 then
  currentSize = 0
end

-- Old releases can leave a stale positive counter after every TTL-backed key
-- and its metadata have expired. It is safe to repair it when the LRU index is
-- empty because no quota-tracked entry remains.
if sizeLimit > 0 and currentSize > 0 and redis.call('ZCARD', KEYS[3]) == 0 then
  currentSize = 0
end

local oldSize = tonumber(redis.call('HGET', KEYS[2], 'size') or '0') or 0
local projectedSize = currentSize - oldSize + contentSize
if projectedSize < 0 then
  projectedSize = 0
end

if sizeLimit > 0 and projectedSize > sizeLimit then
  return {0, currentSize, oldSize, projectedSize}
end

local createdAt = redis.call('HGET', KEYS[2], 'createdAt') or now

if ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[1])
end

redis.call('HMSET', KEYS[2],
  'size', contentSize,
  'createdAt', createdAt,
  'expiresAt', expiresAt)

-- Quota-tracked metadata intentionally outlives TTL-backed content so cleanup
-- can subtract its exact serialized size after Redis expires the content key.
-- Unlimited session metadata keeps the session TTL and cannot accumulate.
if ttl > 0 and sizeLimit == 0 then
  redis.call('EXPIRE', KEYS[2], ttl)
else
  redis.call('PERSIST', KEYS[2])
end

redis.call('ZADD', KEYS[3], now, member)

if isSession then
  redis.call('SADD', KEYS[5], member)
end

if sizeLimit > 0 then
  redis.call('SET', KEYS[4], projectedSize)
end

return {1, projectedSize, oldSize, projectedSize}
`;

// Deleting content, metadata, the LRU/index member and its byte count is also a
// single operation. Concurrent eviction attempts therefore cannot decrement a
// cache counter twice or leave half-deleted entries behind.
const ATOMIC_CACHE_DELETE_SCRIPT = `
local member = ARGV[1]
local hasSizeLimit = ARGV[2] == '1'
local isSession = ARGV[3] == '1'
local oldSize = tonumber(redis.call('HGET', KEYS[2], 'size') or '0') or 0

local contentDeleted = redis.call('DEL', KEYS[1])
local metadataDeleted = redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], member)

if isSession then
  redis.call('SREM', KEYS[5], member)
end

if hasSizeLimit then
  local currentSize = tonumber(redis.call('GET', KEYS[4]) or '0') or 0
  local nextSize = currentSize - oldSize
  if nextSize < 0 then
    nextSize = 0
  end
  redis.call('SET', KEYS[4], nextSize)
end

return {contentDeleted, metadataDeleted, oldSize}
`;

function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Redis Storage Adapter
 *
 * Stores all cache data in Redis with support for:
 * - TTL-based expiration
 * - LRU eviction based on size limits
 * - Atomic operations
 * - High availability and horizontal scaling
 * - Optional Redis Sentinel for automatic failover (enterprise HA)
 */
class RedisStorageAdapter extends StorageAdapter {
  constructor(options = {}) {
    super();

    const {
      canonicalPrefix,
      variants,
      usedFallbackPrefix
    } = this._normalizeKeyPrefix(options.keyPrefix);

    // Prefix/key migration can unintentionally merge data between tenants when
    // a shared Redis instance is used (e.g., managed hosting). Keep it opt-in
    // to avoid cross-user config leakage while still allowing operators to
    // enable it explicitly for controlled single-tenant migrations.
    // Enable prefix self-healing by default when we're using the built-in
    // fallback prefix (no explicit REDIS_KEY_PREFIX provided). This allows us
    // to pull sessions/configs that were written with the previous
    // isolation-derived default before this fallback was introduced.
    const migrationEnv = process.env.REDIS_PREFIX_MIGRATION;
    this.prefixMigrationEnabled = migrationEnv === 'true'
      || (migrationEnv !== 'false' && usedFallbackPrefix);

    // Check if Redis Sentinel is enabled (disabled by default)
    const sentinelEnabled = process.env.REDIS_SENTINEL_ENABLED === 'true' || options.sentinelEnabled === true;

    // Avoid options spreading from clobbering the normalized keyPrefix. We still
    // honor other option fields, but keyPrefix must remain the canonical
    // colon-suffixed value so reads/writes stay in the same namespace across
    // restarts and deployments.
    const {
      keyPrefix: _ignoredKeyPrefix,
      sizeLimits: configuredSizeLimits,
      ...restOptions
    } = options || {};
    const commandTimeout = parsePositiveIntEnv('REDIS_COMMAND_TIMEOUT_MS', DEFAULT_REDIS_COMMAND_TIMEOUT_MS);

    // Keep limits instance-scoped so tests and specialized deployments can use
    // an explicit profile without mutating global process state.
    this.sizeLimits = configuredSizeLimits || StorageAdapter.SIZE_LIMITS;

    if (sentinelEnabled) {
      // Redis Sentinel configuration for HA deployments
      const sentinels = process.env.REDIS_SENTINELS
        ? process.env.REDIS_SENTINELS.split(',').map(s => {
          const [host, port] = s.trim().split(':');
          return { host, port: parseInt(port) || 26379 };
        })
        : options.sentinels || [{ host: 'localhost', port: 26379 }];

      const sentinelName = process.env.REDIS_SENTINEL_NAME || options.sentinelName || 'mymaster';

      this.options = {
        sentinels,
        name: sentinelName,
        password: restOptions.password || getRedisPassword() || undefined,
        db: restOptions.db || process.env.REDIS_DB || 0,
        keyPrefix: canonicalPrefix,
        commandTimeout,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        sentinelRetryStrategy: (times) => {
          const delay = Math.min(times * 100, 3000);
          return delay;
        },
        ...restOptions
      };
      log.debug(() => `[Redis] Sentinel mode enabled: ${sentinelName} with ${sentinels.length} sentinel(s)`);
    } else {
      // Standard Redis configuration (default for single-user deployments)
      this.options = {
        host: restOptions.host || process.env.REDIS_HOST || 'localhost',
        port: restOptions.port || process.env.REDIS_PORT || 6379,
        password: restOptions.password || getRedisPassword() || undefined,
        db: restOptions.db || process.env.REDIS_DB || 0,
        keyPrefix: canonicalPrefix,
        commandTimeout,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        ...restOptions
      };
    }

    this.client = null;
    this.migrationClient = null;
    this.initialized = false;
    this.sentinelMode = sentinelEnabled;
    this.prefixVariants = variants;
  }

  _getSizeLimit(cacheType) {
    return this.sizeLimits?.[cacheType] ?? null;
  }

  _defineAtomicCommands(client) {
    client.defineCommand('submakerAtomicCacheWrite', {
      numberOfKeys: 5,
      lua: ATOMIC_CACHE_WRITE_SCRIPT
    });
    client.defineCommand('submakerAtomicCacheDelete', {
      numberOfKeys: 5,
      lua: ATOMIC_CACHE_DELETE_SCRIPT
    });
  }

  async _validateRedisMemoryBudget() {
    try {
      const [maxMemoryReply, policyReply] = await Promise.all([
        this.client.config('GET', 'maxmemory'),
        this.client.config('GET', 'maxmemory-policy')
      ]);
      const replyValue = (reply, key) => {
        if (Array.isArray(reply)) return reply[1];
        if (reply && typeof reply === 'object') return reply[key];
        return null;
      };
      const maxMemory = Number(replyValue(maxMemoryReply, 'maxmemory')) || 0;
      const policy = replyValue(policyReply, 'maxmemory-policy') || 'unknown';
      const configuredCacheBytes = Object.values(this.sizeLimits)
        .filter(Number.isFinite)
        .reduce((total, value) => total + value, 0);

      if (maxMemory > 0) {
        const ratio = configuredCacheBytes / maxMemory;
        const summary = `${(configuredCacheBytes / (1024 ** 3)).toFixed(2)} GiB cache budget / ${(maxMemory / (1024 ** 3)).toFixed(2)} GiB maxmemory (${(ratio * 100).toFixed(1)}%, policy=${policy})`;
        if (ratio >= 0.8) {
          log.warn(() => `[RedisStorage] Cache budgets leave insufficient Redis headroom: ${summary}`);
        } else {
          log.debug(() => `[RedisStorage] Redis memory budget validated: ${summary}`);
        }
      } else {
        log.debug(() => `[RedisStorage] Redis maxmemory is unbounded; application cache quotas total ${(configuredCacheBytes / (1024 ** 3)).toFixed(2)} GiB (policy=${policy})`);
      }
    } catch (error) {
      // Managed Redis ACLs commonly disallow CONFIG GET. Budget validation is
      // diagnostic only and must never make storage startup fail.
      log.debug(() => `[RedisStorage] Redis memory budget validation unavailable: ${error.message}`);
    }
  }

  /**
   * Detect whether an error is likely transient/connection-related
   * @private
   */
  _isTransientRedisError(error = {}) {
    const code = error?.code;
    const message = error?.message || '';
    if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'NR_CLOSED'].includes(code)) {
      return true;
    }
    if (error?.name === 'MaxRetriesPerRequestError') {
      return true;
    }
    const transientPhrases = [
      'Connection is closed',
      'Connection is being closed',
      'The connection is already closed',
      'Socket closed unexpectedly',
      'connect ECONNREFUSED',
      'connect ETIMEDOUT',
      'Broken pipe',
      'Connection reset by peer',
      'Command timed out',
      "Stream isn't writeable"
    ];
    return transientPhrases.some(fragment => message.includes(fragment));
  }

  _shouldRetryRedisError(error = {}) {
    const message = error?.message || '';
    if (message.includes('Command timed out') || message.includes("Stream isn't writeable")) {
      return false;
    }
    return this._isTransientRedisError(error);
  }

  /**
   * Sleep helper for retry backoff
   * @private
   */
  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute a Redis operation with limited retries on transient failures
   * @private
   */
  async _executeWithRetry(operationName, fn) {
    const maxAttempts = 3;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const isTransient = this._isTransientRedisError(err);
        const shouldRetry = this._shouldRetryRedisError(err);

        if (shouldRetry && attempt < maxAttempts) {
          const delay = Math.min(100 * attempt, 750);
          log.warn(() => `[RedisStorage] ${operationName} transient failure (${err.message || err}), retrying in ${delay}ms (${attempt}/${maxAttempts})`);
          await this._sleep(delay);
          continue;
        }

        if (isTransient) {
          throw new StorageUnavailableError(`[RedisStorage] ${operationName} failed after ${maxAttempts} attempt(s)`, { operation: operationName, cause: err });
        }

        throw err;
      }
    }

    if (lastError) {
      log.error(() => [`[RedisStorage] ${operationName} failed after ${maxAttempts} attempt(s):`, lastError?.message || lastError]);
    }
    throw new StorageUnavailableError(`[RedisStorage] ${operationName} failed after ${maxAttempts} attempt(s)`, { operation: operationName, cause: lastError });
  }

  /**
   * Normalize configured keyPrefix and build variants to interop across deployments
   * (colon vs non-colon, custom variants, and empty prefix fallback)
   * @private
   */
  _normalizeKeyPrefix(configuredPrefix) {
    const isolationSegment = getIsolationKey();
    const isolationPrefix = `stremio:${isolationSegment}:`;

    // Use the explicit prefix when provided. Otherwise, fall back to the
    // legacy stable prefix so restarts continue to see previously stored
    // sessions/configs even when the instance ID changes. Include the
    // isolation-derived prefix as a variant so operators can migrate data
    // written before this change.
    const explicitPrefix = configuredPrefix ?? process.env.REDIS_KEY_PREFIX;
    const base = explicitPrefix || 'stremio:';
    const canonicalPrefix = !base || base.endsWith(':') ? base : `${base}:`;
    const usedFallbackPrefix = !explicitPrefix;

    const variants = new Set();
    const addVariants = (prefix) => {
      if (!prefix) return;
      const withColon = prefix.endsWith(':') ? prefix : `${prefix}:`;
      const withoutColon = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
      variants.add(withColon);
      variants.add(withoutColon);
    };

    addVariants(canonicalPrefix);
    if (configuredPrefix && configuredPrefix !== canonicalPrefix) {
      addVariants(configuredPrefix);
    }
    // Always include the legacy default so deployments migrating from the old
    // shared prefix can still read/cleanup previously stored data.
    addVariants('stremio:');

    // Include the isolation-derived prefix variant so migrations can recover
    // keys written with the older isolation-based default even when an
    // explicit REDIS_KEY_PREFIX is configured now.
    addVariants(isolationPrefix);

    if (process.env.REDIS_KEY_PREFIX_VARIANTS) {
      process.env.REDIS_KEY_PREFIX_VARIANTS
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(addVariants);
    }

    // Always include empty prefix as a fallback for deployments that used no prefix
    variants.add('');

    return {
      canonicalPrefix,
      variants: Array.from(variants),
      usedFallbackPrefix,
      isolationPrefix
    };
  }

  /**
   * Sanitize a cache key to prevent NoSQL injection attacks
   * @private
   * @param {string} key - The cache key to sanitize
   * @returns {string} - Sanitized key safe for Redis operations
   */
  _sanitizeKey(key) {
    // Validate input type
    if (!key || typeof key !== 'string') {
      throw new Error('Cache key must be a non-empty string');
    }

    // Remove potentially dangerous Redis wildcard and special characters
    // Replace: * ? [ ] \ with underscores to prevent pattern matching attacks
    let sanitized = key.replace(/[\*\?\[\]\\]/g, '_');

    // Also sanitize newlines, carriage returns, and null bytes that could cause issues
    sanitized = sanitized.replace(/[\r\n\0]/g, '_');

    // Limit key length to prevent DoS via extremely long keys
    const MAX_KEY_LENGTH = 250;
    if (sanitized.length > MAX_KEY_LENGTH) {
      // For very long keys, use a hash to ensure consistent length
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      // Keep first 200 chars + underscore + 16 char hash
      sanitized = sanitized.substring(0, 200) + '_' + hash.substring(0, 16);
      log.debug(() => `[RedisStorage] Long key truncated and hashed: ${key.substring(0, 50)}...`);
    }

    return sanitized;
  }

  /**
   * Get the full Redis key for a cache entry
   * @private
   */
  _getKey(key, cacheType) {
    // Sanitize the key to prevent NoSQL injection attacks
    const sanitizedKey = this._sanitizeKey(key);

    // Note: ioredis already applies `keyPrefix` to all command keys.
    // Do NOT include the prefix here to avoid double-prefixing.
    return `${cacheType}:${sanitizedKey}`;
  }

  /**
   * Get the metadata key for a cache entry
   * @private
   */
  _getMetadataKey(key, cacheType) {
    return `${this._getKey(key, cacheType)}:meta`;
  }

  /**
   * Get the sorted set key for LRU tracking
   * @private
   */
  _getLruKey(cacheType) {
    // Keep raw key; client keyPrefix will be applied by ioredis
    return `lru:${cacheType}`;
  }

  /**
   * Get the total size counter key for a cache type
   * @private
   */
  _getSizeKey(cacheType) {
    // Keep raw key; client keyPrefix will be applied by ioredis
    return `size:${cacheType}`;
  }

  /**
   * Get the session index key (used for O(1) session counts)
   * @returns {string}
   */
  getSessionIndexKey() {
    return SESSION_INDEX_KEY;
  }

  /**
   * Initialize the Redis connection
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      this.client = new Redis(this.options);
      this._defineAtomicCommands(this.client);

      await new Promise((resolve, reject) => {
        this.client.on('ready', resolve);
        this.client.on('error', reject);
        setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
      });

      await this._validateRedisMemoryBudget();

      if (this.prefixMigrationEnabled) {
        // Self-heal legacy double-prefixed keys to prevent invisible sessions/configs
        await this._migrateDoublePrefixedKeys();
        // Self-heal single-prefixed keys written with alternate prefixes (colon vs non-colon or custom)
        await this._migrateCrossPrefixKeys();
      } else {
        log.debug(() => '[RedisStorage] Prefix migration disabled (REDIS_PREFIX_MIGRATION!=true)');
      }

      this.initialized = true;
      log.debug(() => 'Redis storage adapter initialized successfully');
    } catch (error) {
      // Log a concise error message instead of the full stack trace
      const isConnectionError = error.code === 'ECONNREFUSED' || error.message === 'Redis connection timeout';
      if (isConnectionError) {
        log.debug(() => `Redis connection failed: Unable to connect to ${this.options.host}:${this.options.port}`);
      } else {
        log.error(() => 'Failed to initialize Redis storage adapter:', error.message);
      }
      throw error;
    }
  }

  /**
   * Migrate legacy double-prefixed keys (e.g., stremio:stremio:session:token)
   * to the corrected single-prefix format. This prevents invisible sessions
   * that can cause user configs (languages, API keys) to appear to "randomly"
   * change when Redis is used with a keyPrefix.
   *
   * Migration is capped to avoid long scans on large datasets.
   * @private
   */
  async _migrateDoublePrefixedKeys() {
    const targetPrefix = this.options.keyPrefix || '';
    // Only applicable when a non-empty prefix is set
    if (!targetPrefix) return;

    // Use normalized variants (colon/no-colon, env/custom) so mixed deployments converge
    const variants = new Set(this.prefixVariants.filter(Boolean));

    const doublePrefixes = [];
    for (const v of variants) {
      for (const u of variants) {
        if (!v || !u) continue;
        doublePrefixes.push(`${v}${u}`);
      }
    }

    const scanPatterns = Array.from(new Set(doublePrefixes)).map(dp => `${dp}*`);
    let cursor = '0';
    let migrated = 0;
    let cleaned = 0;
    const MIGRATION_LIMIT = 500; // safety cap
    const seenKeys = new Set();

    // Use a raw client without keyPrefix to avoid re-prefixing returned keys.
    // Enable lazyConnect so calling .connect() doesn't throw "already connecting/connected".
    const migrationClient = await this._getMigrationClient('[RedisStorage] Double-prefix migration skipped: could not open raw client:');
    if (!migrationClient) return;

    try {
      for (const scanPattern of scanPatterns) {
        cursor = '0';
        do {
          const [newCursor, keys] = await migrationClient.scan(cursor, 'MATCH', scanPattern, 'COUNT', 100);
          cursor = newCursor;

          for (const key of keys) {
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            if (migrated >= MIGRATION_LIMIT) {
              cursor = '0'; // break outer loop
              break;
            }

            // Only replace the leading double prefix to avoid mangling keys that include it elsewhere
            const matchedPrefix = doublePrefixes.find(dp => key.startsWith(dp)) || '';
            const fixedKey = matchedPrefix
              ? `${targetPrefix}${key.slice(matchedPrefix.length)}`
              : key;

            if (fixedKey === key) continue; // Nothing to fix

            try {
              const exists = await migrationClient.exists(fixedKey);
              if (exists) {
                // The single-prefix key already exists; remove the unusable double-prefixed duplicate to prevent repeated warnings.
                await migrationClient.del(key);
                cleaned++;
              } else {
                await migrationClient.rename(key, fixedKey);
                migrated++;
              }
            } catch (err) {
              log.error(() => [`[RedisStorage] Failed to migrate key ${key} -> ${fixedKey}:`, err.message]);
            }
          }
        } while (cursor !== '0');
      }

      if (migrated > 0 || cleaned > 0) {
        log.warn(() => `[RedisStorage] Migrated ${migrated} double-prefixed Redis key(s) and removed ${cleaned} duplicate(s) with existing targets`);
      }
    } catch (err) {
      log.error(() => ['[RedisStorage] Double-prefix migration failed:', err.message]);
    } finally {
      await this._closeMigrationClient();
    }
  }

  /**
   * Migrate single-prefixed keys from alternate prefixes (colon vs non-colon, custom variants)
   * so mixed deployments converge to this instance's prefix.
   * @private
   */
  async _migrateCrossPrefixKeys() {
    const targetPrefix = this.options.keyPrefix || '';
    if (!targetPrefix) return;

    const variants = this.prefixVariants;
    const altPrefixes = variants.filter(p => p && p !== targetPrefix);
    if (altPrefixes.length === 0) return;

    const migrationClient = await this._getMigrationClient('[RedisStorage] Cross-prefix migration skipped: could not open raw client:');
    if (!migrationClient) return;

    let migrated = 0;
    let cleaned = 0;
    const MIGRATION_LIMIT = 500;
    const seenKeys = new Set();

    try {
      for (const altPrefix of altPrefixes) {
        let cursor = '0';
        const scanPattern = `${altPrefix}*`;
        do {
          const [newCursor, keys] = await migrationClient.scan(cursor, 'MATCH', scanPattern, 'COUNT', 100);
          cursor = newCursor;

          for (const key of keys) {
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            if (migrated >= MIGRATION_LIMIT) {
              cursor = '0';
              break;
            }

            if (!key.startsWith(altPrefix)) continue;

            // Avoid clobbering keys that are already using the canonical prefix
            // when the alternate prefix is a prefix substring (e.g., "stremio"
            // vs "stremio:"). Without this guard, keys that already match the
            // canonical namespace get renamed into a double-prefixed variant
            // ("stremio::session:abc"), making sessions/configs disappear after
            // restart even though they still exist in Redis.
            if (key.startsWith(targetPrefix)) continue;
            const fixedKey = `${targetPrefix}${key.slice(altPrefix.length)}`;
            if (fixedKey === key) continue;

            try {
              const exists = await migrationClient.exists(fixedKey);
              if (exists) {
                await migrationClient.del(key);
                cleaned++;
              } else {
                await migrationClient.rename(key, fixedKey);
                migrated++;
              }
            } catch (err) {
              log.error(() => [`[RedisStorage] Failed to migrate key ${key} -> ${fixedKey}:`, err.message]);
            }
          }
        } while (cursor !== '0');
      }

      if (migrated > 0 || cleaned > 0) {
        log.warn(() => `[RedisStorage] Migrated ${migrated} cross-prefix Redis key(s) and removed ${cleaned} duplicate(s) with existing targets`);
      }
    } catch (err) {
      log.error(() => ['[RedisStorage] Cross-prefix migration failed:', err.message]);
    } finally {
      await this._closeMigrationClient();
    }
  }

  /**
   * Get or create a raw migration client (no keyPrefix) with lazy connect
   * @private
   */
  async _getMigrationClient(errorPrefix) {
    if (this.migrationClient) {
      return this.migrationClient;
    }

    const migrationClient = this.client.duplicate({ keyPrefix: '', lazyConnect: true });

    try {
      if (migrationClient.status === 'wait') {
        await migrationClient.connect();
      } else if (migrationClient.status !== 'ready') {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            migrationClient.removeListener('ready', onReady);
            migrationClient.removeListener('error', onError);
          };
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = (err) => {
            cleanup();
            reject(err);
          };

          migrationClient.once('ready', onReady);
          migrationClient.once('error', onError);
          setTimeout(() => onError(new Error('Redis migration client ready timeout')), 10000);
        });
      }
      this.migrationClient = migrationClient;
      return migrationClient;
    } catch (err) {
      log.error(() => [errorPrefix, err.message]);
      return null;
    }
  }

  /**
   * Close migration client if created
   * @private
   */
  async _closeMigrationClient() {
    if (this.migrationClient) {
      try {
        await this.migrationClient.disconnect();
      } catch (_) {
        // ignore
      }
      this.migrationClient = null;
    }
  }

  /**
   * Get a value from Redis
   */
  async get(key, cacheType) {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'get' });
    }

    try {
      return await this._executeWithRetry(`get ${cacheType}`, async () => {
        const redisKey = this._getKey(key, cacheType);
        const content = await this.client.get(redisKey);

        if (!content) {
          // Debug: log when session not found
          if (cacheType === StorageAdapter.CACHE_TYPES.SESSION) {
            log.debug(() => `[RedisStorage] Session NOT found in Redis: ${key.substring(0, 8)}...${key.substring(key.length - 4)} (tried key: ${redisKey})`);
          }
          // If the key isn't found under the canonical prefix, try to self-heal
          // across alternate prefixes (colon/no-colon, fallback/default) so
          // sessions/configs don't "disappear" after restarts when the prefix
          // changes. This is intentionally scoped to our known variants to avoid
          // cross-tenant leakage on shared Redis deployments.
          const migrated = await this._migrateFromAlternatePrefixes(key, cacheType);
          if (!migrated) {
            return null;
          }
          return migrated;
        }

        // Update LRU timestamp
        const now = Date.now();
        await this.client.zadd(this._getLruKey(cacheType), now, key);

        // Parse JSON if it's a JSON string
        try {
          return JSON.parse(content);
        } catch {
          return content;
        }
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis get error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Attempt to read and migrate a key stored under an alternate prefix variant
   * (e.g., colon vs no-colon) back into the canonical prefix. This prevents
   * silent config/session loss after restarts when the configured prefix
   * changes or the isolation-derived fallback is used.
   * @private
   */
  async _migrateFromAlternatePrefixes(key, cacheType) {
    if (!this.prefixVariants || this.prefixVariants.length === 0) {
      return null;
    }

    const canonicalPrefix = this.options.keyPrefix || '';
    const sanitizedKey = this._sanitizeKey(key);
    const contentKeySuffix = `${cacheType}:${sanitizedKey}`;

    // Use a raw client without keyPrefix to read alternate namespaces
    const migrationClient = await this._getMigrationClient('[RedisStorage] Cross-prefix fetch skipped: could not open raw client:');
    if (!migrationClient) return null;

    // Cover double-prefixed legacy keys by expanding variants with the canonical prefix
    const altPrefixes = new Set(this.prefixVariants);
    for (const alt of this.prefixVariants) {
      if (canonicalPrefix) {
        altPrefixes.add(`${alt}${canonicalPrefix}`);
        altPrefixes.add(`${canonicalPrefix}${alt}`);
      }
    }

    for (const altPrefix of altPrefixes) {
      // Skip the canonical prefix – the normal get() already tried it
      if (altPrefix === canonicalPrefix) continue;
      const altContentKey = `${altPrefix}${contentKeySuffix}`;
      try {
        const content = await migrationClient.get(altContentKey);
        if (!content) continue;

        // Pull metadata + TTL from the old namespace so we can rehydrate
        const altMetaKey = `${altContentKey}:meta`;
        const altLruKey = `${altPrefix}lru:${cacheType}`;
        const [ttl, meta, lruScore] = await Promise.all([
          migrationClient.ttl(altContentKey),
          migrationClient.hgetall(altMetaKey),
          migrationClient.zscore(altLruKey, key)
        ]);

        const parsed = (() => {
          try { return JSON.parse(content); } catch { return content; }
        })();

        // Write into canonical prefix using the standard client so future reads
        // hit the normal fast path
        const pipeline = this.client.pipeline();
        const canonicalKey = this._getKey(key, cacheType);
        const canonicalMetaKey = this._getMetadataKey(key, cacheType);
        const canonicalLruKey = this._getLruKey(cacheType);

        if (ttl && ttl > 0) {
          pipeline.setex(canonicalKey, ttl, content);
          pipeline.expire(canonicalMetaKey, ttl);
        } else {
          pipeline.set(canonicalKey, content);
        }

        const now = Date.now();
        pipeline.hmset(canonicalMetaKey, {
          size: meta.size || Buffer.byteLength(content, 'utf8'),
          createdAt: meta.createdAt || now,
          expiresAt: meta.expiresAt || (ttl && ttl > 0 ? now + (ttl * 1000) : 'null')
        });

        // Preserve LRU ordering when available
        pipeline.zadd(canonicalLruKey, lruScore || now, key);

        // Do NOT delete the old entry; keep both namespaces readable so either
        // prefix continues to work without destructive migrations.

        await pipeline.exec();
        log.warn(() => `[RedisStorage] Migrated ${cacheType} key across prefixes (${altPrefix} -> ${canonicalPrefix || '<none>'}): ${key}`);
        return parsed;
      } catch (err) {
        log.error(() => ['[RedisStorage] Failed cross-prefix migration for key', key, 'prefix', altPrefix, err.message]);
      }
    }

    return null;
  }

  /**
   * Set a value in Redis
   */
  async set(key, value, cacheType, ttl = null) {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'set' });
    }

    try {
      return await this._executeWithRetry(`set ${cacheType}`, async () => {
        const redisKey = this._getKey(key, cacheType);
        const metaKey = this._getMetadataKey(key, cacheType);
        const lruKey = this._getLruKey(cacheType);
        const sizeKey = this._getSizeKey(cacheType);
        const sessionIndexKey = this.getSessionIndexKey();

        // Serialize value
        const content = typeof value === 'string' ? value : JSON.stringify(value);
        const contentSize = Buffer.byteLength(content, 'utf8');
        const sizeLimit = this._getSizeLimit(cacheType) || 0;
        if (sizeLimit > 0 && contentSize > sizeLimit) {
          log.warn(() => `[RedisStorage] Refused ${cacheType} entry larger than its entire cache quota (${contentSize} > ${sizeLimit} bytes)`);
          return false;
        }

        const now = Date.now();
        const expiresAt = ttl ? now + (ttl * 1000) : null;

        // A rejected write means another entry must be evicted first. The Lua
        // command performs the quota check and write atomically, so concurrent
        // pods can never all pass the same stale size check and overshoot.
        // A burst from several pods can refill the quota between eviction and
        // retry. Keep retries bounded, but allow enough turns for contenders to
        // converge without turning a successful cacheable response into a miss.
        const maxWriteAttempts = 8;
        for (let attempt = 0; attempt < maxWriteAttempts; attempt++) {
          const result = await this.client.submakerAtomicCacheWrite(
            redisKey,
            metaKey,
            lruKey,
            sizeKey,
            sessionIndexKey,
            content,
            contentSize,
            now,
            expiresAt || 'null',
            ttl && ttl > 0 ? ttl : 0,
            sizeLimit,
            key,
            cacheType === StorageAdapter.CACHE_TYPES.SESSION ? 1 : 0
          );

          if (Array.isArray(result) && Number(result[0]) === 1) {
            if (cacheType === StorageAdapter.CACHE_TYPES.SESSION) {
              log.debug(() => `[RedisStorage] Session persisted to Redis: ${key.substring(0, 8)}...${key.substring(key.length - 4)} (ttl=${ttl || 'none'})`);
            }
            return true;
          }

          if (!sizeLimit || !Array.isArray(result)) {
            return false;
          }

          if (attempt === maxWriteAttempts - 1) {
            break;
          }

          const oldSize = Math.max(0, Number(result[2]) || 0);
          const requiredGrowth = Math.max(0, contentSize - oldSize);
          await this._enforceLimit(cacheType, requiredGrowth, key);
          // Even when this worker deleted nothing, another concurrent writer
          // may just have freed the required space. Always retry the atomic
          // admission check rather than converting that benign race to a miss.
        }

        log.warn(() => `[RedisStorage] Could not make space for ${cacheType} key within its configured quota`);
        return false;
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis set error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete a value from Redis
   */
  async delete(key, cacheType) {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'delete' });
    }

    try {
      return await this._executeWithRetry(`delete ${cacheType}`, async () => {
        const redisKey = this._getKey(key, cacheType);
        const metaKey = this._getMetadataKey(key, cacheType);
        const lruKey = this._getLruKey(cacheType);
        const sizeKey = this._getSizeKey(cacheType);
        await this.client.submakerAtomicCacheDelete(
          redisKey,
          metaKey,
          lruKey,
          sizeKey,
          this.getSessionIndexKey(),
          key,
          this._getSizeLimit(cacheType) ? 1 : 0,
          cacheType === StorageAdapter.CACHE_TYPES.SESSION ? 1 : 0
        );
        return true;
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis delete error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete a value from alternate prefix variants (legacy/colon mismatch cleanup)
   * @returns {Promise<number>} Number of deleted keys
   */
  async deleteFromAlternatePrefixes(key, cacheType) {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'deleteFromAlternatePrefixes' });
    }

    try {
      return await this._executeWithRetry(`delete alternate ${cacheType}`, async () => {
        if (!this.prefixVariants || this.prefixVariants.length === 0) {
          return 0;
        }

        const canonicalPrefix = this.options.keyPrefix || '';
        const sanitizedKey = this._sanitizeKey(key);
        const keySuffix = `${cacheType}:${sanitizedKey}`;

        const altPrefixes = new Set(this.prefixVariants);
        if (canonicalPrefix) {
          for (const alt of this.prefixVariants) {
            altPrefixes.add(`${alt}${canonicalPrefix}`);
            altPrefixes.add(`${canonicalPrefix}${alt}`);
          }
        }
        altPrefixes.delete(canonicalPrefix);

        const migrationClient = await this._getMigrationClient('[RedisStorage] Alternate-prefix delete skipped: could not open raw client:');
        if (!migrationClient) return 0;

        let deleted = 0;

        for (const altPrefix of altPrefixes) {
          if (altPrefix === canonicalPrefix) continue;
          const contentKey = `${altPrefix}${keySuffix}`;
          const metaKey = `${contentKey}:meta`;
          const lruKey = `${altPrefix}lru:${cacheType}`;
          const sizeKey = `${altPrefix}size:${cacheType}`;
          const indexKey = `${altPrefix}${SESSION_INDEX_KEY}`;

          const result = await migrationClient.eval(
            ATOMIC_CACHE_DELETE_SCRIPT,
            5,
            contentKey,
            metaKey,
            lruKey,
            sizeKey,
            indexKey,
            key,
            this._getSizeLimit(cacheType) ? 1 : 0,
            cacheType === StorageAdapter.CACHE_TYPES.SESSION ? 1 : 0
          );
          if (Array.isArray(result)) {
            deleted += (Number(result[0]) || 0) + (Number(result[1]) || 0);
          }
        }

        return deleted;
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis delete alternate prefixes error for key ${key}:`, error);
      return 0;
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key, cacheType) {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'exists' });
    }

    try {
      return await this._executeWithRetry(`exists ${cacheType}`, async () => {
        const redisKey = this._getKey(key, cacheType);
        const exists = await this.client.exists(redisKey);
        return exists === 1;
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis exists error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * List keys matching a pattern
   */
  async list(cacheType, pattern = '*') {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'list' });
    }

    try {
      return await this._executeWithRetry(`list ${cacheType}`, async () => {
        // Use SCAN for better performance with large datasets
        const keys = [];

        // CRITICAL FIX: ioredis does NOT apply keyPrefix to SCAN MATCH patterns!
        // We must include the full prefix in the pattern manually, otherwise
        // SCAN won't find any keys when keyPrefix is configured.
        // This bug caused list() to always return zero keys, making cleanup,
        // snapshots, and preloading fail silently.
        const configuredPrefix = this.options.keyPrefix || '';
        const scanPattern = `${configuredPrefix}${cacheType}:${pattern}`;
        let cursor = '0';

        do {
          const result = await this.client.scan(cursor, 'MATCH', scanPattern, 'COUNT', 100);
          cursor = result[0];
          const foundKeys = result[1];

          // Strip prefix and cache type from keys. SCAN returns full Redis keys
          // (not de-prefixed by ioredis), so we need to strip both the configured
          // prefix and the cache type to get just the session token.
          const prefix = `${configuredPrefix}${cacheType}:`;
          for (const key of foundKeys) {
            if (key.endsWith(':meta')) continue; // Skip metadata keys
            const withoutPrefix = key.startsWith(prefix)
              ? key.substring(prefix.length)
              : key.replace(new RegExp(`^${cacheType}:`), '');
            keys.push(withoutPrefix);
          }
        } while (cursor !== '0');

        if (cacheType === StorageAdapter.CACHE_TYPES.SESSION) {
          const sessionTokenCount = keys.filter(k => /^[a-f0-9]{32}$/.test(k)).length;
          const helperKeyCount = keys.length - sessionTokenCount;
          log.debug(() => `[RedisStorage] SCAN with pattern ${scanPattern} found ${keys.length} session key(s) (tokens: ${sessionTokenCount}, helper keys: ${helperKeyCount})`);
        } else {
          log.debug(() => `[RedisStorage] SCAN with pattern ${scanPattern} found ${keys.length} ${cacheType} key(s)`);
        }
        return keys;
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis list error for cache type ${cacheType}:`, error);
      return [];
    }
  }

  /**
   * Get current session count from the index (Redis only)
   * @returns {Promise<number>}
   */
  async getSessionCount() {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'getSessionCount' });
    }
    try {
      return await this._executeWithRetry('session count', async () => {
        const count = await this.client.scard(this.getSessionIndexKey());
        return typeof count === 'number' ? count : 0;
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis session count error:`, error);
      return 0;
    }
  }

  /**
   * Rebuild the session index from a list of tokens (idempotent)
   * @param {string[]} tokens
   * @returns {Promise<void>}
   */
  async resetSessionIndex(tokens = []) {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'resetSessionIndex' });
    }

    const indexKey = this.getSessionIndexKey();
    const chunkSize = 500;

    return this._executeWithRetry('reset session index', async () => {
      const pipeline = this.client.pipeline();
      pipeline.del(indexKey);

      if (tokens.length > 0) {
        for (let i = 0; i < tokens.length; i += chunkSize) {
          const chunk = tokens.slice(i, i + chunkSize);
          pipeline.sadd(indexKey, ...chunk);
        }
      }

      await pipeline.exec();
    });
  }

  /**
   * Get the total size of a cache type
   */
  async size(cacheType) {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'size' });
    }

    try {
      return await this._executeWithRetry(`size ${cacheType}`, async () => {
        const sizeKey = this._getSizeKey(cacheType);
        const size = await this.client.get(sizeKey);
        if (!size) return 0;

        const parsedSize = parseInt(size, 10);
        if (!Number.isSafeInteger(parsedSize) || parsedSize < 0) {
          // Repair counters produced by older releases that decremented
          // unlimited cache types without ever incrementing them.
          await this.client.set(sizeKey, 0);
          return 0;
        }

        return parsedSize;
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis size error for cache type ${cacheType}:`, error);
      return 0;
    }
  }

  /**
   * Get metadata about a cached entry
   */
  async metadata(key, cacheType) {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'metadata' });
    }

    try {
      return await this._executeWithRetry(`metadata ${cacheType}`, async () => {
        const metaKey = this._getMetadataKey(key, cacheType);
        const meta = await this.client.hgetall(metaKey);

        if (!meta || Object.keys(meta).length === 0) {
          return null;
        }

        return {
          size: parseInt(meta.size || '0', 10),
          createdAt: parseInt(meta.createdAt || '0', 10),
          expiresAt: meta.expiresAt === 'null' ? null : parseInt(meta.expiresAt, 10)
        };
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis metadata error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * List logical keys from the LRU index. Unlike list(), this still sees an
   * entry after Redis expires its TTL-backed content key, allowing cleanup to
   * remove persistent quota metadata and repair the byte counter.
   * @private
   */
  async _listLruMembers(cacheType) {
    const members = [];
    const lruKey = this._getLruKey(cacheType);
    let cursor = '0';

    do {
      const [nextCursor, values] = await this.client.zscan(lruKey, cursor, 'COUNT', 100);
      cursor = nextCursor;
      for (let index = 0; index < values.length; index += 2) {
        members.push(values[index]);
      }
    } while (cursor !== '0');

    return members;
  }

  /**
   * Enforce size limit by evicting oldest entries (LRU)
   * @private
   */
  async _enforceLimit(cacheType, requiredSpace = 0, protectedKey = null) {
    const sizeLimit = this._getSizeLimit(cacheType);
    if (!sizeLimit) {
      return { deleted: 0, bytesFreed: 0 };
    }

    try {
      let currentSize = await this.size(cacheType);
      if (currentSize + requiredSpace <= sizeLimit) {
        return { deleted: 0, bytesFreed: 0 };
      }

      const targetSize = Math.floor(sizeLimit * 0.8); // Free up to 80% of limit
      let needToFree = (currentSize + requiredSpace) - targetSize;

      // Get oldest entries from LRU sorted set
      const lruKey = this._getLruKey(cacheType);
      let deleted = 0;
      let bytesFreed = 0;

      while (needToFree > 0) {
        // Always read from rank zero. Deleting members shifts the remaining
        // entries down; advancing an offset would skip every second batch.
        const oldestKeys = await this.client.zrange(lruKey, 0, 99);

        if (oldestKeys.length === 0) {
          break; // No more entries to delete
        }

        const candidates = protectedKey
          ? oldestKeys.filter(candidate => candidate !== protectedKey)
          : oldestKeys;
        if (candidates.length === 0) {
          break;
        }

        for (const candidate of candidates) {
          const meta = await this.metadata(candidate, cacheType);
          await this.delete(candidate, cacheType);
          deleted++;
          if (meta) {
            bytesFreed += meta.size;
          }

          currentSize = await this.size(cacheType);
          needToFree = (currentSize + requiredSpace) - targetSize;
          if (needToFree <= 0) break;
        }
      }

      log.debug(() => `Enforced ${cacheType} cache limit: deleted ${deleted} entries, freed ${bytesFreed} bytes`);
      return { deleted, bytesFreed };
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis enforce limit error for cache type ${cacheType}:`, error);
      return { deleted: 0, bytesFreed: 0 };
    }
  }

  /**
   * Clean up expired entries
   */
  async cleanup(cacheType) {
    if (!this.initialized) {
      throw new StorageUnavailableError('Storage adapter not initialized', { operation: 'cleanup' });
    }

    try {
      // Redis automatically handles TTL expiration, but we need to clean up orphaned metadata
      // and enforce size limits

      let deleted = 0;
      let bytesFreed = 0;

      // The LRU index deliberately outlives TTL-backed content. Walking it
      // allows exact byte-counter repair after Redis expires a content key.
      const keys = await this._listLruMembers(cacheType);

      for (const key of keys) {
        const redisKey = this._getKey(key, cacheType);
        const exists = await this.client.exists(redisKey);

        // If the main key no longer exists, atomically clean metadata, LRU and
        // the size counter. Also remove legacy orphan LRU members with no meta.
        if (!exists) {
          const meta = await this.metadata(key, cacheType);
          if (meta) {
            bytesFreed += meta.size;
          }
          await this.delete(key, cacheType);
          deleted++;
        }
      }

      // Enforce size limits
      const limitResult = await this._enforceLimit(cacheType);
      deleted += limitResult.deleted;
      bytesFreed += limitResult.bytesFreed;

      return { deleted, bytesFreed };
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw error;
      }
      log.error(() => `Redis cleanup error for cache type ${cacheType}:`, error);
      return { deleted: 0, bytesFreed: 0 };
    }
  }

  /**
   * Get the underlying ioredis client (e.g. for pub/sub duplicate connections)
   * @returns {import('ioredis')|null}
   */
  getClient() {
    return this.initialized ? this.client : null;
  }

  /**
   * Close the Redis connection
   */
  async close() {
    if (this.client) {
      await this.client.quit();
      this.initialized = false;
      log.debug(() => 'Redis storage adapter closed');
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (!this.initialized) {
      return false;
    }

    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      log.error(() => 'Redis health check failed:', error);
      return false;
    }
  }
}

module.exports = RedisStorageAdapter;
