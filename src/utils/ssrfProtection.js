/**
 * URL Validation Utilities for SSRF Prevention
 * 
 * Prevents Server-Side Request Forgery (SSRF) attacks by validating URLs
 * and blocking requests to internal/private network addresses.
 * 
 * Security Model:
 * - Block private IPv4 ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
 * - Block loopback addresses (127.x.x.x, ::1)
 * - Block link-local addresses (169.254.x.x, fe80::)
 * - Block cloud metadata endpoints (AWS, GCP, Azure)
 * - Block localhost and reserved hostnames
 * - Only allow HTTP/HTTPS protocols
 */

const dns = require('dns');
const { promisify } = require('util');
const log = require('./logger');

const dnsLookup = promisify(dns.lookup);

// Private/internal IPv4 ranges (CIDR notation conceptually)
const PRIVATE_IPV4_RANGES = [
    // Loopback: 127.0.0.0/8
    { start: 0x7F000000, end: 0x7FFFFFFF },
    // Private: 10.0.0.0/8
    { start: 0x0A000000, end: 0x0AFFFFFF },
    // Private: 172.16.0.0/12
    { start: 0xAC100000, end: 0xAC1FFFFF },
    // Private: 192.168.0.0/16
    { start: 0xC0A80000, end: 0xC0A8FFFF },
    // Link-local: 169.254.0.0/16
    { start: 0xA9FE0000, end: 0xA9FEFFFF },
    // Current network: 0.0.0.0/8
    { start: 0x00000000, end: 0x00FFFFFF },
    // Broadcast: 255.255.255.255/32
    { start: 0xFFFFFFFF, end: 0xFFFFFFFF },
    // Shared address space: 100.64.0.0/10 (Carrier-grade NAT)
    { start: 0x64400000, end: 0x647FFFFF },
    // IETF Protocol Assignments: 192.0.0.0/24
    { start: 0xC0000000, end: 0xC00000FF },
    // Documentation: 192.0.2.0/24 (TEST-NET-1)
    { start: 0xC0000200, end: 0xC00002FF },
    // Documentation: 198.51.100.0/24 (TEST-NET-2)
    { start: 0xC6336400, end: 0xC63364FF },
    // Documentation: 203.0.113.0/24 (TEST-NET-3)
    { start: 0xCB007100, end: 0xCB0071FF },
];

// Cloud provider metadata endpoints (common SSRF targets)
const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata',
    'metadata.google.internal',
    'metadata.google.com',
    'instance-data',
    'kubernetes.default',
    'kubernetes.default.svc',
    'kubernetes.default.svc.cluster.local',
]);

// Cloud metadata IP addresses
const BLOCKED_IPS = new Set([
    // AWS/GCP/Azure metadata endpoint
    '169.254.169.254',
    // AWS ECS task metadata endpoint
    '169.254.170.2',
    // Azure Instance Metadata Service (IMDS) wireserver
    '168.63.129.16',
    // GCP metadata endpoint alias
    '169.254.169.253',
]);

// Allowed protocols
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const DEFAULT_DNS_TIMEOUT_MS = 5000;
const DEFAULT_MAX_DNS_RESULTS = 8;

/**
 * Parse an IPv4 address to a 32-bit integer
 * @param {string} ip - IPv4 address
 * @returns {number|null} 32-bit integer or null if invalid
 */
function ipv4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;

    let result = 0;
    for (let i = 0; i < 4; i++) {
        const octet = parseInt(parts[i], 10);
        if (isNaN(octet) || octet < 0 || octet > 255) return null;
        result = (result << 8) | octet;
    }
    return result >>> 0; // Convert to unsigned
}

/**
 * Check if an IPv4 address is in a private/internal range
 * @param {string} ip - IPv4 address
 * @returns {boolean} True if private/internal
 */
function isPrivateIPv4(ip) {
    const ipInt = ipv4ToInt(ip);
    if (ipInt === null) return false;

    for (const range of PRIVATE_IPV4_RANGES) {
        if (ipInt >= range.start && ipInt <= range.end) {
            return true;
        }
    }
    return false;
}

/**
 * Check if an IPv6 address is private/internal
 * @param {string} ip - IPv6 address
 * @returns {boolean} True if private/internal
 */
