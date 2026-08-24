/**
 * SSRF (Server-Side Request Forgery) protection for caller-controlled URLs.
 *
 * Internal endpoints are denied by default. Self-hosters can explicitly opt in
 * with ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true. URL structure and protocol checks
 * remain enforced even when that escape hatch is enabled.
 */

const dns = require('node:dns');
const ipaddr = require('ipaddr.js');
const log = require('./logger');

const INTERNAL_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'local'
]);

// ipaddr.js classifies most special-purpose space for us. Keep explicit checks
// for ranges whose treatment has varied across library/IANA revisions.
const ALWAYS_NON_GLOBAL_IPV6_CIDRS = [
    ipaddr.parseCIDR('100::/64') // Discard-only address block (RFC 6666)
];

function areInternalEndpointsAllowed() {
    return process.env.ALLOW_INTERNAL_CUSTOM_ENDPOINTS === 'true';
}

function stripIpv6Brackets(value) {
    const text = String(value || '').trim();
    if (text.startsWith('[') && text.endsWith(']')) {
        return text.slice(1, -1);
    }
    return text;
}

/**
 * Parse and canonicalize an IP literal. IPv6 scope identifiers are removed
 * only for classification; scoped addresses are non-global and are blocked.
 *
 * @param {string} value
 * @returns {import('ipaddr.js').IPv4|import('ipaddr.js').IPv6|null}
 */
function parseIpLiteral(value) {
    let candidate = stripIpv6Brackets(value);
    const scopeIndex = candidate.indexOf('%');
    if (scopeIndex !== -1 && candidate.includes(':')) {
        candidate = candidate.slice(0, scopeIndex);
    }

    if (!candidate || !ipaddr.isValid(candidate)) {
        return null;
    }

    try {
        return ipaddr.parse(candidate);
    } catch (_) {
        return null;
    }
}

/**
 * Return true unless an IP is ordinary global-unicast space. IPv4-mapped IPv6
 * is decoded before classification so hexadecimal forms such as
 * ::ffff:7f00:1 cannot hide loopback or link-local IPv4 addresses.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isInternalIp(ip) {
    const parsed = parseIpLiteral(ip);
    if (!parsed) {
        return true; // Resolvers should only return valid IPs; fail closed.
    }

    if (parsed.kind() === 'ipv6') {
        if (parsed.isIPv4MappedAddress()) {
            return isInternalIp(parsed.toIPv4Address().toString());
        }

        if (ALWAYS_NON_GLOBAL_IPV6_CIDRS.some(cidr => parsed.match(cidr))) {
            return true;
        }
    }

    return parsed.range() !== 'unicast';
}

function normalizeHostname(host) {
    return stripIpv6Brackets(host).toLowerCase().replace(/\.+$/, '');
}

/**
 * Check a hostname or IP literal for an immediately recognizable internal or
 * non-global destination. DNS names receive a second check after resolution.
 *
 * @param {string} host
 * @returns {boolean}
 */
function isInternalHost(host) {
    if (!host) return true;

    const normalized = normalizeHostname(host);
    if (!normalized) return true;

    const parsedIp = parseIpLiteral(normalized);
    if (parsedIp) {
        return isInternalIp(normalized);
    }

    // A colon in a URL hostname denotes an IPv6 literal. If it did not parse,
    // treat it as unsafe rather than passing malformed input to DNS.
    if (normalized.includes(':')) {
        return true;
    }

    if (INTERNAL_HOSTNAMES.has(normalized)) {
        return true;
    }

    return normalized.endsWith('.local') ||
        normalized.endsWith('.internal') ||
        normalized.endsWith('.localhost');
}

function createSsrfError(message, code = 'ESSRF_UNSAFE_URL') {
    const error = new Error(`[SSRF] ${message}`);
    error.code = code;
    return error;
}

function shouldAllowInternal(options = {}) {
    if (typeof options.allowInternal === 'boolean') {
        return options.allowInternal;
    }
    return areInternalEndpointsAllowed();
}

/**
 * Perform URL checks that do not require DNS. This is used both before each
 * custom-provider request and for every redirect destination.
 *
 * @param {string} rawUrl
 * @returns {URL}
 */
