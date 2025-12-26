/**
 * CSRF Protection Client-Side Script
 * 
 * Automatically includes CSRF tokens in all state-changing requests.
 * Works by reading the CSRF token from cookies and injecting it into headers.
 */
(function () {
    'use strict';

    const CSRF_COOKIE_NAME = 'x-csrf-token';
    const CSRF_HEADER_NAME = 'x-csrf-token';

    /**
     * Get CSRF token from cookies
     * @returns {string|null} Token if found
     */
    function getCsrfToken() {
        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
            const [name, value] = cookie.trim().split('=');
            if (name === CSRF_COOKIE_NAME) {
                return decodeURIComponent(value);
            }
        }
        return null;
    }

    /**
     * Check if a method requires CSRF protection
     * @param {string} method HTTP method
     * @returns {boolean}
     */
    function requiresCsrf(method) {
        const upper = (method || 'GET').toUpperCase();
        return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(upper);
    }

    // Store original fetch
    const originalFetch = window.fetch;

    /**
     * Enhanced fetch that automatically includes CSRF token
     */
    window.fetch = function (url, options = {}) {
        const opts = { ...options };
        const method = (opts.method || 'GET').toUpperCase();

        // Add CSRF token to state-changing requests
        if (requiresCsrf(method)) {
            const token = getCsrfToken();
            if (token) {
                // Ensure headers object exists
                if (!opts.headers) {
                    opts.headers = {};
                }

                // Handle different header types
                if (opts.headers instanceof Headers) {
                    opts.headers.set(CSRF_HEADER_NAME, token);
                } else if (Array.isArray(opts.headers)) {
                    opts.headers.push([CSRF_HEADER_NAME, token]);
                } else {
                    opts.headers[CSRF_HEADER_NAME] = token;
                }
            }
        }

        return originalFetch.call(this, url, opts);
    };

    // Store original XMLHttpRequest open/send
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._csrfMethod = method;
        return originalXhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body) {
        if (requiresCsrf(this._csrfMethod)) {
            const token = getCsrfToken();
            if (token) {
                this.setRequestHeader(CSRF_HEADER_NAME, token);
            }
        }
        return originalXhrSend.call(this, body);
    };

    // Expose helper for forms
    window.csrfToken = getCsrfToken;

    /**
     * Create a hidden input element with CSRF token for forms
     * @returns {HTMLInputElement}
     */
    window.createCsrfInput = function () {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = '_csrfToken';
        input.value = getCsrfToken() || '';
        return input;
    };

    // Log CSRF protection status (only in development)
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        const token = getCsrfToken();
        if (token) {
            console.debug('[CSRF] Protection active, token:', token.slice(0, 8) + '...');
        } else {
            console.warn('[CSRF] No token found in cookies');
        }
    }
})();