function isPrivateIPv6(ip) {
    const normalized = ip.toLowerCase();

    // Loopback
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
        return true;
    }

    // Link-local (fe80::/10)
    if (normalized.startsWith('fe80:') || normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') || normalized.startsWith('fea') ||
        normalized.startsWith('feb')) {
        return true;
    }

    // Unique local (fc00::/7)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
        return true;
    }

    // IPv4-mapped IPv6 (check the embedded IPv4)
    const ipv4MappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (ipv4MappedMatch) {
        return isPrivateIPv4(ipv4MappedMatch[1]);
    }

    // Unspecified address
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') {
        return true;
    }

    return false;
}

/**
 * Check if an IP address (IPv4 or IPv6) is private/internal
 * @param {string} ip - IP address
 * @returns {boolean} True if private/internal
 */
function isPrivateIP(ip) {
    if (!ip) return true; // No IP is suspicious

    const trimmed = ip.trim();

    // Check blocked IPs first
    if (BLOCKED_IPS.has(trimmed)) {
        return true;
    }

    // IPv4
    if (trimmed.includes('.') && !trimmed.includes(':')) {
        return isPrivateIPv4(trimmed);
    }

    // IPv6
    if (trimmed.includes(':')) {
        return isPrivateIPv6(trimmed);
    }

    return true; // Unknown format, block by default
}

/**
 * Check if a hostname is blocked
 * @param {string} hostname - Hostname to check
 * @returns {boolean} True if blocked
 */
function isBlockedHostname(hostname) {
    if (!hostname) return true;

    const normalized = hostname.toLowerCase().trim();

    // Check exact matches
    if (BLOCKED_HOSTNAMES.has(normalized)) {
        return true;
    }

    // Check if it looks like an IP address and is private
    if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
        return isPrivateIPv4(normalized);
    }

    // Check IPv6 in square brackets [::1]
    if (normalized.startsWith('[') && normalized.endsWith(']')) {
        const ipv6 = normalized.slice(1, -1);
        return isPrivateIPv6(ipv6);
    }

    // Check for localhost variations
    if (normalized.startsWith('localhost') || normalized.endsWith('.localhost')) {
        return true;
    }

    // Check for internal TLDs
    if (normalized.endsWith('.internal') || normalized.endsWith('.local') ||
        normalized.endsWith('.lan') || normalized.endsWith('.home') ||
        normalized.endsWith('.corp') || normalized.endsWith('.intranet')) {
        return true;
    }

    return false;
}

/**
 * Validate a URL for SSRF safety (synchronous check, hostname only)
 * @param {string} url - URL to validate
 * @returns {{ valid: boolean, reason?: string }} Validation result
 */
function validateUrlSync(url) {
    if (!url || typeof url !== 'string') {
        return { valid: false, reason: 'missing_url' };
    }

    let parsed;
    try {
        parsed = new URL(url.trim());
    } catch (e) {
        return { valid: false, reason: 'invalid_url' };
    }

    // Check protocol
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return { valid: false, reason: 'forbidden_protocol', protocol: parsed.protocol };
    }

    // Disallow credentials in URL (userinfo)
    if (parsed.username || parsed.password) {
        return { valid: false, reason: 'userinfo_not_allowed' };
    }

    // Check hostname
    const hostname = parsed.hostname;
    if (!hostname) {
        return { valid: false, reason: 'missing_hostname' };
    }

    if (isBlockedHostname(hostname)) {
        return { valid: false, reason: 'blocked_hostname', hostname };
    }

    // Check port (block common internal service ports)
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const portNum = parseInt(port, 10);
    const internalPorts = new Set([22, 23, 25, 135, 139, 445, 3306, 5432, 6379, 27017, 11211, 9200, 9300]);
    if (internalPorts.has(portNum)) {
        return { valid: false, reason: 'internal_port', port: portNum };
    }

    return { valid: true };
}

/**
 * Validate a URL for SSRF safety with DNS resolution
 * Resolves the hostname and checks that the resolved IP is not private/internal
 * @param {string} url - URL to validate
 * @param {Object} options - Options
 * @param {number} options.dnsTimeout - DNS lookup timeout in ms (default: 5000)
 * @returns {Promise<{ valid: boolean, reason?: string, resolvedIp?: string }>}
 */
