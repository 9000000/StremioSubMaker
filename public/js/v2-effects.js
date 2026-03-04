/* ═══════════════════════════════════════════════════════════
   SubMaker Config V2 — Visual Effects Engine 🎮✨
   Starfield · Running Characters · Easter Eggs · XP System
   ═══════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ── Wait for partials to load ──
    function waitAndInit() {
        if (window.mainPartialReady) {
            window.mainPartialReady.then(init);
        } else {
            setTimeout(waitAndInit, 50);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitAndInit);
    } else {
        waitAndInit();
    }

    function init() {
        createPixelGrid();
        createStarfield();
        createRunners();
        initKonamiCode();
        initLogoEasterEgg();
        initXPSystem();
        initNavFlash();
        console.log('[V2 FX] 🎮 Effects engine loaded — enjoy the vibes!');
    }

    // ══════════════════════════ PIXEL GRID OVERLAY ══════════════════════════
    function createPixelGrid() {
        if (document.querySelector('.v2-pixel-grid')) return;
        const grid = document.createElement('div');
        grid.className = 'v2-pixel-grid';
        grid.setAttribute('aria-hidden', 'true');
        document.body.appendChild(grid);
    }

    // ══════════════════════════ STARFIELD ══════════════════════════
    function createStarfield() {
        let container = document.getElementById('v2-starfield');
        if (!container) {
            container = document.createElement('div');
            container.id = 'v2-starfield';
            container.className = 'v2-starfield';
            container.setAttribute('aria-hidden', 'true');
            document.body.appendChild(container);
        }

        const STAR_COUNT = 40;
        const fragment = document.createDocumentFragment();

        for (let i = 0; i < STAR_COUNT; i++) {
            const star = document.createElement('div');
            star.className = 'v2-star';
            star.style.left = Math.random() * 100 + '%';
            star.style.top = Math.random() * 100 + '%';
            star.style.setProperty('--star-dur', (2 + Math.random() * 5) + 's');
            star.style.animationDelay = (Math.random() * 5) + 's';

            // Vary sizes
            const size = Math.random() > 0.7 ? 3 : (Math.random() > 0.5 ? 2 : 1);
            star.style.width = size + 'px';
            star.style.height = size + 'px';

            // Some stars get accent colors
            if (Math.random() > 0.8) {
                const colors = ['var(--accent)', 'var(--accent-neon)', 'var(--accent-gold)', 'var(--accent-purple)', 'var(--accent-pink)'];
                star.style.background = colors[Math.floor(Math.random() * colors.length)];
            }

            fragment.appendChild(star);
        }
        container.appendChild(fragment);
    }

    // ══════════════════════════ RUNNING PIXEL CHARACTERS ══════════════════════════
    function createRunners() {
        let container = document.getElementById('v2-runners');
        if (!container) {
            container = document.createElement('div');
            container.id = 'v2-runners';
            container.className = 'v2-runners';
            container.setAttribute('aria-hidden', 'true');
            document.body.appendChild(container);
        }

        // Pixel art characters defined as box-shadow sprites
        const characters = [
            { name: 'robot', color: '#08A4D5', pixels: createRobotPixels(), speed: 18, delay: 0 },
            { name: 'ghost', color: '#a78bfa', pixels: createGhostPixels(), speed: 22, delay: 6 },
            { name: 'cat', color: '#fbbf24', pixels: createCatPixels(), speed: 15, delay: 12 },
        ];

        characters.forEach(char => {
            const runner = document.createElement('div');
            runner.className = 'v2-runner';
            runner.style.animationDuration = char.speed + 's';
            runner.style.animationDelay = char.delay + 's';

            // Create pixel sprite using box-shadow
            const sprite = document.createElement('div');
            sprite.style.cssText = `
                width: 1px; height: 1px; position: relative;
                box-shadow: ${char.pixels};
                image-rendering: pixelated;
            `;
            runner.appendChild(sprite);
            container.appendChild(runner);
        });
    }

    // Pixel art sprite definitions (each pixel = "Xpx Ypx 0 Spx color")
    // These create tiny 8x8 or so pixel art characters
    function createRobotPixels() {
        const c = '#08A4D5';
        const d = '#065a75';
        const w = '#e8ecf4';
        const s = 2; // pixel scale
        const px = (x, y, color) => `${x * s}px ${y * s}px 0 ${s - 1}px ${color}`;
        return [
            // Head
            px(2, 0, c), px(3, 0, c), px(4, 0, c), px(5, 0, c),
            px(1, 1, c), px(2, 1, d), px(3, 1, c), px(4, 1, c), px(5, 1, d), px(6, 1, c),
            px(1, 2, c), px(2, 2, w), px(3, 2, c), px(4, 2, c), px(5, 2, w), px(6, 2, c),
            px(2, 3, c), px(3, 3, c), px(4, 3, c), px(5, 3, c),
            // Body
            px(3, 4, c), px(4, 4, c),
            px(1, 5, c), px(2, 5, c), px(3, 5, d), px(4, 5, d), px(5, 5, c), px(6, 5, c),
            px(1, 6, c), px(2, 6, c), px(3, 6, c), px(4, 6, c), px(5, 6, c), px(6, 6, c),
            // Legs
            px(2, 7, c), px(3, 7, c), px(4, 7, c), px(5, 7, c),
            px(2, 8, d), px(3, 8, d), px(4, 8, d), px(5, 8, d),
        ].join(', ');
    }

    function createGhostPixels() {
        const c = '#a78bfa';
        const d = '#7c3aed';
        const w = '#e8ecf4';
        const b = '#1a1a2e';
        const s = 2;
        const px = (x, y, color) => `${x * s}px ${y * s}px 0 ${s - 1}px ${color}`;
        return [
            // Head (rounded)
            px(2, 0, c), px(3, 0, c), px(4, 0, c), px(5, 0, c),
            px(1, 1, c), px(2, 1, c), px(3, 1, c), px(4, 1, c), px(5, 1, c), px(6, 1, c),
            px(1, 2, c), px(2, 2, w), px(3, 2, b), px(4, 2, c), px(5, 2, w), px(6, 2, b),
            px(1, 3, c), px(2, 3, c), px(3, 3, c), px(4, 3, c), px(5, 3, c), px(6, 3, c),
            // Body
            px(1, 4, c), px(2, 4, c), px(3, 4, c), px(4, 4, c), px(5, 4, c), px(6, 4, c),
            px(1, 5, c), px(2, 5, c), px(3, 5, d), px(4, 5, d), px(5, 5, c), px(6, 5, c),
            px(1, 6, c), px(2, 6, c), px(3, 6, c), px(4, 6, c), px(5, 6, c), px(6, 6, c),
            // Wave bottom
            px(1, 7, c), px(3, 7, c), px(5, 7, c),
        ].join(', ');
    }

    function createCatPixels() {
        const c = '#fbbf24';
        const d = '#d97706';
        const w = '#e8ecf4';
        const b = '#1a1a2e';
        const p = '#f472b6';
        const s = 2;
        const px = (x, y, color) => `${x * s}px ${y * s}px 0 ${s - 1}px ${color}`;
        return [
            // Ears
            px(1, 0, c), px(6, 0, c),
            px(1, 1, c), px(2, 1, c), px(5, 1, c), px(6, 1, c),
            // Head
            px(1, 2, c), px(2, 2, c), px(3, 2, c), px(4, 2, c), px(5, 2, c), px(6, 2, c),
            px(1, 3, c), px(2, 3, w), px(3, 3, b), px(4, 3, c), px(5, 3, w), px(6, 3, b),
            px(1, 4, c), px(2, 4, c), px(3, 4, p), px(4, 4, p), px(5, 4, c), px(6, 4, c),
            // Body
            px(1, 5, c), px(2, 5, c), px(3, 5, c), px(4, 5, c), px(5, 5, c), px(6, 5, c),
            px(1, 6, c), px(2, 6, d), px(3, 6, c), px(4, 6, c), px(5, 6, d), px(6, 6, c),
            // Legs + tail
            px(1, 7, c), px(2, 7, c), px(5, 7, c), px(6, 7, c), px(7, 7, d),
            px(1, 8, d), px(2, 8, d), px(5, 8, d), px(6, 8, d), px(7, 8, d), px(8, 8, d),
        ].join(', ');
    }

    // ══════════════════════════ KONAMI CODE EASTER EGG ══════════════════════════
    function initKonamiCode() {
        const CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
            'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
            'b', 'a'];
        let pos = 0;

        document.addEventListener('keydown', function (e) {
            if (e.key === CODE[pos] || e.key.toLowerCase() === CODE[pos]) {
                pos++;
                if (pos === CODE.length) {
                    pos = 0;
                    triggerKonamiEasterEgg();
                }
            } else {
                pos = 0;
            }
        });
    }

    function triggerKonamiEasterEgg() {
        // 1. Screen shake
        document.body.classList.add('screen-shake');
        setTimeout(() => document.body.classList.remove('screen-shake'), 400);

        // 2. Retro mode flash
        document.body.classList.add('retro-mode');
        setTimeout(() => document.body.classList.remove('retro-mode'), 3000);

        // 3. Massive confetti burst
        if (window.v2Confetti) window.v2Confetti();

        // 4. Extra confetti wave
        setTimeout(() => {
            if (window.v2Confetti) window.v2Confetti();
        }, 300);

        // 5. XP reward
        spawnXP(window.innerWidth / 2, window.innerHeight / 2, '+100 XP!');

        // 6. Brief "PLAYER 1" text flash
        const flash = document.createElement('div');
        flash.textContent = '★ KONAMI CODE ★';
        flash.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            font-family: var(--font-pixel); font-size: 20px;
            color: var(--accent-gold); text-shadow: 0 0 20px var(--accent-gold), 2px 2px 0 rgba(0,0,0,0.5);
            z-index: 10001; pointer-events: none;
            animation: v2-xpFloat 2s var(--ease-out) forwards;
        `;
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 2000);

        console.log('[V2 FX] 🎮 KONAMI CODE ACTIVATED! ↑↑↓↓←→←→BA');
    }

    // ══════════════════════════ LOGO EASTER EGG ══════════════════════════
    function initLogoEasterEgg() {
        const logo = document.querySelector('.v2-sidebar-logo img');
        if (!logo) return;

        let clickCount = 0;
        let clickTimer = null;

        logo.addEventListener('click', function () {
            clickCount++;

            if (clickTimer) clearTimeout(clickTimer);
            clickTimer = setTimeout(() => { clickCount = 0; }, 500);

            if (clickCount >= 3) {
                clickCount = 0;
                triggerLogoEasterEgg(logo);
            }
        });
    }

    function triggerLogoEasterEgg(logo) {
        // 1. Spin animation
        logo.classList.add('easter-spin');
        setTimeout(() => logo.classList.remove('easter-spin'), 800);

        // 2. Screen shake (subtle)
        document.body.classList.add('screen-shake');
        setTimeout(() => document.body.classList.remove('screen-shake'), 400);

        // 3. Particle burst from logo position
        const rect = logo.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        spawnParticleBurst(cx, cy, 20);

        // 4. XP reward
        spawnXP(cx, cy - 30, '+50 XP!');

        console.log('[V2 FX] 🌟 Logo easter egg triggered!');
    }

    function spawnParticleBurst(cx, cy, count) {
        const colors = ['#08A4D5', '#fbbf24', '#22d3ee', '#34d399', '#a78bfa', '#f472b6', '#fb923c'];
        for (let i = 0; i < count; i++) {
            const p = document.createElement('div');
            const angle = (Math.PI * 2 * i) / count;
            const distance = 30 + Math.random() * 50;
            const dx = Math.cos(angle) * distance;
            const dy = Math.sin(angle) * distance;
            const color = colors[Math.floor(Math.random() * colors.length)];
            const size = 2 + Math.floor(Math.random() * 3);

            p.style.cssText = `
                position: fixed; left: ${cx}px; top: ${cy}px;
                width: ${size}px; height: ${size}px;
                background: ${color}; border-radius: 1px;
                pointer-events: none; z-index: 10001;
                box-shadow: 0 0 6px ${color};
                transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
                opacity: 1; image-rendering: pixelated;
            `;
            document.body.appendChild(p);

            // Animate outward
            requestAnimationFrame(() => {
                p.style.transform = `translate(${dx}px, ${dy}px) scale(0.3)`;
                p.style.opacity = '0';
            });

            setTimeout(() => p.remove(), 700);
        }
    }

    // ══════════════════════════ XP POPUP SYSTEM ══════════════════════════
    function initXPSystem() {
        // XP on panel switch
        const origSwitch = localStorage.getItem('submaker-v2-active-panel');
        const observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                if (m.type === 'attributes' && m.attributeName === 'class') {
                    const target = m.target;
                    if (target.classList && target.classList.contains('v2-nav-item') && target.classList.contains('active')) {
                        const rect = target.getBoundingClientRect();
                        spawnXP(rect.right + 10, rect.top + rect.height / 2 - 8, '+5 XP');
                    }
                }
            });
        });

        document.querySelectorAll('.v2-nav-item[data-panel]').forEach(nav => {
            observer.observe(nav, { attributes: true, attributeFilter: ['class'] });
        });

        // XP on save (listen for config form submit or save button click)
        const saveBtn = document.getElementById('installButton') || document.querySelector('.v2-btn-primary[id*="save"]');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                const rect = this.getBoundingClientRect();
                setTimeout(() => spawnXP(rect.left + rect.width / 2, rect.top - 10, '+10 XP!'), 300);
            });
        }
    }

    function spawnXP(x, y, text) {
        const el = document.createElement('div');
        el.className = 'v2-xp-popup';
        el.textContent = text;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 1300);
    }

    // ══════════════════════════ NAV FLASH (visual "ding") ══════════════════════════
    function initNavFlash() {
        document.querySelectorAll('.v2-nav-item[data-panel]').forEach(btn => {
            btn.addEventListener('click', function () {
                // Create a brief flash overlay on the nav item
                const flash = document.createElement('div');
                flash.style.cssText = `
                    position: absolute; inset: 0; border-radius: inherit;
                    background: var(--accent); opacity: 0.15;
                    pointer-events: none;
                    animation: v2-fadeIn 0.05s ease forwards;
                `;
                this.style.position = 'relative';
                this.appendChild(flash);
                setTimeout(() => {
                    flash.style.opacity = '0';
                    flash.style.transition = 'opacity 0.3s ease';
                    setTimeout(() => flash.remove(), 300);
                }, 50);
            });
        });
    }

    // Expose for external use
    window.v2SpawnXP = spawnXP;
    window.v2ParticleBurst = spawnParticleBurst;

})();
