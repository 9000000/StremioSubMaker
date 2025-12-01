(function() {
    'use strict';

    function translate(key, vars, fallback) {
        try {
            if (typeof window.t === 'function') {
                return window.t(key, vars || {}, fallback || key);
            }
        } catch (_) {}
        return fallback || key;
    }

    /**
     * Load HTML partials declared via data-include attributes.
     * Exposes window.partialsReady so other scripts can wait before wiring UI.
     * Prioritizes the main partial so core content renders before footer/overlays.
     */
    function fetchPartial(el) {
        const src = el.getAttribute('data-include');
        if (!src) return Promise.resolve('');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        return fetch(src, { cache: 'no-store', signal: controller.signal })
            .then(function(res) {
                if (!res.ok) {
                    const message = translate('config.partials.loadError', { src: src, status: res.status }, 'Failed to load partial: ' + src + ' (' + res.status + ')');
                    throw new Error(message);
                }
                return res.text();
            })
            .catch(function(err) {
                console.error(err);
                const fallback = translate('config.partials.loadFallback', { src: src }, 'Failed to load ' + src);
                return '<div style="padding:1rem; color:#ef4444;">' + fallback + '</div>';
            })
            .finally(function() {
                clearTimeout(timeout);
            });
    }

    function applyPartial(el, html) {
        el.innerHTML = html;
        el.removeAttribute('data-include');
    }

    function getPriority(el) {
        const src = el.getAttribute('data-include') || '';
        if (src.indexOf('main') !== -1) return 0;
        if (src.indexOf('overlays') !== -1) return 1;
        return 2; // footer + any extras
    }

    const targets = Array.prototype.slice.call(document.querySelectorAll('[data-include]'));
    const entries = targets.map(function(el) {
        return {
            el,
            priority: getPriority(el),
            fetchPromise: fetchPartial(el),
            applied: null
        };
    });

    function applyEntry(entry) {
        if (entry.applied) return entry.applied;
        entry.applied = entry.fetchPromise.then(function(html) {
            applyPartial(entry.el, html);
        });
        return entry.applied;
    }

    const prioritized = entries.slice().sort(function(a, b) { return a.priority - b.priority; });
    const mainEntry = prioritized.find(function(e) { return e.priority === 0; });

    // Render main content ASAP while keeping fetches parallel for the rest.
    const mainReady = mainEntry ? applyEntry(mainEntry) : Promise.resolve();
    const ready = (async function() {
        for (const entry of prioritized) {
            await applyEntry(entry);
        }
    })().catch(function(err) {
        console.error(err);
    });

    window.mainPartialReady = mainReady;
    window.partialsReady = ready;
})();
