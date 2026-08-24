const crypto = require('node:crypto');

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CAPABILITY_PATTERN = /^[A-Fa-f0-9]{32,128}$/;

function asPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeJobId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return JOB_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeCapability(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return CAPABILITY_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

function hashCapability(value) {
  return crypto.createHash('sha256').update(value).digest();
}

class AutoSubLogRegistry {
  constructor(options = {}) {
    this.ttlMs = asPositiveInteger(options.ttlMs, 10 * 60 * 1000);
    this.doneTtlMs = asPositiveInteger(options.doneTtlMs, 2 * 60 * 1000);
    this.maxChannels = asPositiveInteger(options.maxChannels, 500);
    this.maxChannelsPerOwner = asPositiveInteger(options.maxChannelsPerOwner, 12);
    this.maxListeners = asPositiveInteger(options.maxListeners, 200);
    this.maxListenersPerOwner = asPositiveInteger(options.maxListenersPerOwner, 6);
    this.maxListenersPerChannel = asPositiveInteger(options.maxListenersPerChannel, 2);
    this.maxEntries = asPositiveInteger(options.maxEntries, 250);

    this.channels = new Map();
    this.channelCountsByOwner = new Map();
    this.listenerCountsByOwner = new Map();
    this.listenerOwners = new WeakMap();
    this.listenerCount = 0;
  }

  reserve(jobId, capability, ownerKey, now = Date.now()) {
    const id = normalizeJobId(jobId);
    const normalizedCapability = normalizeCapability(capability);
    const normalizedOwner = String(ownerKey || 'unknown');
    if (!id || !normalizedCapability) {
      return { ok: false, reason: 'invalid' };
    }

    const existing = this.channels.get(id);
    if (existing && existing.expiresAt <= now) {
      this.remove(id);
    } else if (existing) {
      return { ok: false, reason: 'exists' };
    }

    if (this.channels.size >= this.maxChannels) {
      return { ok: false, reason: 'global-capacity' };
    }
    if ((this.channelCountsByOwner.get(normalizedOwner) || 0) >= this.maxChannelsPerOwner) {
      return { ok: false, reason: 'owner-capacity' };
    }

    const channel = {
      id,
      capabilityHash: hashCapability(normalizedCapability),
      ownerKey: normalizedOwner,
      logs: [],
      listeners: new Set(),
      done: false,
      createdAt: now,
      expiresAt: now + this.ttlMs
    };
    this.channels.set(id, channel);
    this._increment(this.channelCountsByOwner, normalizedOwner);
    return { ok: true, channel };
  }

  lookup(jobId, capability, now = Date.now()) {
    const id = normalizeJobId(jobId);
    const normalizedCapability = normalizeCapability(capability);
    if (!id || !normalizedCapability) return null;

    const channel = this.channels.get(id);
    if (!channel) return null;
    if (channel.expiresAt <= now) {
      this.remove(id);
      return null;
    }

    const candidateHash = hashCapability(normalizedCapability);
    return crypto.timingSafeEqual(channel.capabilityHash, candidateHash) ? channel : null;
  }

  append(jobId, entry, now = Date.now()) {
    const id = normalizeJobId(jobId);
    const channel = id ? this.channels.get(id) : null;
    if (!channel || !entry || !entry.message) return false;

    channel.logs.push(entry);
    if (channel.logs.length > this.maxEntries) {
      channel.logs.splice(0, channel.logs.length - this.maxEntries);
    }
    channel.expiresAt = now + this.ttlMs;

    for (const listener of Array.from(channel.listeners)) {
      try {
        if (listener.sendEntry(entry) === false) {
          this.detach(channel, listener, true);
        }
      } catch (_) {
        this.detach(channel, listener, true);
      }
    }
    return true;
  }

  finalize(jobId, logTrail = [], now = Date.now()) {
    const id = normalizeJobId(jobId);
    const channel = id ? this.channels.get(id) : null;
    if (!channel) return false;

    if (Array.isArray(logTrail) && logTrail.length) {
      channel.logs = logTrail.slice(-this.maxEntries);
    }
    channel.done = true;
    channel.expiresAt = now + this.doneTtlMs;

    for (const listener of Array.from(channel.listeners)) {
      try {
        listener.sendDone();
      } catch (_) {
        // The listener is closed below even when its final write fails.
      }
      this.detach(channel, listener, true);
    }
    return true;
  }

  attach(channel, ownerKey, listener) {
    if (!channel || this.channels.get(channel.id) !== channel || !listener) {
      return { ok: false, reason: 'unknown' };
    }
    const normalizedOwner = String(ownerKey || 'unknown');
    if (channel.listeners.size >= this.maxListenersPerChannel) {
      return { ok: false, reason: 'channel-capacity' };
    }
    if (this.listenerCount >= this.maxListeners) {
      return { ok: false, reason: 'global-capacity' };
    }
    if ((this.listenerCountsByOwner.get(normalizedOwner) || 0) >= this.maxListenersPerOwner) {
      return { ok: false, reason: 'owner-capacity' };
    }

    channel.listeners.add(listener);
    this.listenerOwners.set(listener, normalizedOwner);
    this.listenerCount += 1;
    this._increment(this.listenerCountsByOwner, normalizedOwner);
    return { ok: true };
  }

  detach(channel, listener, close = false) {
    if (!channel?.listeners?.delete(listener)) return false;

    const ownerKey = this.listenerOwners.get(listener);
    this.listenerOwners.delete(listener);
    this.listenerCount = Math.max(0, this.listenerCount - 1);
    this._decrement(this.listenerCountsByOwner, ownerKey);

    if (close) {
      try {
        listener.close();
      } catch (_) {
        // Ignore cleanup failures from an already-closed response.
      }
    }
    return true;
  }

  remove(jobId) {
    const id = normalizeJobId(jobId);
    const channel = id ? this.channels.get(id) : null;
    if (!channel) return false;

    this.channels.delete(id);
    this._decrement(this.channelCountsByOwner, channel.ownerKey);
    for (const listener of Array.from(channel.listeners)) {
      this.detach(channel, listener, true);
    }
    return true;
  }

  sweep(now = Date.now()) {
    let removed = 0;
    for (const [jobId, channel] of this.channels.entries()) {
      if (!channel || channel.expiresAt <= now) {
        if (this.remove(jobId)) removed += 1;
      }
    }
    return removed;
  }

  entriesSince(channel, since) {
    if (!channel || !Array.isArray(channel.logs)) return [];
    const sinceTs = Number(since);
    return channel.logs.filter((entry) => {
      if (!Number.isFinite(sinceTs)) return true;
      const ts = Number(entry?.ts);
      return Number.isFinite(ts) && ts > sinceTs;
    }).slice(-this.maxEntries);
  }

  get size() {
    return this.channels.size;
  }

  _increment(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  _decrement(map, key) {
    if (!key) return;
    const next = (map.get(key) || 0) - 1;
    if (next > 0) map.set(key, next);
    else map.delete(key);
  }
}

module.exports = {
  AutoSubLogRegistry,
  normalizeJobId,
  normalizeCapability
};
