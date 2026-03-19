const https = require('https');

// Chrome-like cipher suite ordering for TLS fingerprint compatibility
// Cloudflare uses JA3 fingerprinting to detect automated clients.
const CHROME_CIPHERS = [
  // TLS 1.3 ciphers (highest priority, same order as Chrome)
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  // TLS 1.2 ECDHE ciphers (Chrome order)
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  // Fallback ciphers
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA'
].join(':');

// Custom HTTPS agent for SCS with Chrome-like TLS fingerprint
// SSL alert 49 (access denied) occurs when Cloudflare's JA3 fingerprinting detects Node.js.
const scsHttpsAgent = new https.Agent({
  keepAlive: true,           // Reuse connections for performance
  timeout: 35000,            // 35 second socket timeout (30s axios max + buffer)
  freeSocketTimeout: 15000,  // Close idle sockets after 15s to prevent stale connection issues
  maxSockets: 10,            // Limit concurrent connections per host
  maxFreeSockets: 2,         // Keep only 2 idle sockets
  // TLS configuration to mimic Chrome's TLS fingerprint
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3',
  ciphers: CHROME_CIPHERS,
  // Force HTTP/1.1 ONLY - prevents HPE_INVALID_CONSTANT from HTTP/2 frame confusion
  ALPNProtocols: ['http/1.1'],
  // Curve preferences like Chrome
  ecdhCurve: 'X25519:P-256:P-384',
  rejectUnauthorized: true,
  honorCipherOrder: false // Let server choose (matches browser behavior)
});

module.exports = {
  CHROME_CIPHERS,
  scsHttpsAgent
};
