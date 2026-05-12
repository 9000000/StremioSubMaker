const { MemoryStore } = require('express-rate-limit');
const { RedisStore: RateLimitRedisStore } = require('rate-limit-redis');

const DEFAULT_RETRY_INTERVAL_MS = 5000;
const DEFAULT_LOG_INTERVAL_MS = 60000;

function getStorageType() {
  return (process.env.STORAGE_TYPE || 'redis').toLowerCase();
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDefaultStorageFactory() {
  return require('../storage/StorageFactory');
}

function getDefaultLogger() {
  return require('./logger');
}

/**
 * express-rate-limit store that prefers Redis for cross-instance accuracy but
 * falls back to its own in-process MemoryStore immediately when Redis is not
 * ready or a Redis command fails.
 *
 * This avoids the bad public-deployment failure mode where rate-limit-redis
 * waits on startup SCRIPT LOAD promises for tens of seconds, then
 * express-rate-limit fails open and logs noisy store errors.
 */
class ResilientRateLimitRedisStore {
  constructor(options = {}) {
    this.prefix = options.prefix || 'rl:';
    this.storageFactory = options.storageFactory || getDefaultStorageFactory();
    this.RedisStoreClass = options.RedisStoreClass || RateLimitRedisStore;
    this.logger = options.logger || getDefaultLogger();
    this.memoryStore = options.memoryStore || new MemoryStore();
    this.retryIntervalMs = options.retryIntervalMs || parsePositiveInt(process.env.RATE_LIMIT_REDIS_RETRY_MS, DEFAULT_RETRY_INTERVAL_MS);
    this.logIntervalMs = options.logIntervalMs || parsePositiveInt(process.env.RATE_LIMIT_REDIS_LOG_INTERVAL_MS, DEFAULT_LOG_INTERVAL_MS);

    this.options = null;
    this.redisStore = null;
    this.redisInitPromise = null;
    this.nextInitAttemptAt = 0;
    this.lastWarnAt = 0;
    this.usingFallback = false;
  }

  init(options) {
    this.options = options;
    this.memoryStore.init(options);
    this._getRedisStore();
    this._ensureRedisInitialization();
  }

  async get(key) {
    const redisStore = this._getRedisStore();
    if (redisStore) {
      try {
        const result = await redisStore.get(key);
        this._markRedisSuccess();
        return result;
      } catch (error) {
        this._handleRedisFailure(error, 'get');
      }
    } else {
      this._ensureRedisInitialization();
    }

    return this.memoryStore.get(key);
  }

  async increment(key) {
    const redisStore = this._getRedisStore();
    if (redisStore) {
      try {
        const result = await redisStore.increment(key);
        this._markRedisSuccess();
        return result;
      } catch (error) {
        this._handleRedisFailure(error, 'increment');
      }
    } else {
      this._ensureRedisInitialization();
    }

    return this.memoryStore.increment(key);
  }

  async decrement(key) {
    const redisStore = this._getRedisStore();
    if (redisStore) {
      try {
        await redisStore.decrement(key);
        this._markRedisSuccess();
      } catch (error) {
        this._handleRedisFailure(error, 'decrement');
      }
    } else {
      this._ensureRedisInitialization();
    }

    return this.memoryStore.decrement(key);
  }

  async resetKey(key) {
    const redisStore = this._getRedisStore();
    if (redisStore) {
      try {
        await redisStore.resetKey(key);
        this._markRedisSuccess();
      } catch (error) {
        this._handleRedisFailure(error, 'resetKey');
      }
    } else {
      this._ensureRedisInitialization();
    }

    return this.memoryStore.resetKey(key);
  }

  async resetAll() {
    if (typeof this.memoryStore.resetAll === 'function') {
      await this.memoryStore.resetAll();
    }
  }

  shutdown() {
    if (typeof this.memoryStore.shutdown === 'function') {
      this.memoryStore.shutdown();
    }
  }

  _getRedisStore() {
    if (getStorageType() !== 'redis') {
      return null;
    }

    if (this.redisStore) {
      return this.redisStore;
    }

    const client = this.storageFactory.getRedisClient?.();
    if (!client) {
      return null;
    }

    this.redisStore = new this.RedisStoreClass({
      prefix: this.prefix,
      sendCommand: (...args) => {
        const liveClient = this.storageFactory.getRedisClient?.();
        if (!liveClient) {
          return Promise.reject(new Error('Redis client is not ready for rate limiting'));
        }
        return liveClient.call(...args);
      }
    });

    this.redisStore.incrementScriptSha?.catch?.(() => { });
    this.redisStore.getScriptSha?.catch?.(() => { });

    if (this.options && typeof this.redisStore.init === 'function') {
      this.redisStore.init(this.options);
    }

    return this.redisStore;
  }

  _ensureRedisInitialization() {
    if (getStorageType() !== 'redis') {
      return;
    }
    if (this.storageFactory.getRedisClient?.()) {
      return;
    }
    if (this.redisInitPromise) {
      return;
    }

    const now = Date.now();
    if (now < this.nextInitAttemptAt) {
      return;
    }

    const initializer = this.storageFactory.getStorageAdapter;
    if (typeof initializer !== 'function') {
      return;
    }

    this.redisInitPromise = Promise.resolve()
      .then(() => initializer.call(this.storageFactory))
      .catch((error) => {
        this._warn(`Redis is unavailable for ${this.prefix} rate limiting; using local memory fallback. ${error.message || error}`);
      })
      .finally(() => {
        this.redisInitPromise = null;
        this.nextInitAttemptAt = Date.now() + this.retryIntervalMs;
      });
  }

  _handleRedisFailure(error, operation) {
    this.redisStore = null;
    this._warn(`Redis ${operation} failed for ${this.prefix} rate limiting; using local memory fallback. ${error.message || error}`);
  }

  _markRedisSuccess() {
    if (this.usingFallback) {
      this.usingFallback = false;
      this.logger.info?.(() => `[RateLimit] Redis rate limiting recovered for ${this.prefix}`);
    }
  }

  _warn(message) {
    this.usingFallback = true;
    const now = Date.now();
    if (now - this.lastWarnAt < this.logIntervalMs) {
      return;
    }
    this.lastWarnAt = now;
    this.logger.warn?.(() => `[RateLimit] ${message}`);
  }
}

function createRateLimitRedisStore(prefix, options = {}) {
  if (getStorageType() !== 'redis') {
    return undefined;
  }

  return new ResilientRateLimitRedisStore({
    ...options,
    prefix: prefix || 'rl:'
  });
}

module.exports = {
  ResilientRateLimitRedisStore,
  createRateLimitRedisStore
};