function assertSafeRequestUrl(rawUrl, options = {}) {
    const context = options.context || 'request';
    const allowedProtocols = Array.isArray(options.allowedProtocols) && options.allowedProtocols.length > 0
        ? options.allowedProtocols
        : ['http:', 'https:'];
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (_) {
        throw createSsrfError(`Invalid ${context} URL`);
    }

    if (!allowedProtocols.includes(parsed.protocol)) {
        throw createSsrfError(`Protocol ${parsed.protocol} is not allowed`);
    }

    if (parsed.username || parsed.password) {
        throw createSsrfError('URL credentials are not allowed');
    }

    if (parsed.hash) {
        throw createSsrfError('URL fragments are not allowed');
    }

    if (!shouldAllowInternal(options) && isInternalHost(parsed.hostname)) {
        throw createSsrfError(
            `Destination ${parsed.hostname} is internal or non-global`,
            'ESSRF_INTERNAL_IP'
        );
    }

    return parsed;
}

function assertSafeCustomRequestUrl(rawUrl) {
    return assertSafeRequestUrl(rawUrl, { context: 'custom provider' });
}

function assertSafePublicRequestUrl(rawUrl, options = {}) {
    return assertSafeRequestUrl(rawUrl, {
        ...options,
        context: options.context || 'public remote',
        allowInternal: false
    });
}

/**
 * Resolve a hostname using the same OS lookup path used for connections and
 * reject it if any returned address is not global unicast.
 *
 * @param {string} hostname
 * @returns {Promise<{safe: boolean, resolvedIps?: string[], error?: string}>}
 */
function resolveAndValidateHost(hostname) {
    const normalized = normalizeHostname(hostname);
    const literal = parseIpLiteral(normalized);

    if (literal) {
        const internal = isInternalIp(normalized);
        return Promise.resolve({
            safe: !internal,
            resolvedIps: [literal.toString()],
            error: internal ? `IP ${normalized} is internal or non-global` : undefined
        });
    }

    if (!normalized || normalized.includes(':')) {
        return Promise.resolve({
            safe: false,
            resolvedIps: [],
            error: `Invalid hostname or IP literal: ${hostname}`
        });
    }

    return new Promise((resolve) => {
        dns.lookup(normalized, { all: true, verbatim: true }, (error, addresses) => {
            if (error || !Array.isArray(addresses) || addresses.length === 0) {
                const dnsError = error?.message || 'no addresses returned';
                log.warn(() => `[SSRF] DNS resolution failed for ${normalized}: ${dnsError}`);
                return resolve({
                    safe: false,
                    resolvedIps: [],
                    error: `DNS resolution failed for ${normalized}: ${dnsError}`
                });
            }

            const resolvedIps = addresses.map(entry =>
                typeof entry === 'string' ? entry : entry.address
            );

            const unsafeIp = resolvedIps.find(isInternalIp);
            if (unsafeIp) {
                log.warn(() => `[SSRF] ${normalized} resolved to non-global IP ${unsafeIp}`);
                return resolve({
                    safe: false,
                    resolvedIps,
                    error: `Hostname ${normalized} resolves to internal or non-global IP ${unsafeIp}`
                });
            }

            return resolve({ safe: true, resolvedIps });
        });
    });
}

/**
 * Validate and canonicalize a caller-provided custom provider base URL.
 *
 * @param {string} baseUrl
 * @returns {Promise<{valid: boolean, error?: string, sanitized?: string}>}
 */
