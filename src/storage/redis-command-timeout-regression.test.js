const test = require('node:test');
const assert = require('node:assert/strict');

const RedisStorageAdapter = require('./RedisStorageAdapter');
const StorageAdapter = require('./StorageAdapter');
const { StorageUnavailableError } = require('./errors');

test('Redis adapter sets a bounded command timeout and disables offline queueing', () => {
  const previousTimeout = process.env.REDIS_COMMAND_TIMEOUT_MS;
  process.env.REDIS_COMMAND_TIMEOUT_MS = '4321';

  try {
    const adapter = new RedisStorageAdapter({ host: '127.0.0.1', port: 6379 });

    assert.equal(adapter.options.commandTimeout, 4321);
    assert.equal(adapter.options.enableOfflineQueue, false);
    assert.equal(adapter.options.maxRetriesPerRequest, 3);
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.REDIS_COMMAND_TIMEOUT_MS;
    } else {
      process.env.REDIS_COMMAND_TIMEOUT_MS = previousTimeout;
    }
  }
});

test('Redis prefix migration does not block startup when an explicit prefix is configured', () => {
  const previousMigration = process.env.REDIS_PREFIX_MIGRATION;
  delete process.env.REDIS_PREFIX_MIGRATION;

  try {
    const explicitPrefix = new RedisStorageAdapter({
      host: '127.0.0.1',
      port: 6379,
      keyPrefix: 'stremio'
    });
    const fallbackPrefix = new RedisStorageAdapter({
      host: '127.0.0.1',
      port: 6379,
      keyPrefix: ''
    });

    assert.equal(explicitPrefix.options.keyPrefix, 'stremio:');
    assert.equal(explicitPrefix.prefixMigrationEnabled, false);
    assert.equal(fallbackPrefix.prefixMigrationEnabled, true);
  } finally {
    if (previousMigration === undefined) {
      delete process.env.REDIS_PREFIX_MIGRATION;
    } else {
      process.env.REDIS_PREFIX_MIGRATION = previousMigration;
    }
  }
});

test('Redis prefix migration remains explicitly configurable', () => {
  const previousMigration = process.env.REDIS_PREFIX_MIGRATION;

  try {
    process.env.REDIS_PREFIX_MIGRATION = 'true';
    assert.equal(new RedisStorageAdapter({ keyPrefix: 'stremio' }).prefixMigrationEnabled, true);

    process.env.REDIS_PREFIX_MIGRATION = 'false';
    assert.equal(new RedisStorageAdapter({}).prefixMigrationEnabled, false);
  } finally {
    if (previousMigration === undefined) {
      delete process.env.REDIS_PREFIX_MIGRATION;
    } else {
      process.env.REDIS_PREFIX_MIGRATION = previousMigration;
    }
  }
});

test('disabling startup prefix scans keeps per-key legacy recovery available', async () => {
  const previousMigration = process.env.REDIS_PREFIX_MIGRATION;
  delete process.env.REDIS_PREFIX_MIGRATION;

  try {
    const adapter = new RedisStorageAdapter({ keyPrefix: 'stremio' });
    const recoveredSession = { uiLanguage: 'en', subtitleProviders: {} };
    const recoveryCalls = [];

    adapter.initialized = true;
    adapter.client = {
      get: async () => null
    };
    adapter._migrateFromAlternatePrefixes = async (key, cacheType) => {
      recoveryCalls.push([key, cacheType]);
      return recoveredSession;
    };

    const result = await adapter.get('legacy-session', StorageAdapter.CACHE_TYPES.SESSION);

    assert.equal(adapter.prefixMigrationEnabled, false);
    assert.deepEqual(result, recoveredSession);
    assert.deepEqual(recoveryCalls, [['legacy-session', StorageAdapter.CACHE_TYPES.SESSION]]);
  } finally {
    if (previousMigration === undefined) {
      delete process.env.REDIS_PREFIX_MIGRATION;
    } else {
      process.env.REDIS_PREFIX_MIGRATION = previousMigration;
    }
  }
});

test('Redis command timeouts are not retried into long route stalls', async () => {
  const adapter = new RedisStorageAdapter({ host: '127.0.0.1', port: 6379 });
  let attempts = 0;

  await assert.rejects(
    adapter._executeWithRetry('test command timeout', async () => {
      attempts += 1;
      throw new Error('Command timed out');
    }),
    StorageUnavailableError
  );

  assert.equal(attempts, 1);
});

test('Redis cache metrics repair invalid negative size counters', async () => {
  const adapter = new RedisStorageAdapter({ host: '127.0.0.1', port: 6379 });
  const writes = [];
  adapter.initialized = true;
  adapter.client = {
    get: async () => '-39',
    set: async (...args) => writes.push(args)
  };

  const size = await adapter.size(StorageAdapter.CACHE_TYPES.SESSION);

  assert.equal(size, 0);
  assert.deepEqual(writes, [['size:session', 0]]);
});

test('Redis deletion does not create size counters for unlimited caches', async () => {
  const adapter = new RedisStorageAdapter({ host: '127.0.0.1', port: 6379 });
  const commands = [];
  const pipeline = {
    del: (...args) => commands.push(['del', ...args]),
    zrem: (...args) => commands.push(['zrem', ...args]),
    srem: (...args) => commands.push(['srem', ...args]),
    decrby: (...args) => commands.push(['decrby', ...args]),
    exec: async () => commands.map(() => [null, 1])
  };

  adapter.initialized = true;
  adapter.client = {
    hgetall: async () => ({ size: '39' }),
    pipeline: () => pipeline
  };

  await adapter.delete('test-token', StorageAdapter.CACHE_TYPES.SESSION);

  assert.equal(commands.some(([name]) => name === 'decrby'), false);
  assert.equal(commands.some(([name]) => name === 'srem'), true);
});
