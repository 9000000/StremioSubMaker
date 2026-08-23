'use strict';

const crypto = require('crypto');
const { LRUCache } = require('lru-cache');
const { getStorageAdapter } = require('./sharedCache');
const { StorageAdapter } = require('../storage');
const log = require('./logger');

const DEFAULT_WINDOW_MS = 15_000;
const DEFAULT_REPEAT_DELAY_MS = 1_000;

// Atomic single-key Redis script. It avoids composing separate distributed
// locks and counters, and the hash tag keeps the key stable on Redis Cluster.
const CHECK_INTENT_SCRIPT = `
local previous = redis.call('HGET', KEYS[1], ARGV[1])
local now = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local repeatDelay = tonumber(ARGV[4])

if previous then
  local elapsed = math.max(0, now - tonumber(previous))
  redis.call('PEXPIRE', KEYS[1], window)
  if elapsed >= repeatDelay then
    return {2, elapsed, redis.call('HLEN', KEYS[1])}
  end
  return {0, elapsed, redis.call('HLEN', KEYS[1])}
end

local count = redis.call('HLEN', KEYS[1])
redis.call('HSET', KEYS[1], ARGV[1], now)
redis.call('PEXPIRE', KEYS[1], window)
if count == 0 then
  return {1, 0, 1}
end
return {0, 0, count + 1}
`;

const localWindows = new LRUCache({
    max: 10_000,
    ttl: 60_000,
    updateAgeOnGet: false
});

function positiveInt(value, fallback, minimum = 1) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function hashValue(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

function evaluateLocal(configHash, fileHash, now, windowMs, repeatDelayMs) {
    const existing = localWindows.get(configHash);
    const entry = existing && existing.expiresAt > now
        ? existing
        : { files: new Map(), expiresAt: now + windowMs };
    const previous = entry.files.get(fileHash);
    entry.expiresAt = now + windowMs;

    if (previous !== undefined) {
        const elapsedMs = Math.max(0, now - previous);
        localWindows.set(configHash, entry, { ttl: windowMs });
        return {
            allowed: elapsedMs >= repeatDelayMs,
            reason: elapsedMs >= repeatDelayMs ? 'repeated-selection' : 'duplicate-prefetch',
            repeated: true,
            count: entry.files.size,
            retryAfterMs: Math.max(0, repeatDelayMs - elapsedMs)
        };
    }

    entry.files.set(fileHash, now);
    localWindows.set(configHash, entry, { ttl: windowMs });
    return {
        allowed: entry.files.size === 1,
        reason: entry.files.size === 1 ? 'first-request' : 'distinct-file-prefetch',
        repeated: false,
        count: entry.files.size,
        retryAfterMs: entry.files.size === 1 ? 0 : repeatDelayMs
    };
}

async function evaluateRedis(configHash, fileHash, now, windowMs, repeatDelayMs) {
    try {
        const adapter = await getStorageAdapter();
        if (!adapter?.client || typeof adapter._getKey !== 'function') return null;

        const logicalKey = `opensubtitles:download-intent:{${configHash}}`;
        const fullKey = adapter._getKey(logicalKey, StorageAdapter.CACHE_TYPES.SESSION);
        const result = await adapter.client.eval(
            CHECK_INTENT_SCRIPT,
            1,
            fullKey,
            fileHash,
            now,
            windowMs,
            repeatDelayMs
        );
        if (!Array.isArray(result) || result.length < 3) return null;

        const decision = Number(result[0]);
        const elapsedMs = Math.max(0, Number(result[1]) || 0);
        const count = Math.max(0, Number(result[2]) || 0);
        return {
            allowed: decision === 1 || decision === 2,
            reason: decision === 1
                ? 'first-request'
                : decision === 2 ? 'repeated-selection' : (elapsedMs > 0 ? 'duplicate-prefetch' : 'distinct-file-prefetch'),
            repeated: elapsedMs > 0 || decision === 2,
            count,
            retryAfterMs: decision === 0 ? Math.max(0, repeatDelayMs - elapsedMs) : 0
        };
    } catch (error) {
        log.debug(() => `[OpenSubtitles Guard] Redis intent check unavailable; using local fallback: ${error.message}`);
        return null;
    }
}

/**
 * Protect an authenticated OpenSubtitles account from speculative URL probes.
 * One atomic Redis hash operation makes the decision across all replicas; no
 * distributed lock ownership, refresh, release, or multi-command race exists.
 */
async function checkOpenSubtitlesDownloadIntent(configKey, fileId, options = {}) {
    if (!configKey || !fileId) {
        return { allowed: true, reason: 'missing-key' };
    }

    const windowMs = positiveInt(
        options.windowMs ?? process.env.OPENSUBTITLES_PREFETCH_WINDOW_MS,
        DEFAULT_WINDOW_MS,
        1_000
    );
    const repeatDelayMs = Math.min(windowMs - 1, positiveInt(
        options.repeatDelayMs ?? process.env.OPENSUBTITLES_PREFETCH_REPEAT_DELAY_MS,
        DEFAULT_REPEAT_DELAY_MS,
        0
    ));
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const configHash = hashValue(configKey);
    const fileHash = hashValue(fileId);
    const distributedEvaluator = options.evaluateRedis || evaluateRedis;

    const distributed = await distributedEvaluator(configHash, fileHash, now, windowMs, repeatDelayMs);
    if (distributed) return distributed;
    return evaluateLocal(configHash, fileHash, now, windowMs, repeatDelayMs);
}

function resetOpenSubtitlesDownloadGuardForTests() {
    localWindows.clear();
}

module.exports = {
    checkOpenSubtitlesDownloadIntent,
    resetOpenSubtitlesDownloadGuardForTests,
    __testing: { CHECK_INTENT_SCRIPT, evaluateLocal }
};
