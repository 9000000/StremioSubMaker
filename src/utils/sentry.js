/**
 * Sentry Integration for SubMaker
 * 
 * Smart error reporting that filters out operational warnings
 * and only sends actual code errors to Sentry.
 * 
 * Usage:
 *   const sentry = require('./sentry');
 *   sentry.init();  // Call once at startup
 *   
 *   // Report an error (filtered - skips rate limits, auth failures, etc.)
 *   sentry.captureError(error, { module: 'Translation', userId: 'abc123' });
 *   
 *   // Force report (bypasses filters for critical errors)
 *   sentry.captureErrorForced(error, { module: 'Startup' });
 * 
 * Environment Variables:
 *   SENTRY_DSN - Your Sentry DSN (required to enable Sentry)
 *   SENTRY_ENVIRONMENT - Environment name (default: 'production')
 *   SENTRY_SAMPLE_RATE - Error sample rate 0-1 (default: 1.0 = 100%)
 *   SENTRY_ENABLED - Set to 'false' to disable (default: true when DSN is set)
 */

const { version } = require('./version');

// Lazy-load Sentry to avoid crashes if not installed
let Sentry = null;
let sentryInitialized = false;

// Patterns for errors we should NOT send to Sentry (expected operational issues)
const IGNORED_ERROR_PATTERNS = [
    // Rate limiting (expected under high load)
    /rate.?limit/i,
    /429/,
    /too many requests/i,
    /quota.?exceeded/i,

    // Authentication failures (user config issue, not our bug)
    /authentication.?failed/i,
    /invalid.?username/i,
    /invalid.?password/i,
    /invalid.?credentials/i,
    /401/,
    /403/,

    // Service unavailability (external issue, not our bug)
    /service.?unavailable/i,
    /503/,
    /502/,
    /504/,
    /gateway.?timeout/i,

    // Network issues (transient, not our bug)
    /ECONNRESET/,
    /ETIMEDOUT/,
    /ECONNREFUSED/,
    /ENOTFOUND/,
    /socket.?hang.?up/i,
    /network.?error/i,

    // Translation operational issues
    /concurrency.?limit/i,
    /translation.?in.?progress/i,
    /mobile.?mode.?wait.?timed.?out/i,

    // Safety blocks (working as intended)
    /BLOCKING.*cache.?reset/i,

    // Session/config issues (user needs to reconfigure)
    /session.?token.?error/i,
    /config.?error/i,
    /missing.?config/i,

    // OpenSubtitles quota (daily limit, expected)
    /allowed 20 subtitles/i,
    /download.?limit/i,

    // Gemini safety filters (working as intended)
    /PROHIBITED_CONTENT/i,
    /safety.?filter/i,
    /RECITATION/i,
    /MAX_TOKENS/i,
];

// Patterns for errors we should ALWAYS send to Sentry (critical issues)
const CRITICAL_ERROR_PATTERNS = [
    /uncaught.?exception/i,
    /unhandled.?rejection/i,
    /CRITICAL/i,
    /FATAL/i,
    /memory.?leak/i,
    /heap.?out.?of.?memory/i,
    /stack.?overflow/i,
];

/**
 * Check if an error should be ignored (not sent to Sentry)
 * @param {Error|string} error - Error object or message
 * @param {Object} extras - Additional context
 * @returns {boolean} - True if error should be ignored
 */
function shouldIgnoreError(error, extras = {}) {
    const message = typeof error === 'string' ? error : (error?.message || '');
    const fullContext = `${message} ${JSON.stringify(extras)}`;

    // Check if it's a critical error that should ALWAYS be reported
    if (CRITICAL_ERROR_PATTERNS.some(pattern => pattern.test(fullContext))) {
        return false; // Don't ignore critical errors
    }

    // Check if error is already marked as logged (avoid duplicates)
    if (error?._alreadyLogged || error?._sentToSentry) {
        return true;
    }

    // Check against ignore patterns
    return IGNORED_ERROR_PATTERNS.some(pattern => pattern.test(fullContext));
}

/**
 * Initialize Sentry
 * Call this once at application startup
 */
