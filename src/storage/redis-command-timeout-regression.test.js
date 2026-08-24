const test = require('node:test');
const assert = require('node:assert/strict');

const RedisStorageAdapter = require('./RedisStorageAdapter');
const StorageAdapter = require('./StorageAdapter');
const { StorageUnavailableError } = require('./errors');

const MEBIBYTE = 1024 * 1024;

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

test('self-hosted Redis cache defaults reserve 1.5 GiB of the bundled 4 GiB Redis', () => {
  const limits = StorageAdapter.getSizeLimits({});
  const total = Object.values(limits)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);

  assert.equal(total, 2560 * MEBIBYTE);
  assert.equal(limits.session, null);
  assert.equal(limits.translation, 768 * MEBIBYTE);
  assert.equal(limits.smdb, 640 * MEBIBYTE);
});

test('ElfHosted retains its exact pre-1.4.92 cache budgets unless explicitly overridden', () => {
  const limits = StorageAdapter.getSizeLimits({ ELFHOSTED: 'true' });
  const total = Object.values(limits)
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);

  assert.equal(total, 7778336768);
  assert.equal(limits.translation, 1.5 * 1024 * MEBIBYTE);
  assert.equal(limits.smdb, 2 * 1024 * MEBIBYTE);

  const overridden = StorageAdapter.getSizeLimits({
    ELFHOSTED: 'true',
    CACHE_LIMIT_TRANSLATION: '123456'
  });
  assert.equal(overridden.translation, 123456);
});

test('Redis quota scripts declare every touched key and use cached EVALSHA commands', () => {
  const adapter = new RedisStorageAdapter({ keyPrefix: 'test' });
  const commands = new Map();

  adapter._defineAtomicCommands({
    defineCommand: (name, definition) => commands.set(name, definition)
  });

  assert.equal(commands.get('submakerAtomicCacheWrite').numberOfKeys, 5);
  assert.match(commands.get('submakerAtomicCacheWrite').lua, /projectedSize > sizeLimit/);
  assert.match(commands.get('submakerAtomicCacheWrite').lua, /redis\.call\('SET', KEYS\[4\], projectedSize\)/);
  assert.equal(commands.get('submakerAtomicCacheDelete').numberOfKeys, 5);
  assert.match(commands.get('submakerAtomicCacheDelete').lua, /nextSize < 0/);
});

test('Redis set evicts and retries only after the atomic quota command rejects growth', async () => {
  const cacheType = StorageAdapter.CACHE_TYPES.TRANSLATION;
  const adapter = new RedisStorageAdapter({
    keyPrefix: 'test',
    sizeLimits: { [cacheType]: 10 }
  });
  const writeCalls = [];
  const enforcementCalls = [];

  adapter.initialized = true;
  adapter.client = {
    submakerAtomicCacheWrite: async (...args) => {
      writeCalls.push(args);
      return writeCalls.length === 1 ? [0, 9, 2, 13] : [1, 8, 0, 8];
    }
  };
  adapter._enforceLimit = async (...args) => {
    enforcementCalls.push(args);
    return { deleted: 1, bytesFreed: 4 };
  };

  assert.equal(await adapter.set('protected-key', '123456', cacheType), true);
  assert.equal(writeCalls.length, 2);
  assert.deepEqual(enforcementCalls, [[cacheType, 4, 'protected-key']]);
});

test('periodic enforcement does not evict a healthy cache below its hard limit', async () => {
  const cacheType = StorageAdapter.CACHE_TYPES.TRANSLATION;
  const adapter = new RedisStorageAdapter({
    sizeLimits: { [cacheType]: 100 }
  });
  adapter.size = async () => 90;
  adapter.client = {
    zrange: async () => {
      throw new Error('zrange must not run below the hard limit');
    }
  };

  assert.deepEqual(
    await adapter._enforceLimit(cacheType),
    { deleted: 0, bytesFreed: 0 }
  );
});

test('Redis deletion does not create size counters for unlimited caches', async () => {
  const adapter = new RedisStorageAdapter({ host: '127.0.0.1', port: 6379 });
  const calls = [];

  adapter.initialized = true;
  adapter.client = {
    submakerAtomicCacheDelete: async (...args) => {
      calls.push(args);
      return [1, 1, 39];
    }
  };

  await adapter.delete('test-token', StorageAdapter.CACHE_TYPES.SESSION);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][5], 'test-token');
  assert.equal(calls[0][6], 0, 'unlimited sessions must not update a size counter');
  assert.equal(calls[0][7], 1, 'session index membership must be removed');
});

const integrationPort = Number(process.env.REDIS_INTEGRATION_PORT) || 0;
test('atomic quota scripts stay exact under concurrent writes on real Redis', {
  skip: integrationPort === 0,
  timeout: 15000
}, async () => {
  const cacheType = StorageAdapter.CACHE_TYPES.TRANSLATION;
  const prefix = `submaker-quota-test:${process.pid}:`;
  const adapter = new RedisStorageAdapter({
    host: '127.0.0.1',
    port: integrationPort,
    keyPrefix: prefix,
    sizeLimits: { [cacheType]: 100 }
  });

  await adapter.initialize();
  try {
    assert.equal(await adapter.set('updated', '1234', cacheType), true);
    assert.equal(await adapter.set('updated', '12345678', cacheType), true);
    assert.equal(await adapter.size(cacheType), 8, 'updates must count only their byte delta');

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => adapter.set(`parallel-${index}`, '1234567890', cacheType))
    );
    assert.equal(results.every(Boolean), true, 'bounded retries should absorb a moderate write burst');

    const trackedSize = await adapter.size(cacheType);
    assert.ok(trackedSize >= 0 && trackedSize <= 100);

    const keys = await adapter.list(cacheType);
    const metadata = await Promise.all(keys.map(key => adapter.metadata(key, cacheType)));
    const metadataTotal = metadata
      .filter(Boolean)
      .reduce((sum, entry) => sum + entry.size, 0);
    assert.equal(trackedSize, metadataTotal, 'counter must equal all surviving entry metadata');

    for (const key of keys) {
      await adapter.delete(key, cacheType);
    }
    assert.equal(await adapter.size(cacheType), 0);

    assert.equal(await adapter.set('expires', '1234', cacheType, 1), true);
    await new Promise(resolve => setTimeout(resolve, 1200));
    await adapter.cleanup(cacheType);
    assert.equal(await adapter.size(cacheType), 0, 'TTL cleanup must repair the byte counter');
    assert.equal(await adapter.metadata('expires', cacheType), null);

    assert.equal(await adapter.set('session-token', { ok: true }, StorageAdapter.CACHE_TYPES.SESSION, 60), true);
    assert.equal(await adapter.delete('session-token', StorageAdapter.CACHE_TYPES.SESSION), true);
    assert.equal(await adapter.client.get(adapter._getSizeKey(StorageAdapter.CACHE_TYPES.SESSION)), null);
  } finally {
    await adapter.close();
  }
});
