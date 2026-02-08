/**
 * Error Classifier Utility
 * 
 * Properly distinguishes programming bugs from operational/expected errors.
 * Programming bugs (TypeError, ReferenceError, etc.) should NEVER be silently 
 * swallowed as warnings - they indicate broken code that needs fixing.
 */

const log = require('./logger');

/**
 * Common error message patterns that indicate programming bugs.
 * These patterns will be matched against error.message.
 */
const BUG_PATTERNS = [
    /is not a function/i,
    /is not defined/i,
    /cannot read propert/i,           // "Cannot read property 'x' of undefined/null"
    /cannot set propert/i,
    /cannot access.*before initialization/i,
    /is not iterable/i,
    /is not a constructor/i,
    /unexpected token/i,
    /invalid or unexpected/i,
    /stack overflow/i,
    /maximum call stack/i,
    /assignment to constant/i,
    /invalid left-hand side/i,
    /illegal (return|break|continue)/i,
    /duplicate parameter/i,
    /already been declared/i,
    /undefined is not an object/i,
    /null is not an object/i,
    /circular structure/i,
    /out of memory/i,
    /cannot convert.*to object/i,
    /invalid array length/i,
    /precision is out of range/i,
    /radix must be/i,
    /repeat count must be/i,
    /cannot use import/i,
    /unexpected end of/i,
];

/**
 * Detects if an error is a programming bug vs an operational/expected error.
 * Programming bugs should NEVER be silently swallowed — they indicate broken code.
 * 
 * @param {Error} error - The error to classify
 * @returns {boolean} - true if this is a programming bug, false if operational
 */
function isProgrammingBug(error) {
    if (!error) return false;

    // JavaScript built-in error types that indicate code bugs
    if (error instanceof TypeError) return true;      // "X is not a function", "Cannot read property of undefined"
    if (error instanceof ReferenceError) return true; // "X is not defined"  
    if (error instanceof SyntaxError) return true;    // Parsing errors
    if (error instanceof RangeError) return true;     // Invalid array length, stack overflow

    // Check error message patterns
    const msg = error.message || '';
    if (BUG_PATTERNS.some(p => p.test(msg))) return true;

    // Check error name as fallback (some environments use custom names)
    const name = error.name || '';
    if (/^(Type|Reference|Syntax|Range)Error$/i.test(name)) return true;

    return false;
}

/**
 * Wrapper for catch blocks that properly escalates programming bugs.
 * Use this instead of raw catch blocks to ensure bugs don't get swallowed.
 * 
 * USAGE:
 * ```javascript
 * } catch (error) {
 *     return handleCaughtError(error, '[SharedCache] DECR', log, { fallbackValue: -1 });
 * }
 * ```
 * 
 * @param {Error} error - The caught error
 * @param {string} context - Context string for logging (e.g., "[SharedCache] DECR")
 * @param {Object} logger - Logger instance with error() and warn() methods
 * @param {Object} options - Configuration options
 * @param {any} options.fallbackValue - Value to return for operational errors (default: null)
 * @param {boolean} options.rethrowBugs - Whether to rethrow programming bugs (default: false)
 * @param {boolean} options.includeStack - Include stack trace in error log (default: true)
 * @returns {any} - fallbackValue for operational errors, or throws for bugs if rethrowBugs=true
 */
function handleCaughtError(error, context, logger, options = {}) {
    const {
        fallbackValue = null,
        rethrowBugs = false,
        includeStack = true
    } = options;

    // Use module-level logger as fallback if not provided
    const logInstance = logger || log;

    if (isProgrammingBug(error)) {
        // ALWAYS log as error - this is a code bug that needs fixing
        // Pass the Error object as second arg so Sentry integration picks it up
        const stackInfo = includeStack && error.stack ? `\n${error.stack}` : '';
        logInstance.error(() => [`${context} [BUG]: ${error.message}${stackInfo}`, error]);

        if (rethrowBugs) {
            throw error;
        }
        return fallbackValue;
    }

    // Operational error — warn level is appropriate
    logInstance.warn(() => `${context}: ${error.message}`);
    return fallbackValue;
}

/**
 * Creates a scoped error handler for a specific module/component.
 * This reduces repetition when multiple catch blocks need the same context prefix.
 * 
 * USAGE:
 * ```javascript
 * const handleError = createScopedErrorHandler('[SharedCache]', log);
 * 
 * // Then in catch blocks:
 * } catch (error) {
 *     return handleError(error, 'DECR', { fallbackValue: -1 });
 * }
 * ```
 * 
 * @param {string} scopePrefix - Prefix for all error messages (e.g., "[SharedCache]")
 * @param {Object} logger - Logger instance with error() and warn() methods
 * @param {Object} defaultOptions - Default options for all handleCaughtError calls
 * @returns {Function} - Scoped error handler function
 */
function createScopedErrorHandler(scopePrefix, logger, defaultOptions = {}) {
    return function (error, operation, options = {}) {
        const context = `${scopePrefix} ${operation}`;
        return handleCaughtError(error, context, logger, { ...defaultOptions, ...options });
    };
}

module.exports = {
    isProgrammingBug,
    handleCaughtError,
    createScopedErrorHandler,
    BUG_PATTERNS
};
