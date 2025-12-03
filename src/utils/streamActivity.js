const { LRUCache } = require('lru-cache');
const log = require('./logger');

// Tracks the most recent stream per config hash (in-memory only)
const latestByConfig = new LRUCache({
  max: parseInt(process.env.STREAM_ACTIVITY_MAX || '5000', 10),
  // Default: keep recent items for 6h to avoid unbounded growth for many unique configs
  ttl: parseInt(process.env.STREAM_ACTIVITY_TTL_MS || `${6 * 60 * 60 * 1000}`, 10),
  updateAgeOnGet: true
});

// Heartbeat cadence (default 40s to keep SSE warm)
const HEARTBEAT_MS = parseInt(process.env.STREAM_ACTIVITY_HEARTBEAT_MS || `${40 * 1000}`, 10);
// Allow long-lived connections to avoid churn/reconnect storms
const MAX_CONNECTION_AGE_MS = parseInt(process.env.STREAM_ACTIVITY_MAX_CONN_AGE_MS || `${60 * 60 * 1000}`, 10);
const MAX_LISTENERS_PER_CONFIG = parseInt(process.env.STREAM_ACTIVITY_MAX_LISTENERS_PER_CONFIG || '100', 10);
// Log a single heartbeat summary every 5 minutes regardless of cadence
const HEARTBEAT_LOG_INTERVAL_MS = parseInt(process.env.STREAM_ACTIVITY_HEARTBEAT_LOG_INTERVAL_MS || `${5 * 60 * 1000}`, 10);

// Active SSE listeners keyed by config hash -> Set<{res, createdAt, lastEventAt}>
const listeners = new Map();
let heartbeatLogWindowStart = Date.now();
let heartbeatPingEvents = 0;
let heartbeatListenerSamples = 0;
let heartbeatSampleCount = 0;

function cleanupListener(configHash, listener, reason = 'unknown') {
  const set = listeners.get(configHash);
  if (!set || !listener) return;
  if (!set.has(listener)) return;

  set.delete(listener);
  try { listener.res.end(); } catch (_) {}

  if (set.size === 0) listeners.delete(configHash);
  const shortHash = (configHash || '').slice(0, 8);
  log.debug(() => `[StreamActivity] SSE disconnected for ${shortHash} (remaining=${listeners.get(configHash)?.size || 0}, reason=${reason})`);
}

function sendEvent(configHash, listener, event, data) {
  if (!listener?.res) return;
  if (listener.res.writableEnded || listener.res.destroyed) {
    cleanupListener(configHash, listener, 'writable_ended');
    return;
  }

  try {
    listener.res.write(`event: ${event}\n`);
    listener.res.write(`data: ${JSON.stringify(data)}\n\n`);
    listener.lastEventAt = Date.now();
  } catch (e) {
    // If the write fails, clean up the listener to prevent leaks
    log.debug(() => [`[StreamActivity] Failed to send event`, e.message]);
    cleanupListener(configHash, listener, 'write_failed');
  }
}

/**
 * Record latest stream info for a config hash and notify listeners
 * @param {Object} payload
 * @param {string} payload.configHash
 * @param {string} payload.videoId
 * @param {string} [payload.filename]
 * @param {string} [payload.videoHash]
 */
function recordStreamActivity(payload) {
  if (!payload || typeof payload.configHash !== 'string' || !payload.configHash.length) return;

  const previous = latestByConfig.get(payload.configHash);
  const entry = {
    videoId: payload.videoId || '',
    filename: payload.filename || '',
    videoHash: payload.videoHash || '',
    updatedAt: Date.now()
  };

  const changed = !previous ||
    previous.videoId !== entry.videoId ||
    previous.filename !== entry.filename ||
    previous.videoHash !== entry.videoHash;

  latestByConfig.set(payload.configHash, entry);

  if (changed) {
    const shortHash = payload.configHash.slice(0, 8);
    log.info(() => `[StreamActivity] New stream ping for ${shortHash} -> videoId=${entry.videoId || 'n/a'}, filename=${entry.filename || 'n/a'}, hash=${entry.videoHash || 'n/a'}`);

    const set = listeners.get(payload.configHash);
    if (set && set.size) {
      for (const listener of set) {
        sendEvent(payload.configHash, listener, 'episode', entry);
      }
    }
  } else {
    log.debug(() => `[StreamActivity] Refreshed activity for existing stream ${payload.configHash.slice(0, 8)}`);
  }
}

