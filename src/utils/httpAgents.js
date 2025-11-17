/**
 * Shared HTTP/HTTPS Connection Pooling Configuration
 *
 * This module provides reusable HTTP agents with connection pooling enabled
 * to significantly reduce latency overhead for external API calls.
 *
 * Benefits:
 * - Reuses TCP connections instead of creating new ones for every request
 * - Reduces latency by 150-500ms per API call (TCP + TLS handshake savings)
 * - Prevents socket exhaustion under high load
 * - Improves scalability for 100+ concurrent users
 *
 * Usage:
 *   const { httpAgent, httpsAgent } = require('./utils/httpAgents');
 *
 *   axios.create({
 *     httpAgent,
 *     httpsAgent,
 *     // ... other config
 *   });
 */

const http = require('http');
const https = require('https');
// Handle ESM (v7+) and CJS (v6) exports of cacheable-lookup
let CacheableLookup = require('cacheable-lookup');
CacheableLookup = (CacheableLookup && (CacheableLookup.default || CacheableLookup.CacheableLookup)) || CacheableLookup;
const log = require('./logger');

/**
 * HTTP Agent with connection pooling
 * Reuses connections for http:// URLs
 */
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,       // Max 100 concurrent connections per host
  maxFreeSockets: 20,    // Keep 20 idle connections ready for reuse
  timeout: 60000,        // 60 second socket timeout
  keepAliveMsecs: 30000  // Send keepalive probes every 30s (TCP keep-alive interval)
});

/**
 * HTTPS Agent with connection pooling
 * Reuses connections for https:// URLs
 */
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,       // Max 100 concurrent connections per host
  maxFreeSockets: 20,    // Keep 20 idle connections ready for reuse
  timeout: 60000,        // 60 second socket timeout
  keepAliveMsecs: 30000  // Send keepalive probes every 30s (TLS over TCP)
});

// DNS cache to reduce lookup latency and flakiness
const dnsCache = new CacheableLookup({
  maxTtl: 60,      // seconds to keep successful lookups
  errorTtl: 0,     // don't cache failed lookups
  cache: new Map() // in-memory cache
});

log.debug(() => '[HTTP Agents] Connection pooling initialized: maxSockets=100, maxFreeSockets=20, keepAlive=true');

module.exports = {
  httpAgent,
  httpsAgent,
  // Expose lookup so callers can pass it in request options
  dnsLookup: dnsCache.lookup.bind(dnsCache)
};
