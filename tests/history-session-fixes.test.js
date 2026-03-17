const test = require('node:test');
const assert = require('node:assert/strict');

const StorageFactory = require('../src/storage/StorageFactory');
const subtitles = require('../src/handlers/subtitles');

const originalGetStorageAdapter = StorageFactory.getStorageAdapter;
const originalGetRedisClient = StorageFactory.getRedisClient;

test.after(() => {
  StorageFactory.getStorageAdapter = originalGetStorageAdapter;
  StorageFactory.getRedisClient = originalGetRedisClient;
});

test('resolveHistoryUserHash prefers stable session-scoped history identity', () => {
  const resolved = subtitles.resolveHistoryUserHash(
    {
      __historyUserHash: 'sesshist_1234abcd',
      userHash: 'user_hash',
      __configHash: 'config_hash'
    },
    'explicit_hash'
  );

  assert.equal(resolved, 'sesshist_1234abcd');
});

test('getHistoryForUser skips the slow scan path when disabled', async () => {
  let listCalls = 0;

  StorageFactory.getStorageAdapter = async () => ({
    get: async () => null,
    list: async () => {
      listCalls += 1;
      return [];
    },
    set: async () => true
  });
  StorageFactory.getRedisClient = () => ({
    zrevrange: async () => []
  });

  const history = await subtitles.getHistoryForUser('sesshist_deadbeef', { allowSlowScan: false });

  assert.deepEqual(history, []);
  assert.equal(listCalls, 0);
});