async function validateCustomBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
        return { valid: false, error: 'Base URL is required for custom provider' };
    }

    const trimmed = baseUrl.trim();
    let parsed;
    try {
        parsed = assertSafeCustomRequestUrl(trimmed);
    } catch (error) {
        const message = String(error?.message || '').replace(/^\[SSRF\]\s*/, '');
        return { valid: false, error: message || 'Invalid custom provider URL' };
    }

    const hostname = parsed.hostname;
    if (areInternalEndpointsAllowed() && isInternalHost(hostname)) {
        log.debug(() => `[SSRF] Allowing internal endpoint ${hostname} (ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true)`);
        return { valid: true, sanitized: parsed.toString() };
    }

    const dnsResult = await resolveAndValidateHost(hostname);
    if (!dnsResult.safe) {
        if (areInternalEndpointsAllowed()) {
            log.debug(() => `[SSRF] Allowing ${hostname} -> ${dnsResult.resolvedIps?.join(', ')} (ALLOW_INTERNAL_CUSTOM_ENDPOINTS=true)`);
            return { valid: true, sanitized: parsed.toString() };
        }

        log.warn(() => `[SSRF] Blocked custom endpoint ${hostname}: ${dnsResult.error}`);
        return {
            valid: false,
            error: `Hostname ${hostname} resolves to an internal, private, or non-global IP address. This is blocked for security.`
        };
    }

    log.debug(() => `[SSRF] Validated external endpoint: ${hostname} -> ${dnsResult.resolvedIps?.join(', ')}`);
    return { valid: true, sanitized: parsed.toString() };
}

/**
 * Node-compatible DNS lookup that checks every address immediately before a
 * socket is opened. Redirected hostnames use these same protected agents.
 *
 * @returns {Function}
 */
function createSsrfSafeLookup(policyOptions = {}) {
    return function ssrfSafeLookup(hostname, lookupOptions, callback) {
        if (typeof lookupOptions === 'function') {
            callback = lookupOptions;
            lookupOptions = {};
        } else if (typeof lookupOptions === 'number') {
            lookupOptions = { family: lookupOptions };
        } else {
            lookupOptions = lookupOptions || {};
        }

        const all = lookupOptions.all === true;
        const family = lookupOptions.family || 0;

        const allowInternal = shouldAllowInternal(policyOptions);

        if (!allowInternal && isInternalHost(hostname)) {
            return callback(createSsrfError(
                `Blocked connection to internal or non-global host ${hostname}`,
                'ESSRF_INTERNAL_IP'
            ));
        }

        const dnsLookupOptions = {
            all: true,
            family,
            verbatim: true
        };
        if (lookupOptions.hints !== undefined) dnsLookupOptions.hints = lookupOptions.hints;

        dns.lookup(normalizeHostname(hostname), dnsLookupOptions, (error, addresses) => {
            if (error) return callback(error);

            if (!Array.isArray(addresses) || addresses.length === 0) {
                return callback(createSsrfError(
                    `DNS lookup returned no addresses for ${hostname}`,
                    'ESSRF_DNS_EMPTY'
                ));
            }

            if (!allowInternal) {
                for (const entry of addresses) {
                    const ip = typeof entry === 'string' ? entry : entry.address;
                    if (isInternalIp(ip)) {
                        log.warn(() => `[SSRF] Connection-time block: ${hostname} -> ${ip}`);
                        return callback(createSsrfError(
                            `Blocked connection to ${hostname}: resolved to internal or non-global IP ${ip}`,
                            'ESSRF_INTERNAL_IP'
                        ));
                    }
                }
            }

            if (all) {
                return callback(null, addresses);
            }

            const first = addresses[0];
            return callback(null, first.address, first.family);
        });
    };
}

/**
 * Axios/follow-redirects hook. It runs after each Location header is resolved
 * but before the next request. DNS is then checked by createSsrfSafeLookup.
 *
 * @returns {Function}
 */
function createSsrfSafeRedirectValidator(policyOptions = {}) {
    return function ssrfSafeRedirectValidator(redirectOptions) {
        const redirectUrl = redirectOptions?.href;
        if (!redirectUrl) {
            throw createSsrfError('Redirect destination is missing or invalid');
        }
        assertSafeRequestUrl(redirectUrl, policyOptions);
    };
}

module.exports = {
    validateCustomBaseUrl,
    assertSafeRequestUrl,
    assertSafeCustomRequestUrl,
    assertSafePublicRequestUrl,
    isInternalHost,
    isInternalIp,
    resolveAndValidateHost,
    areInternalEndpointsAllowed,
    createSsrfSafeLookup,
    createSsrfSafeRedirectValidator
};
