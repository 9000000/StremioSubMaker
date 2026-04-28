/**
 * Sentry Integration for SubMaker
 * 
 * All errors are sent to Sentry (no filtering).
 * Only warn/info level messages are filtered out.
 * 
 * Usage:
 *   const sentry = require('./sentry');
 *   sentry.init();  // Call once at startup
 *   
 *   // Report an error (sent to Sentry)
 *   sentry.captureError(error, { module: 'Translation', userId: 'abc123' });
 *   
 *   // Force report (same as captureError, for backwards compatibility)
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

// NOTE: All error filtering has been removed. All errors are now sent to Sentry.
// (warn and below messages are still filtered out)

// Deduplication: track how many times we've sent identical events to Sentry.
// Key = fingerprint string, Value = count sent so far.
const eventSendCounts = new Map();
const MAX_IDENTICAL_EVENTS = 5;

/**
 * Build a deduplication fingerprint for a Sentry event.
 * For security-blocked-origin messages, fingerprint by origin only.
 * For everything else, fingerprint by the full message or exception value.
 */
function getEventFingerprint(event) {
    const msg = event?.message || event?.exception?.values?.[0]?.value || '';
    if (!msg) return null;

    // Security blocked origin — deduplicate by origin alone
    const originMatch = msg.match(/Blocked request \(origin not allowed\) - origin: ([^,]+)/);
    if (originMatch) {
        return `blocked_origin:${originMatch[1].trim()}`;
    }

    // General dedup: use the raw message
    return `msg:${msg}`;
}

/**
 * Initialize Sentry
 * Call this once at application startup
 */
function init() {
    const dsn = process.env.SENTRY_DSN;

    console.log('[Sentry] init() called. SENTRY_DSN present:', !!dsn, '| SENTRY_ENABLED:', process.env.SENTRY_ENABLED);

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

            // Deduplicate identical events — allow up to MAX_IDENTICAL_EVENTS then drop
            beforeSend(event, hint) {
                const fingerprint = getEventFingerprint(event);
                if (fingerprint) {
                    const count = eventSendCounts.get(fingerprint) || 0;
                    if (count >= MAX_IDENTICAL_EVENTS) {
                        return null; // Drop — we've already sent enough of these
                    }
                    eventSendCounts.set(fingerprint, count + 1);
                }
                console.log('[Sentry] beforeSend triggered for event:', event?.event_id);
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
        console.log(`[Sentry] ✅ INITIALIZED for environment: ${process.env.SENTRY_ENVIRONMENT || 'production'} | DSN: ${dsn.slice(0, 30)}...`);
        return true;

    } catch (err) {
        console.error('[Sentry] ❌ FAILED to initialize:', err.message);
        console.error('[Sentry] Install with: npm install @sentry/node');
        return false;
    }
}

/**
 * Capture an error and send to Sentry
 * All errors are sent (no filtering)
 * 
 * @param {Error|string} error - Error object or message
 * @param {Object} extras - Additional context (module, userId, etc.)
 * @returns {string|null} - Sentry event ID or null if disabled
 */
function captureError(error, extras = {}) {
    if (!sentryInitialized || !Sentry) {
        console.log('[Sentry] captureError called but Sentry not initialized (sentryInitialized=%s, Sentry=%s)', sentryInitialized, !!Sentry);
        return null;
    }

    // NO FILTERING - send ALL errors to Sentry
    try {
        const eventId = Sentry.captureException(error, {
            extra: extras,
            tags: {
                module: extras.module || 'unknown',
                ...(extras.tags || {})
            }
        });

        console.log('[Sentry] Captured error with eventId:', eventId, '| Error:', error?.message || String(error).slice(0, 100));

        // Mark as sent to avoid duplicates
        if (error && typeof error === 'object') {
            error._sentToSentry = true;
        }

        return eventId;
    } catch (e) {
        console.error('[Sentry] captureError threw:', e?.message || e);
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
        console.log('[Sentry] captureErrorForced called but Sentry not initialized (sentryInitialized=%s, Sentry=%s)', sentryInitialized, !!Sentry);
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

        console.log('[Sentry] Captured forced error with eventId:', eventId, '| Error:', error?.message || String(error).slice(0, 100));

        if (error && typeof error === 'object') {
            error._sentToSentry = true;
        }

        return eventId;
    } catch (e) {
        console.error('[Sentry] captureErrorForced threw:', e?.message || e);
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

    // Only send error and fatal level messages to Sentry (warn and below not needed)
    if (level !== 'error' && level !== 'fatal') {
        return null;
    }

    try {
        const eventId = Sentry.captureMessage(message, {
            level,
            extra: extras,
            tags: {
                module: extras.module || 'unknown',
                ...(extras.tags || {})
            }
        });
        console.log('[Sentry] Captured message with eventId:', eventId, '| Level:', level, '| Message:', String(message).slice(0, 100));
        return eventId;
    } catch (e) {
        console.error('[Sentry] captureMessage threw:', e?.message || e);
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
};
