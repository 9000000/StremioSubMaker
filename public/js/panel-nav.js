/* ═══════════════════════════════════════════════════════════
   SubMaker Config V2 — Panel Navigation Controller
   Sidebar nav · Panel transitions · Keyboard nav · Hash routing
   ═══════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    const STORAGE_KEY = 'submaker-v2-active-panel';
    const PANELS = ['dashboard', 'sources', 'ai-engine', 'languages', 'translation', 'extras', 'advanced', 'deploy'];

    let activePanel = null;
    let isTransitioning = false;

    // ── Init ──
    function init() {
        const saved = localStorage.getItem(STORAGE_KEY);
        const hash = window.location.hash.replace('#', '');
        const initial = PANELS.includes(hash) ? hash : (PANELS.includes(saved) ? saved : 'dashboard');

        // Bind sidebar nav items
        document.querySelectorAll('.v2-nav-item[data-panel]').forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                switchPanel(this.dataset.panel);
                closeMobileSidebar();
            });
        });

        // Bind card collapse headers
        document.querySelectorAll('[data-v2-collapse]').forEach(header => {
            header.addEventListener('click', function () {
                const card = this.closest('.v2-card');
                if (card) card.classList.toggle('expanded');
            });
        });

        // Keyboard navigation
        document.addEventListener('keydown', handleKeyboard);

        // Hash change
        window.addEventListener('hashchange', function () {
            const hash = window.location.hash.replace('#', '');
            if (PANELS.includes(hash) && hash !== activePanel) {
                switchPanel(hash, false);
            }
        });

        // What's New portal toggle
        const portal = document.getElementById('whatsNewPortal');
        const portalHeader = document.getElementById('portalHeader');
        if (portal && portalHeader) {
            portalHeader.addEventListener('click', function () {
                portal.classList.toggle('expanded');
            });
        }

        // Quick Setup banner
        const quickSetupBanner = document.getElementById('quickSetupBanner');
        if (quickSetupBanner) {
            quickSetupBanner.addEventListener('click', function () {
                // Trigger quick setup overlay (existing JS handles #quickSetupOverlay)
                const overlay = document.getElementById('quickSetupOverlay');
                if (overlay) {
                    overlay.style.display = 'flex';
                    overlay.classList.add('show');
                }
            });
        }

        // Mobile hamburger toggle
        var hamburger = document.getElementById('v2Hamburger');
        var sidebar = document.querySelector('.v2-sidebar');
        var backdrop = document.getElementById('v2MobileBackdrop');
        if (hamburger && sidebar) {
            hamburger.addEventListener('click', function () {
                var isOpen = sidebar.classList.toggle('mobile-open');
                hamburger.classList.toggle('active', isOpen);
                if (backdrop) backdrop.classList.toggle('show', isOpen);
            });
        }
        if (backdrop) {
            backdrop.addEventListener('click', closeMobileSidebar);
        }

        // Prevent toggle clicks from collapsing parent card (CSP-safe replacement for inline onclick)
        document.querySelectorAll('.v2-toggle').forEach(toggle => {
            toggle.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        });

        // Provider toggle → show/hide fields
        document.querySelectorAll('.v2-provider-block .v2-toggle input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', function () {
                const block = this.closest('.v2-provider-block');
                if (block) block.classList.toggle('active', this.checked);
            });
        });

        // Provider timeout range → value display
        const rangeInput = document.getElementById('subtitleProviderTimeout');
        const rangeValue = document.getElementById('subtitleProviderTimeoutValue');
        if (rangeInput && rangeValue) {
            rangeInput.addEventListener('input', function () {
                rangeValue.textContent = this.value + 's';
            });
        }

        // Advanced Settings nav visibility (tied to betaMode toggle in Other Settings)
        const betaModeCheckbox = document.getElementById('betaMode');
        const advancedNav = document.getElementById('navAdvanced');
        if (betaModeCheckbox && advancedNav) {
            const syncAdvancedNav = function () {
                advancedNav.style.display = betaModeCheckbox.checked ? '' : 'none';
                // If user disables while viewing Advanced Settings, redirect to dashboard
                if (!betaModeCheckbox.checked && activePanel === 'advanced') {
                    switchPanel('dashboard');
                }
            };
            betaModeCheckbox.addEventListener('change', syncAdvancedNav);
            // Sync on init
            syncAdvancedNav();
            // Re-sync after config-loader sets saved values (may fire after panel-nav init)
            document.addEventListener('configLoaded', syncAdvancedNav);
            // Fallback: re-check shortly in case config-loader doesn't emit an event
            setTimeout(syncAdvancedNav, 500);
            setTimeout(syncAdvancedNav, 1500);
        }

        // Activate initial panel
        switchPanel(initial, false);

        // Version badge
        updateVersionBadge();

        // Populate What's New changelog
        populateChangelog();

        console.log('[V2 Nav] 🎮 Panel navigation initialized');
    }

    // ── Switch Panel ──
    function switchPanel(panelId, updateHash = true) {
        if (!PANELS.includes(panelId) || panelId === activePanel || isTransitioning) return;
        isTransitioning = true;

        // Deactivate old panel(s)
        if (activePanel) {
            const oldPanel = document.getElementById('panel-' + activePanel);
            if (oldPanel) {
                oldPanel.classList.remove('active');
                oldPanel.style.animation = 'none';
            }
        } else {
            // First switch: clear the HTML-default 'active' class from all panels
            document.querySelectorAll('.v2-panel.active').forEach(function (p) {
                p.classList.remove('active');
                p.style.animation = 'none';
            });
        }

        // Update sidebar
        document.querySelectorAll('.v2-nav-item[data-panel]').forEach(btn => {
            const isActive = btn.dataset.panel === panelId;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        // Activate new panel with stagger re-animation
        const newPanel = document.getElementById('panel-' + panelId);
        if (newPanel) {
            newPanel.classList.add('active');

            // Re-trigger panel fade-in
            newPanel.style.animation = 'none';
            newPanel.offsetHeight; // Force reflow
            newPanel.style.animation = '';

            // Re-trigger stagger animations on children
            const stagger = newPanel.querySelector('.v2-stagger');
            if (stagger) {
                const children = stagger.children;
                for (let i = 0; i < children.length; i++) {
                    const child = children[i];
                    child.style.animation = 'none';
                    child.offsetHeight; // Force reflow
                    child.style.animation = '';
                }
            }

            // Smooth scroll to top
            const main = document.querySelector('.v2-main');
            if (main) main.scrollTop = 0;
        }

        activePanel = panelId;
        localStorage.setItem(STORAGE_KEY, panelId);

        if (updateHash) {
            history.replaceState(null, '', '#' + panelId);
        }

        setTimeout(() => { isTransitioning = false; }, 350);
    }

    // ── Keyboard Navigation ──
    function handleKeyboard(e) {
        // Arrow up/down to navigate sidebar when a nav item is focused
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const focused = document.activeElement;
            if (focused && focused.classList.contains('v2-nav-item') && focused.dataset.panel) {
                e.preventDefault();
                const idx = PANELS.indexOf(focused.dataset.panel);
                const next = e.key === 'ArrowDown'
                    ? PANELS[(idx + 1) % PANELS.length]
                    : PANELS[(idx - 1 + PANELS.length) % PANELS.length];
                const nextBtn = document.querySelector('.v2-nav-item[data-panel="' + next + '"]');
                if (nextBtn) {
                    nextBtn.focus();
                    switchPanel(next);
                }
            }
        }

        // Number keys 1-8 to jump to panels (when not in an input)
        if (e.key >= '1' && e.key <= '8' && !isInputFocused()) {
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            const idx = parseInt(e.key) - 1;
            if (idx < PANELS.length) {
                e.preventDefault();
                switchPanel(PANELS[idx]);
                const btn = document.querySelector('.v2-nav-item[data-panel="' + PANELS[idx] + '"]');
                if (btn) btn.focus();
            }
        }
    }

    function isInputFocused() {
        const el = document.activeElement;
        if (!el) return false;
        const tag = el.tagName.toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    }

    // ── Version Badge ──
    function updateVersionBadge() {
        const badge = document.getElementById('version-badge');
        const portalBadge = document.getElementById('portalVersionBadge');
        const mainBadge = document.getElementById('main-version-badge');
        // Try to read from existing version element or meta
        const existingVersion = document.querySelector('meta[name="version"]');
        if (existingVersion) {
            const ver = existingVersion.content;
            if (badge) { badge.textContent = ver; badge.style.display = ''; }
            if (portalBadge) portalBadge.textContent = ver;
            if (mainBadge) { mainBadge.textContent = ver; mainBadge.style.display = ''; }
        }
    }

    // ── Confetti burst on save success ──
    window.v2Confetti = function () {
        const container = document.getElementById('v2Confetti');
        if (!container) return;
        container.innerHTML = '';
        const colors = ['#4fa8ff', '#fbbf24', '#22d3ee', '#34d399', '#a78bfa', '#f87171', '#fb923c'];
        for (let i = 0; i < 40; i++) {
            const piece = document.createElement('div');
            piece.className = 'v2-confetti-piece';
            piece.style.left = Math.random() * 100 + '%';
            piece.style.background = colors[Math.floor(Math.random() * colors.length)];
            piece.style.animationDelay = (Math.random() * 0.5) + 's';
            piece.style.animationDuration = (0.8 + Math.random() * 0.6) + 's';
            container.appendChild(piece);
        }
        setTimeout(() => { container.innerHTML = ''; }, 2000);
    };

    // ── Close mobile sidebar ──
    function closeMobileSidebar() {
        var sidebar = document.querySelector('.v2-sidebar');
        var hamburger = document.getElementById('v2Hamburger');
        var backdrop = document.getElementById('v2MobileBackdrop');
        if (sidebar) sidebar.classList.remove('mobile-open');
        if (hamburger) hamburger.classList.remove('active');
        if (backdrop) backdrop.classList.remove('show');
    }

    // ── Populate What's New Changelog ──
    function populateChangelog() {
        var container = document.getElementById('portalEntries');
        var badge = document.getElementById('portalVersionBadge');
        var dot = document.getElementById('portalNewDot');
        if (!container) return;

        fetch('/CHANGELOG.md')
            .then(function (r) { return r.ok ? r.text() : Promise.reject('fetch failed'); })
            .then(function (md) {
                var versions = parseChangelog(md, 3);
                if (!versions.length) return;

                // Version badge
                if (badge) badge.textContent = versions[0].version;
                var mainBadge = document.getElementById('main-version-badge');
                if (mainBadge) { mainBadge.textContent = versions[0].version; mainBadge.style.display = ''; }

                // New-dot indicator
                var SEEN_KEY = 'submaker-v2-whats-new-seen';
                var lastSeen = '';
                try { lastSeen = localStorage.getItem(SEEN_KEY) || ''; } catch (_) { }
                if (lastSeen !== versions[0].version && dot) {
                    dot.style.display = '';
                }

                // Mark as seen when portal is expanded
                var portal = document.getElementById('whatsNewPortal');
                if (portal) {
                    var observer = new MutationObserver(function () {
                        if (portal.classList.contains('expanded') && dot) {
                            dot.style.display = 'none';
                            try { localStorage.setItem(SEEN_KEY, versions[0].version); } catch (_) { }
                        }
                    });
                    observer.observe(portal, { attributes: true, attributeFilter: ['class'] });
                }

                // Render entries
                var html = '';
                versions.forEach(function (v) {
                    html += '<div class="v2-whats-new-entry">';
                    html += '<div class="v2-whats-new-entry-title">✨ ' + escapeHtml(v.version) + '</div>';
                    v.categories.forEach(function (cat) {
                        html += '<div style="font-weight:600;color:var(--text-primary);margin:8px 0 4px;">' + escapeHtml(cat.name) + '</div>';
                        html += '<ul style="margin:0 0 8px 16px;padding:0;list-style:disc;">';
                        cat.items.forEach(function (item) {
                            html += '<li style="margin-bottom:4px;">' + mdInline(item) + '</li>';
                        });
                        html += '</ul>';
                    });
                    html += '</div>';
                });
                container.innerHTML = html;
            })
            .catch(function (err) {
                console.warn('[V2 Nav] Could not load changelog:', err);
            });
    }

    function parseChangelog(md, maxVersions) {
        var versions = [];
        var lines = md.split(/\r?\n/);
        var current = null;
        var currentCat = null;
        var itemBuffer = '';

        for (var i = 0; i < lines.length && versions.length < maxVersions; i++) {
            var line = lines[i];

            // Version header: ## SubMaker v1.4.68
            if (/^## SubMaker\s+v/i.test(line)) {
                // Flush any pending item
                if (itemBuffer && currentCat) {
                    currentCat.items.push(itemBuffer.trim());
                    itemBuffer = '';
                }
                if (current) versions.push(current);
                if (versions.length >= maxVersions) break;
                current = { version: line.replace(/^##\s*/, '').trim(), categories: [] };
                currentCat = null;
                continue;
            }

            if (!current) continue;

            // Category header: **Bug Fixes:** or **Improvements:**
            var catMatch = line.match(/^\*\*([^*]+)\*\*\s*:?\s*$/);
            if (catMatch) {
                if (itemBuffer && currentCat) {
                    currentCat.items.push(itemBuffer.trim());
                    itemBuffer = '';
                }
                currentCat = { name: catMatch[1].replace(/:$/, ''), items: [] };
                current.categories.push(currentCat);
                continue;
            }

            // List item: - **Bold title:** description
            if (/^- /.test(line) && currentCat) {
                if (itemBuffer) {
                    currentCat.items.push(itemBuffer.trim());
                }
                // Take only the bold title portion for brevity
                var boldMatch = line.match(/^- \*\*([^*]+)\*\*/);
                itemBuffer = boldMatch ? boldMatch[1].replace(/:$/, '') : line.replace(/^- /, '');
                continue;
            }

            // Continuation lines (indented) — skip for brevity
        }

        // Flush last
        if (itemBuffer && currentCat) {
            currentCat.items.push(itemBuffer.trim());
        }
        if (current && versions.length < maxVersions) versions.push(current);

        return versions;
    }

    function escapeHtml(s) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(s));
        return div.innerHTML;
    }

    function mdInline(s) {
        // Bold
        s = escapeHtml(s);
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        // Inline code
        s = s.replace(/`([^`]+)`/g, '<code style="background:var(--bg-input);padding:1px 4px;border-radius:3px;font-size:0.85em;">$1</code>');
        return s;
    }

    // ── Wait for partials then init ──
    // The sidebar nav items live inside main-v2.html which is loaded
    // asynchronously by init.js. We must wait for that partial to be
    // injected into the DOM before we can bind event listeners.
    function waitForPartialsAndInit() {
        if (window.mainPartialReady) {
            window.mainPartialReady.then(init);
        } else {
            // Fallback: partials script hasn't run yet, retry shortly
            setTimeout(waitForPartialsAndInit, 50);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForPartialsAndInit);
    } else {
        waitForPartialsAndInit();
    }
})();