async function validateUrl(url, options = {}) {
    // First, do synchronous validation
    const syncResult = validateUrlSync(url);
    if (!syncResult.valid) {
        return syncResult;
    }

    const parsed = new URL(url.trim());
    const hostname = parsed.hostname;
    const dnsTimeout = Number.isFinite(options.dnsTimeout) ? options.dnsTimeout : DEFAULT_DNS_TIMEOUT_MS;
    const allowDnsFailure = options.allowDnsFailure === true;
    const maxResults = Number.isFinite(options.maxResults) ? options.maxResults : DEFAULT_MAX_DNS_RESULTS;

    // If hostname is already an IP, check it directly
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
        if (isPrivateIP(hostname)) {
            return { valid: false, reason: 'private_ip', resolvedIp: hostname };
        }
        return { valid: true, resolvedIp: hostname };
    }

    // Check IPv6 literal
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        const ipv6 = hostname.slice(1, -1);
        if (isPrivateIPv6(ipv6)) {
            return { valid: false, reason: 'private_ip', resolvedIp: ipv6 };
        }
        return { valid: true, resolvedIp: ipv6 };
    }

    // Resolve hostname to IP
    try {
        const lookupPromise = dnsLookup(hostname, { all: true });
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('DNS timeout')), dnsTimeout)
        );

        const results = await Promise.race([lookupPromise, timeoutPromise]);
        const limited = Array.isArray(results) ? results.slice(0, maxResults) : [];
        if (!limited.length) {
            return allowDnsFailure
                ? { valid: true, resolvedIp: null }
                : { valid: false, reason: 'dns_no_records' };
        }

        for (const record of limited) {
            const resolvedIp = record?.address;
            if (isPrivateIP(resolvedIp)) {
                log.warn(() => `[SSRF] Blocked request to ${hostname} - resolved to private IP ${resolvedIp}`);
                return { valid: false, reason: 'private_ip', resolvedIp };
            }
        }

        return { valid: true, resolvedIp: limited[0]?.address || null };
    } catch (error) {
        // DNS resolution failed - could be legitimate or could be DNS rebinding attempt
        log.debug(() => `[SSRF] DNS lookup failed for ${hostname}: ${error.message}`);
        return allowDnsFailure
            ? { valid: true, resolvedIp: null }
            : { valid: false, reason: 'dns_lookup_failed' };
    }
}

/**
 * Express middleware to validate streamUrl in request body
 * @param {Object} options - Options
 * @param {string} options.field - Request body field containing URL (default: 'streamUrl')
 * @param {boolean} options.resolveDns - Whether to resolve DNS (default: true)
 * @returns {Function} Express middleware
 */
function ssrfProtection(options = {}) {
    const { field = 'streamUrl', resolveDns = true, allowDnsFailure = false } = options;

    return async (req, res, next) => {
        const url = req.body?.[field];

        // Skip if no URL provided (let the route handler deal with missing params)
        if (!url) {
            return next();
        }

        try {
            const result = resolveDns
                ? await validateUrl(url, { allowDnsFailure })
                : validateUrlSync(url);

            if (!result.valid) {
                log.warn(() => `[SSRF] Blocked request to ${url}: ${result.reason}`);

                const t = res.locals?.t || ((key, vars, fallback) => fallback || key);
                return res.status(403).json({
                    error: t('server.errors.blockedUrl', {}, 'The provided URL is not allowed'),
                    reason: result.reason,
                    hint: t('server.errors.blockedUrlHint', {}, 'Only public HTTP/HTTPS URLs are allowed')
                });
            }

            // Attach resolved IP to request for logging
            if (result.resolvedIp) {
                req.resolvedStreamIp = result.resolvedIp;
            }

            next();
        } catch (error) {
            log.error(() => `[SSRF] Validation error for ${url}: ${error.message}`);
            next(); // On error, allow the request (fail open for availability)
        }
    };
}

/**
 * Validate a URL before making a fetch request (for use in code, not as middleware)
 * @param {string} url - URL to fetch
 * @param {Object} options - Options
 * @param {boolean} options.resolveDns - Whether to resolve DNS (default: true)
 * @throws {Error} If URL is blocked
 */
async function assertSafeUrl(url, options = {}) {
    const { resolveDns = true, allowDnsFailure = false } = options;

    const result = resolveDns
        ? await validateUrl(url, { allowDnsFailure })
        : validateUrlSync(url);

    if (!result.valid) {
        const error = new Error(`Blocked request to internal/private URL: ${result.reason}`);
        error.code = 'SSRF_BLOCKED';
        error.reason = result.reason;
        error.url = url;
        throw error;
    }

    return result;
}

module.exports = {
    validateUrl,
    validateUrlSync,
    isPrivateIP,
    isPrivateIPv4,
    isPrivateIPv6,
    isBlockedHostname,
    ssrfProtection,
    assertSafeUrl,
    BLOCKED_HOSTNAMES,
    BLOCKED_IPS
};
