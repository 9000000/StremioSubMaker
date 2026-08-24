'use strict';

class OutboundConcurrencyLimitError extends Error {
  constructor(scope) {
    super(scope === 'host'
      ? 'Too many requests are already in progress for this endpoint'
      : 'Too many custom endpoint requests are already in progress');
    this.name = 'OutboundConcurrencyLimitError';
    this.code = 'EOUTBOUND_CONCURRENCY';
    this.scope = scope;
    this.statusCode = 429;
  }
}

class OutboundConcurrencyLimiter {
  constructor(options = {}) {
    this.maxGlobal = Math.max(1, Number.parseInt(options.maxGlobal, 10) || 20);
    this.maxPerHost = Math.max(1, Number.parseInt(options.maxPerHost, 10) || 4);
    this.activeGlobal = 0;
    this.activeByHost = new Map();
  }

  getHostKey(rawUrl) {
    const parsed = new URL(String(rawUrl || ''));
    return parsed.hostname.toLowerCase();
  }

  acquire(rawUrl) {
    const hostKey = this.getHostKey(rawUrl);
    if (this.activeGlobal >= this.maxGlobal) {
      throw new OutboundConcurrencyLimitError('global');
    }

    const activeForHost = this.activeByHost.get(hostKey) || 0;
    if (activeForHost >= this.maxPerHost) {
      throw new OutboundConcurrencyLimitError('host');
    }

    this.activeGlobal += 1;
    this.activeByHost.set(hostKey, activeForHost + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      const remainingForHost = (this.activeByHost.get(hostKey) || 1) - 1;
      if (remainingForHost > 0) {
        this.activeByHost.set(hostKey, remainingForHost);
      } else {
        this.activeByHost.delete(hostKey);
      }
    };
  }

  async run(rawUrl, operation) {
    const release = this.acquire(rawUrl);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  getStats() {
    return {
      activeGlobal: this.activeGlobal,
      activeHosts: this.activeByHost.size,
      maxGlobal: this.maxGlobal,
      maxPerHost: this.maxPerHost
    };
  }
}

module.exports = {
  OutboundConcurrencyLimiter,
  OutboundConcurrencyLimitError
};