function init() {
    const dsn = process.env.SENTRY_DSN;

    if (!dsn) {
        console.log('[Sentry] SENTRY_DSN not configured - error reporting disabled');
        return false;
    }

    if (process.env.SENTRY_ENABLED === 'false') {
        console.log('[Sentry] Disabled via SENTRY_ENABLED=false');
        return false;
    }

    try {
        Sentry = require('@sentry/node');

        Sentry.init({
            dsn,
            environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
            release: `submaker@${version}`,

            // Sample rate for error events (1.0 = 100%)
            sampleRate: parseFloat(process.env.SENTRY_SAMPLE_RATE) || 1.0,

            // Don't capture console logs (we have our own logger)
            integrations: (integrations) => {
                return integrations.filter(integration => integration.name !== 'Console');
            },

            // Pre-filter events before sending
            beforeSend(event, hint) {
                const error = hint?.originalException;

                // Apply our ignore patterns
                if (error && shouldIgnoreError(error, event.extra || {})) {
                    return null; // Drop the event
                }

                // Check error message in the event itself
                const eventMessage = event.message || event.exception?.values?.[0]?.value || '';
                if (shouldIgnoreError(eventMessage, event.extra || {})) {
                    return null; // Drop the event
                }

                return event;
            },

            // Attach extra context to all events
            initialScope: {
                tags: {
                    app: 'submaker',
                    version: version
                }
            }
        });

        sentryInitialized = true;
        console.log(`[Sentry] Initialized for environment: ${process.env.SENTRY_ENVIRONMENT || 'production'}`);
        return true;

    } catch (err) {
        console.error('[Sentry] Failed to initialize:', err.message);
        console.error('[Sentry] Install with: npm install @sentry/node');
        return false;
    }
}

/**
 * Capture an error and send to Sentry (with filtering)
 * Automatically filters out operational issues like rate limits, auth failures, etc.
 * 
 * @param {Error|string} error - Error object or message
 * @param {Object} extras - Additional context (module, userId, etc.)
 * @returns {string|null} - Sentry event ID or null if filtered/disabled
 */
function captureError(error, extras = {}) {
    if (!sentryInitialized || !Sentry) {
        return null;
    }

    // Apply ignore filters
    if (shouldIgnoreError(error, extras)) {
        return null;
    }

    try {
        const eventId = Sentry.captureException(error, {
            extra: extras,
            tags: {
                module: extras.module || 'unknown',
                ...(extras.tags || {})
            }
        });

        // Mark as sent to avoid duplicates
        if (error && typeof error === 'object') {
            error._sentToSentry = true;
        }

        return eventId;
    } catch (e) {
        // Don't let Sentry errors crash the app
        return null;
    }
}

/**
 * Capture an error ALWAYS (bypasses filters)
 * Use for critical errors that must be reported regardless of patterns
 * 
 * @param {Error|string} error - Error object or message
 * @param {Object} extras - Additional context
 * @returns {string|null} - Sentry event ID or null if disabled
 */
function captureErrorForced(error, extras = {}) {
    if (!sentryInitialized || !Sentry) {
        return null;
    }

    try {
        const eventId = Sentry.captureException(error, {
            extra: { ...extras, forced: true },
            tags: {
                module: extras.module || 'unknown',
                critical: 'true',
                ...(extras.tags || {})
            }
        });

        if (error && typeof error === 'object') {
            error._sentToSentry = true;
        }

        return eventId;
    } catch (e) {
        return null;
    }
}

/**
 * Capture a message (for warnings/info that should be tracked)
 * 
 * @param {string} message - Message to capture
 * @param {string} level - Sentry level: 'fatal', 'error', 'warning', 'info', 'debug'
 * @param {Object} extras - Additional context
 * @returns {string|null} - Sentry event ID or null
 */
function captureMessage(message, level = 'info', extras = {}) {
    if (!sentryInitialized || !Sentry) {
        return null;
    }

    // Still apply ignore filters for non-error levels
    if (level !== 'fatal' && level !== 'error' && shouldIgnoreError(message, extras)) {
        return null;
    }

    try {
        return Sentry.captureMessage(message, {
            level,
            extra: extras,
            tags: {
                module: extras.module || 'unknown',
                ...(extras.tags || {})
            }
        });
    } catch (e) {
        return null;
    }
}

/**
 * Set user context for all subsequent events
 * 
 * @param {Object} user - User info { id, email, username, ... }
 */
function setUser(user) {
    if (!sentryInitialized || !Sentry) return;

    try {
        Sentry.setUser(user);
    } catch (e) {
        // Ignore
    }
}

/**
 * Add a breadcrumb for debugging context
 * 
 * @param {Object} breadcrumb - { category, message, level, data }
 */
function addBreadcrumb(breadcrumb) {
    if (!sentryInitialized || !Sentry) return;

    try {
        Sentry.addBreadcrumb(breadcrumb);
    } catch (e) {
        // Ignore
    }
}

/**
 * Flush pending events before shutdown
 * Call this before process exit
 * 
 * @param {number} timeout - Timeout in ms (default: 2000)
 */
async function flush(timeout = 2000) {
    if (!sentryInitialized || !Sentry) return;

    try {
        await Sentry.flush(timeout);
    } catch (e) {
        // Ignore
    }
}

/**
 * Check if Sentry is initialized
 * @returns {boolean}
 */
function isInitialized() {
    return sentryInitialized;
}

module.exports = {
    init,
    captureError,
    captureErrorForced,
    captureMessage,
    setUser,
    addBreadcrumb,
    flush,
    isInitialized,
    shouldIgnoreError, // Exported for testing
};
