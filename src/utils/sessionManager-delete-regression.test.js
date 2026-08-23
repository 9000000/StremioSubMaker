'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STORAGE_TYPE = 'filesystem';

const { StorageFactory, StorageAdapter } = require('../storage');
const { SessionManager } = require('./sessionManager');

test('session history purge uses the bounded store/index path without Redis SCAN', async (t) => {
    const deletedKeys = [];
    const redisClient = {
        async zrange(key, start, end) {
            assert.equal(key, 'histidx__sesshist_example');
            assert.equal(start, 0);
            assert.equal(end, -1);
            return ['indexed-entry'];
        },
        async del(key) {
            assert.equal(key, 'histidx__sesshist_example');
            return 1;
        }
    };
    const fakeAdapter = {
        async get(key, cacheType) {
            assert.equal(cacheType, StorageAdapter.CACHE_TYPES.HISTORY);
            assert.equal(key, 'histset__sesshist_example');
            return { entries: { 'stored-entry': { id: 'stored-entry' } } };
        },
        async delete(key, cacheType) {
            assert.equal(cacheType, StorageAdapter.CACHE_TYPES.HISTORY);
            deletedKeys.push(key);
            return true;
        },
        async list() {
            throw new Error('history purge must not SCAN');
        },
        getClient() {
            return redisClient;
        }
    };

    const previous = StorageFactory.instance;
    StorageFactory.instance = fakeAdapter;
    t.after(() => { StorageFactory.instance = previous; });

    const manager = Object.create(SessionManager.prototype);
    const deletedCount = await manager._purgeHistoryNamespace('sesshist_example');

    assert.equal(deletedCount, 8);
    assert.deepEqual(new Set(deletedKeys), new Set([
        'histset__sesshist_example',
        'hist__sesshist_example__stored-entry',
        'hist_sesshist_example_stored-entry',
        'hist:sesshist_example:stored-entry',
        'hist__sesshist_example__indexed-entry',
        'hist_sesshist_example_indexed-entry',
        'hist:sesshist_example:indexed-entry'
    ]));
});