/**
 * Get latest stream activity for a config hash
 * @param {string} configHash
 */
function getLatestStreamActivity(configHash) {
  if (!configHash) return null;
  return latestByConfig.get(configHash) || null;
}

/**
 * Subscribe an Express response to SSE for a config hash
 * @param {string} configHash
 * @param {object} res Express response
 */
function subscribe(configHash, res) {
  if (!configHash || !res) return () => {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Content-Encoding', 'identity'); // Explicitly disable compression for SSE
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for SSE
  res.flushHeaders?.();

  // Hint client-side reconnection interval to avoid tight retry loops if upstream drops the socket
  try { res.write(`retry: 5000\n\n`); } catch (_) {}

  // Immediate ack + latest snapshot so the client knows current state
  const listener = { res, createdAt: Date.now(), lastEventAt: Date.now() };
  sendEvent(configHash, listener, 'ready', { ok: true, ts: Date.now() });
  const latest = getLatestStreamActivity(configHash);
  if (latest) {
    sendEvent(configHash, listener, 'episode', latest);
  }

  let set = listeners.get(configHash);
  if (!set) {
    set = new Set();
    listeners.set(configHash, set);
  }

  // Enforce per-config listener cap to prevent runaway reconnect loops
  if (set.size >= MAX_LISTENERS_PER_CONFIG) {
    const oldest = set.values().next().value;
    if (oldest) {
      cleanupListener(configHash, oldest, 'max_listeners_evicted');
    }
  }

  set.add(listener);

  const shortHash = (configHash || '').slice(0, 8);
  log.debug(() => `[StreamActivity] SSE subscribed for ${shortHash} (listeners=${set.size})`);

  let cleaned = false;
  const cleanup = (reason = 'client_closed') => {
    if (cleaned) return;
    cleaned = true;
    cleanupListener(configHash, listener, reason);
  };

  res.on('close', () => cleanup('res_close'));
  res.on('finish', () => cleanup('res_finish'));
  res.on('error', () => cleanup('res_error'));
  res.req?.on?.('aborted', () => cleanup('req_aborted'));
  return cleanup;
}

// Shared heartbeat to keep connections alive and prune stale ones
setInterval(() => {
  const now = Date.now();
  let listenersSeenThisTick = 0;
  for (const [configHash, set] of listeners.entries()) {
    listenersSeenThisTick += set?.size || 0;
    for (const listener of [...set]) {
      if (!listener?.res) {
        cleanupListener(configHash, listener, 'missing_res');
        continue;
      }
      if (listener.res.writableEnded || listener.res.destroyed) {
        cleanupListener(configHash, listener, 'writable_ended');
        continue;
      }
      if (now - listener.createdAt > MAX_CONNECTION_AGE_MS) {
        cleanupListener(configHash, listener, 'max_age');
        continue;
      }
      sendEvent(configHash, listener, 'ping', { ts: now });
    }
  }
  heartbeatPingEvents += listenersSeenThisTick;
  heartbeatListenerSamples += listenersSeenThisTick;
  heartbeatSampleCount += 1;

  if (now - heartbeatLogWindowStart >= HEARTBEAT_LOG_INTERVAL_MS) {
    const avgListeners = heartbeatSampleCount ? Math.round(heartbeatListenerSamples / heartbeatSampleCount) : 0;
    log.debug(() => `[StreamActivity] Heartbeat summary: intervalMs=${HEARTBEAT_MS}, configs=${listeners.size}, listenersNow=${listenersSeenThisTick}, avgListeners=${avgListeners}, pingsSent=${heartbeatPingEvents}`);
    heartbeatLogWindowStart = now;
    heartbeatPingEvents = 0;
    heartbeatListenerSamples = 0;
    heartbeatSampleCount = 0;
  }
}, HEARTBEAT_MS).unref();

module.exports = {
  recordStreamActivity,
  getLatestStreamActivity,
  subscribe
};
