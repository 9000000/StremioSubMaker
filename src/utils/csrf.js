/**
 * CSRF Protection Utilities
 * 
 * Provides Cross-Site Request Forgery protection for browser-facing POST endpoints.
 * Uses double-submit cookie pattern for simplicity (no server-side state needed).
 * 
 * Security Model:
 * - A CSRF token is generated and stored in a secure cookie
 * - The client must send this token back in request headers or body
 * - The server validates that the token matches the cookie
 * - This works because attacker sites cannot read our cookies (same-origin policy)
 */

const crypto = require('crypto');
const log = require('./logger');

const CSRF_TOKEN_LENGTH = 32; // 256 bits
const CSRF_COOKIE_NAME = 'x-csrf-token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_BODY_FIELD = '_csrfToken';

// Token expiry: 24 hours (tokens rotate on page load)
const CSRF_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Generate a cryptographically secure CSRF token
 * @returns {string} Hex-encoded random token
 */
function generateCsrfToken() {
    return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
}

/**
 * Set CSRF token cookie on response
 * @param {Object} res - Express response object
 * @param {string} token - CSRF token to set
 */
function setCsrfCookie(res, token) {
    const secure = process.env.NODE_ENV === 'production' || process.env.FORCE_HTTPS === 'true';

    res.cookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false, // Must be readable by JavaScript to include in headers
        secure,
        sameSite: 'strict', // Prevent cross-site cookie transmission
        maxAge: CSRF_TOKEN_MAX_AGE_MS,
        path: '/'
    });
}

/**
 * Get or create CSRF token for a request
 * If a valid token exists in cookies, returns it; otherwise generates a new one
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {string} CSRF token
 */
function ensureCsrfToken(req, res) {
    const existingToken = req.cookies?.[CSRF_COOKIE_NAME];

    // If we have an existing token, validate it's well-formed
    if (existingToken && /^[a-f0-9]{64}$/.test(existingToken)) {
        return existingToken;
    }

    // Generate new token
    const token = generateCsrfToken();
    setCsrfCookie(res, token);
    return token;
}

/**
 * Extract CSRF token from request (header or body)
 * @param {Object} req - Express request object
 * @returns {string|null} Token if found, null otherwise
 */
function extractCsrfToken(req) {
    // Check header first (preferred for AJAX requests)
    const headerToken = req.get(CSRF_HEADER_NAME);
    if (headerToken) {
        return headerToken;
    }

    // Check request body (for form submissions)
    if (req.body && req.body[CSRF_BODY_FIELD]) {
        return req.body[CSRF_BODY_FIELD];
    }

    // Check query params (for some edge cases)
    if (req.query && req.query[CSRF_BODY_FIELD]) {
        return req.query[CSRF_BODY_FIELD];
    }

    return null;
}

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings are equal
 */
function constantTimeCompare(a, b) {
    if (!a || !b || typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Validate CSRF token from request against cookie
 * @param {Object} req - Express request object
 * @returns {{ valid: boolean, reason?: string }} Validation result
 */
function validateCsrfToken(req) {
    const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
    const requestToken = extractCsrfToken(req);

    if (!cookieToken) {
        return { valid: false, reason: 'missing_cookie' };
    }

    if (!requestToken) {
        return { valid: false, reason: 'missing_token' };
    }

    // Validate token format (should be 64 hex chars)
    if (!/^[a-f0-9]{64}$/.test(cookieToken) || !/^[a-f0-9]{64}$/.test(requestToken)) {
        return { valid: false, reason: 'invalid_format' };
    }

    // Constant-time comparison to prevent timing attacks
    if (!constantTimeCompare(cookieToken, requestToken)) {
        return { valid: false, reason: 'mismatch' };
    }

    return { valid: true };
}

/**
 * Express middleware to enforce CSRF protection on POST/PUT/DELETE requests
 * @param {Object} options - Configuration options
 * @param {Array<string>} options.skipRoutes - Routes to skip CSRF validation
 * @param {boolean} options.skipStremioClients - Skip validation for Stremio native clients
 * @returns {Function} Express middleware
 */
function csrfProtection(options = {}) {
    const { skipRoutes = [], skipStremioClients = true } = options;

    return (req, res, next) => {
        // Only check state-changing methods
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            return next();
        }

        // Skip API routes that are called by Stremio (not browser forms)
        // These are protected by Origin/CORS checks instead
        const isApiRoute = req.path.startsWith('/addon/') && !req.path.includes('/file-');
        if (isApiRoute) {
            return next();
        }

        // Skip configured routes
        if (skipRoutes.some(route => req.path === route || req.path.startsWith(route + '/'))) {
            return next();
        }

        // Skip if no origin (native Stremio client) and skipStremioClients is enabled
        const origin = req.get('origin');
        if (skipStremioClients && (!origin || origin === 'null')) {
            return next();
        }

        // Validate CSRF token
        const validation = validateCsrfToken(req);

        if (!validation.valid) {
            log.warn(() => `[CSRF] Token validation failed: ${validation.reason} for ${req.method} ${req.path}`);

            // Return 403 Forbidden with JSON error
            return res.status(403).json({
                error: 'CSRF validation failed',
                reason: validation.reason,
                hint: 'Please refresh the page and try again'
            });
        }

        next();
    };
}

/**
 * Express middleware to set CSRF token on page requests
 * Attaches token to res.locals for use in templates
 * @returns {Function} Express middleware
 */
function csrfTokenSetter() {
    return (req, res, next) => {
        // Only set token for GET requests (page loads)
        if (req.method !== 'GET') {
            return next();
        }

        // Skip non-HTML requests
        const accept = req.get('accept') || '';
        if (!accept.includes('text/html') && !accept.includes('*/*')) {
            return next();
        }

        const token = ensureCsrfToken(req, res);
        res.locals.csrfToken = token;

        next();
    };
}

/**
 * Generate client-side JavaScript to include CSRF token in requests
 * @param {string} token - CSRF token
 * @returns {string} JavaScript code
 */
function generateCsrfClientScript(token) {
    return `
    <script>
    (function() {
        window.__CSRF_TOKEN = ${JSON.stringify(token)};
        
        // Intercept fetch to automatically add CSRF token
        const originalFetch = window.fetch;
        window.fetch = function(url, options = {}) {
            const opts = { ...options };
            const method = (opts.method || 'GET').toUpperCase();
            
            // Add CSRF token to POST/PUT/PATCH/DELETE requests
            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
                opts.headers = opts.headers || {};
                if (opts.headers instanceof Headers) {
                    opts.headers.set('${CSRF_HEADER_NAME}', window.__CSRF_TOKEN);
                } else {
                    opts.headers['${CSRF_HEADER_NAME}'] = window.__CSRF_TOKEN;
                }
            }
            
            return originalFetch.call(this, url, opts);
        };
        
        // Helper for forms
        window.csrfField = function() {
            return '<input type="hidden" name="${CSRF_BODY_FIELD}" value="' + window.__CSRF_TOKEN + '">';
        };
    })();
    </script>`;
}

module.exports = {
    generateCsrfToken,
    setCsrfCookie,
    ensureCsrfToken,
    extractCsrfToken,
    validateCsrfToken,
    csrfProtection,
    csrfTokenSetter,
    generateCsrfClientScript,
    CSRF_HEADER_NAME,
    CSRF_BODY_FIELD,
    CSRF_COOKIE_NAME
};
