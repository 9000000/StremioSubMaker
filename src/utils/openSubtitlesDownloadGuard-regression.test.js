'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    checkOpenSubtitlesDownloadIntent,
    resetOpenSubtitlesDownloadGuardForTests
} = require('./openSubtitlesDownloadGuard');

function createSharedRedisSimulation() {
    const windows = new Map();
    let now = 1_000_000;

    return {
        advance(ms) {
            now += ms;
        },
        options: {
            now: () => now,
            windowMs: 15_000,
            repeatDelayMs: 1_000,
            async evaluateRedis(configHash, fileHash, timestamp, windowMs, repeatDelayMs) {
                const existing = windows.get(configHash);
                const entry = existing && existing.expiresAt > timestamp
                    ? existing
                    : { files: new Map(), expiresAt: timestamp + windowMs };
                const previous = entry.files.get(fileHash);
                entry.expiresAt = timestamp + windowMs;

                if (previous !== undefined) {
                    const elapsedMs = timestamp - previous;
                    windows.set(configHash, entry);
                    return {
                        allowed: elapsedMs >= repeatDelayMs,
                        reason: elapsedMs >= repeatDelayMs ? 'repeated-selection' : 'duplicate-prefetch',
                        repeated: true,
                        count: entry.files.size,
                        retryAfterMs: Math.max(0, repeatDelayMs - elapsedMs)
                    };
                }

                entry.files.set(fileHash, timestamp);
                windows.set(configHash, entry);
                return {
                    allowed: entry.files.size === 1,
                    reason: entry.files.size === 1 ? 'first-request' : 'distinct-file-prefetch',
                    repeated: false,
                    count: entry.files.size,
                    retryAfterMs: entry.files.size === 1 ? 0 : repeatDelayMs
                };
            }
        }
    };
}

test.beforeEach(() => resetOpenSubtitlesDownloadGuardForTests());

test('allows one download but defers different file IDs from a prefetch burst', async () => {
    const shared = createSharedRedisSimulation();

    const first = await checkOpenSubtitlesDownloadIntent('session-a', 'file-1', shared.options);
    const prefetched = await checkOpenSubtitlesDownloadIntent('session-a', 'file-2', shared.options);

    assert.equal(first.allowed, true);
    assert.equal(first.reason, 'first-request');
    assert.equal(prefetched.allowed, false);
    assert.equal(prefetched.reason, 'distinct-file-prefetch');
});

test('allows the selected subtitle when a prefetched file ID is requested again', async () => {
    const shared = createSharedRedisSimulation();

    await checkOpenSubtitlesDownloadIntent('session-a', 'file-1', shared.options);
    await checkOpenSubtitlesDownloadIntent('session-a', 'file-2', shared.options);

    const immediateDuplicate = await checkOpenSubtitlesDownloadIntent('session-a', 'file-2', shared.options);
    assert.equal(immediateDuplicate.allowed, false);
    assert.equal(immediateDuplicate.reason, 'duplicate-prefetch');

    shared.advance(1_100);
    const selected = await checkOpenSubtitlesDownloadIntent('session-a', 'file-2', shared.options);
    assert.equal(selected.allowed, true);
    assert.equal(selected.reason, 'repeated-selection');
});

test('shares the prefetch decision across replicas while isolating sessions', async () => {
    const shared = createSharedRedisSimulation();

    const podOne = await checkOpenSubtitlesDownloadIntent('session-a', 'file-1', shared.options);
    const podTwo = await checkOpenSubtitlesDownloadIntent('session-a', 'file-2', shared.options);
    const otherSession = await checkOpenSubtitlesDownloadIntent('session-b', 'file-3', shared.options);

    assert.equal(podOne.allowed, true);
    assert.equal(podTwo.allowed, false);
    assert.equal(otherSession.allowed, true);
});

test('falls back to a bounded local window when Redis is unavailable', async () => {
    const options = {
        async evaluateRedis() {
            return null;
        },
        now: () => 1_000_000,
        windowMs: 15_000,
        repeatDelayMs: 1_000
    };

    const first = await checkOpenSubtitlesDownloadIntent('session-a', 'file-1', options);
    const second = await checkOpenSubtitlesDownloadIntent('session-a', 'file-2', options);

    assert.equal(first.allowed, true);
    assert.equal(second.allowed, false);
});

test('uses one atomic Redis script and no distributed lock composition', () => {
    const source = fs.readFileSync(path.join(__dirname, 'openSubtitlesDownloadGuard.js'), 'utf8');
    assert.match(source, /client\.eval\(/);
    assert.doesNotMatch(source, /tryAcquireLock|refreshLock|releaseLock|incrementCounter/);
});
