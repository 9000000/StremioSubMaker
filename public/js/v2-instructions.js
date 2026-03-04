/* ═══════════════════════════════════════════════════════════
   SubMaker Config V2 — Epic Instructions Modal 🎮✨
   Theme-aware · Animated · Easter eggs
   V2-only: only activates when body.v2 is present
   ═══════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // Only on V2
    if (!document.body.classList.contains('v2')) return;

    function initV2Instructions() {
        var overlay = document.getElementById('instructionsModal');
        if (!overlay) return;

        // Hijack the modal content for V2
        var modal = overlay.querySelector('.modal');
        if (!modal) return;

        // Store original close/gotit handlers (help-modal.js already wired them)
        // We'll replace the inner HTML and re-wire

        modal.innerHTML = buildV2ModalHTML();
        modal.classList.add('v2-instructions-modal');

        // Close handler
        function closeModal() {
            overlay.classList.remove('show');
            overlay.classList.remove('fly-out');
        }

        // Use event delegation on the overlay — survives any innerHTML replacement
        overlay.addEventListener('click', function (e) {
            // Close button (×)
            if (e.target.closest('.v2-instr-close') || e.target.id === 'closeInstructionsBtn') {
                e.stopPropagation();
                closeModal();
                return;
            }
            // Got it button
            if (e.target.closest('.v2-instr-gotit') || e.target.id === 'gotItInstructionsBtn') {
                e.stopPropagation();
                try {
                    var cb = overlay.querySelector('#dontShowInstructions');
                    if (cb && cb.checked) localStorage.setItem('hideConfigInstructions', '1');
                } catch (_) { }
                closeModal();
                return;
            }
            // Background click
            if (e.target === overlay) {
                closeModal();
            }
        });

        // Easter egg: click the logo 5 times
        var logo = modal.querySelector('.v2-instr-logo');
        var clickCount = 0;
        var clickTimer = null;
        if (logo) {
            logo.addEventListener('click', function () {
                clickCount++;
                clearTimeout(clickTimer);
                clickTimer = setTimeout(function () { clickCount = 0; }, 2000);
                if (clickCount >= 5) {
                    clickCount = 0;
                    triggerEasterEgg(modal);
                }
            });
        }

        // Easter egg: type "sub" while modal is open
        var eggBuffer = '';
        document.addEventListener('keydown', function (e) {
            if (!overlay.classList.contains('show')) { eggBuffer = ''; return; }
            if (e.key.length === 1) eggBuffer += e.key.toLowerCase();
            if (eggBuffer.length > 10) eggBuffer = eggBuffer.slice(-10);
            if (eggBuffer.includes('sub')) {
                eggBuffer = '';
                triggerEasterEgg(modal);
            }
        });

        // Stagger-animate steps when modal opens
        var observer = new MutationObserver(function () {
            if (overlay.classList.contains('show')) {
                animateStepsIn(modal);
            }
        });
        observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }

    function buildV2ModalHTML() {
        var steps = [
            { icon: '📡', title: 'Add Subtitle Sources', desc: 'Head to <strong>Sub Providers</strong> and add your API keys for OpenSubtitles, SubSource, SubDL, or other providers.' },
            { icon: '🤖', title: 'Configure AI Provider', desc: 'Go to <strong>AI Providers</strong> and add your Gemini API key. Free keys available at <a href="https://aistudio.google.com/apikey" target="_blank" style="color:var(--accent);">Google AI Studio</a>.' },
            { icon: '🌍', title: 'Select Languages', desc: 'Choose your <strong>source</strong> languages (what you have) and <strong>target</strong> languages (what you want).' },
            { icon: '🚀', title: 'Save & Install', desc: 'Hit <strong>Save & Install</strong> to install the addon in Stremio. That\'s it!' },
            { icon: '🎬', title: 'Use in Stremio', desc: 'Open any movie/show → subtitles list → click a <strong>"Make [Language]"</strong> entry → wait ~30s → reload. Translated!' }
        ];

        var html = '';

        // Header
        html += '<div class="v2-instr-header">';
        html += '  <div class="v2-instr-header-left">';
        html += '    <div class="v2-instr-logo" title="Click me 5 times...">';
        html += '      <img src="/logo.png" alt="SubMaker" width="40" height="40" style="border-radius:8px;image-rendering:pixelated;">';
        html += '    </div>';
        html += '    <div>';
        html += '      <h2 class="v2-instr-title">How to Use SubMaker</h2>';
        html += '      <div class="v2-instr-subtitle">Get translating in under a minute ⚡</div>';
        html += '    </div>';
        html += '  </div>';
        html += '  <button class="v2-instr-close" id="closeInstructionsBtn" aria-label="Close">&times;</button>';
        html += '</div>';

        // Progress bar
        html += '<div class="v2-instr-progress">';
        html += '  <div class="v2-instr-progress-bar"></div>';
        html += '</div>';

        // Steps
        html += '<div class="v2-instr-body">';
        steps.forEach(function (step, i) {
            html += '<div class="v2-instr-step" data-step="' + (i + 1) + '" style="opacity:0;transform:translateY(20px);">';
            html += '  <div class="v2-instr-step-num">' + (i + 1) + '</div>';
            html += '  <div class="v2-instr-step-icon">' + step.icon + '</div>';
            html += '  <div class="v2-instr-step-content">';
            html += '    <div class="v2-instr-step-title">' + step.title + '</div>';
            html += '    <div class="v2-instr-step-desc">' + step.desc + '</div>';
            html += '  </div>';
            html += '</div>';
        });

        // Tips section
        html += '<div class="v2-instr-tips" style="opacity:0;transform:translateY(20px);">';
        html += '  <div class="v2-instr-tips-title">💡 Pro Tips</div>';
        html += '  <div class="v2-instr-tip">Triple-click a subtitle in Stremio to force a fresh re-translation</div>';
        html += '  <div class="v2-instr-tip">Partial translations are delivered in batches — start watching almost instantly!</div>';
        html += '  <div class="v2-instr-tip">For best results, select only 1 source language</div>';
        html += '</div>';

        html += '</div>'; // body

        // Footer
        html += '<div class="v2-instr-footer">';
        html += '  <label class="v2-instr-checkbox"><input type="checkbox" id="dontShowInstructions"><span>Don\'t show again</span></label>';
        html += '  <button class="v2-instr-gotit" id="gotItInstructionsBtn">Got it! 🎮</button>';
        html += '</div>';

        // Easter egg container (hidden)
        html += '<div class="v2-instr-egg" id="v2InstrEgg"></div>';

        return html;
    }

    function animateStepsIn(modal) {
        var items = modal.querySelectorAll('.v2-instr-step, .v2-instr-tips');
        var bar = modal.querySelector('.v2-instr-progress-bar');
        items.forEach(function (el, i) {
            el.style.transition = 'none';
            el.style.opacity = '0';
            el.style.transform = 'translateY(20px)';
            el.offsetHeight; // reflow
            el.style.transition = 'opacity 0.4s ease, transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
            setTimeout(function () {
                el.style.opacity = '1';
                el.style.transform = 'translateY(0)';
            }, 80 + i * 90);
        });

        // Animate progress bar
        if (bar) {
            bar.style.transition = 'none';
            bar.style.width = '0%';
            bar.offsetHeight;
            bar.style.transition = 'width 1.5s cubic-bezier(0.22, 1, 0.36, 1)';
            setTimeout(function () { bar.style.width = '100%'; }, 200);
        }
    }

    function triggerEasterEgg(modal) {
        var egg = modal.querySelector('.v2-instr-egg');
        if (!egg) return;

        // Pixel explosion!
        egg.innerHTML = '';
        egg.style.display = 'block';
        var colors = ['var(--accent)', 'var(--accent-gold)', 'var(--accent-neon)', 'var(--accent-green)', 'var(--accent-pink)', 'var(--accent-purple)'];
        var emojis = ['⭐', '✨', '🎮', '🚀', '🎬', '🤖', '📡', '💫', '🌟', '⚡', '🎯', '🏆'];

        for (var i = 0; i < 30; i++) {
            var p = document.createElement('div');
            p.className = 'v2-instr-egg-particle';
            p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
            p.style.left = (20 + Math.random() * 60) + '%';
            p.style.top = (20 + Math.random() * 60) + '%';
            p.style.setProperty('--dx', (Math.random() * 200 - 100) + 'px');
            p.style.setProperty('--dy', (Math.random() * 200 - 100) + 'px');
            p.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
            p.style.animationDelay = (Math.random() * 0.3) + 's';
            egg.appendChild(p);
        }

        // Shake the modal
        modal.style.animation = 'none';
        modal.offsetHeight;
        modal.style.animation = 'v2-instr-shake 0.6s ease';

        // Flash overlay
        var flash = document.createElement('div');
        flash.className = 'v2-instr-flash';
        modal.appendChild(flash);
        setTimeout(function () { if (flash.parentNode) flash.parentNode.removeChild(flash); }, 600);

        // XP popup
        if (window.v2SpawnXP) {
            var rect = modal.getBoundingClientRect();
            window.v2SpawnXP(rect.left + rect.width / 2, rect.top + 30, '+500 XP 🏆');
        }

        setTimeout(function () {
            egg.style.display = 'none';
            egg.innerHTML = '';
        }, 2000);
    }

    // Inject V2 instructions CSS
    function injectCSS() {
        var style = document.createElement('style');
        style.textContent = [
            /* Modal override for v2 */
            'body.v2 .v2-instructions-modal {',
            '  background: var(--bg-card-solid);',
            '  border: 1px solid var(--border);',
            '  border-radius: var(--radius-xl, 20px);',
            '  max-width: 580px;',
            '  width: 100%;',
            '  max-height: 85vh;',
            '  overflow-y: auto;',
            '  overflow-x: hidden;',
            '  box-shadow: var(--shadow-lg), var(--shadow-glow), 0 0 80px rgba(8,164,213,0.08);',
            '  animation: v2-modalIn 0.3s var(--ease-out);',
            '  position: relative;',
            '}',

            /* Header */
            '.v2-instr-header {',
            '  display: flex;',
            '  align-items: center;',
            '  justify-content: space-between;',
            '  padding: 20px 24px 16px;',
            '  border-bottom: 1px solid var(--border-subtle);',
            '  position: relative;',
            '  overflow: hidden;',
            '}',
            '.v2-instr-header::after {',
            '  content: "";',
            '  position: absolute;',
            '  bottom: -1px;',
            '  left: 0;',
            '  width: 100%;',
            '  height: 2px;',
            '  background: var(--gradient-accent);',
            '  opacity: 0.6;',
            '}',
            '.v2-instr-header-left {',
            '  display: flex;',
            '  align-items: center;',
            '  gap: 12px;',
            '}',
            '.v2-instr-logo {',
            '  cursor: pointer;',
            '  transition: transform 0.2s var(--ease-bounce, ease);',
            '  filter: drop-shadow(0 2px 8px rgba(8,164,213,0.3));',
            '}',
            '.v2-instr-logo:hover {',
            '  transform: scale(1.15) rotate(-5deg);',
            '  filter: drop-shadow(0 4px 16px rgba(8,164,213,0.5));',
            '}',
            '.v2-instr-title {',
            '  font-family: var(--font-pixel, "Press Start 2P", monospace);',
            '  font-size: 11px;',
            '  color: var(--text-primary);',
            '  line-height: 1.4;',
            '}',
            '.v2-instr-subtitle {',
            '  font-size: 0.8rem;',
            '  color: var(--text-secondary);',
            '  margin-top: 2px;',
            '}',
            '.v2-instr-close {',
            '  width: 32px; height: 32px;',
            '  display: flex; align-items: center; justify-content: center;',
            '  font-size: 1.4rem;',
            '  cursor: pointer;',
            '  color: var(--text-secondary);',
            '  border-radius: var(--radius-sm, 8px);',
            '  border: 1px solid transparent;',
            '  background: transparent;',
            '  transition: all 0.15s ease;',
            '}',
            '.v2-instr-close:hover {',
            '  background: var(--bg-card-hover);',
            '  border-color: var(--border);',
            '  color: var(--text-primary);',
            '  transform: rotate(90deg);',
            '}',

            /* Progress bar */
            '.v2-instr-progress {',
            '  height: 3px;',
            '  background: var(--bg-input, rgba(255,255,255,0.05));',
            '  position: relative;',
            '  overflow: hidden;',
            '}',
            '.v2-instr-progress-bar {',
            '  height: 100%;',
            '  width: 0%;',
            '  background: var(--gradient-accent);',
            '  border-radius: 0 3px 3px 0;',
            '  box-shadow: 0 0 10px var(--accent);',
            '  position: relative;',
            '}',
            '.v2-instr-progress-bar::after {',
            '  content: "";',
            '  position: absolute;',
            '  right: 0; top: -2px;',
            '  width: 6px; height: 7px;',
            '  background: var(--accent);',
            '  border-radius: 50%;',
            '  box-shadow: 0 0 12px var(--accent), 0 0 24px var(--accent);',
            '}',

            /* Body */
            '.v2-instr-body {',
            '  padding: 20px 24px;',
            '}',

            /* Steps */
            '.v2-instr-step {',
            '  display: flex;',
            '  align-items: flex-start;',
            '  gap: 14px;',
            '  padding: 14px 16px;',
            '  margin-bottom: 8px;',
            '  border-radius: var(--radius-md, 12px);',
            '  border: 1px solid var(--border-subtle);',
            '  background: var(--bg-input, rgba(255,255,255,0.02));',
            '  transition: all 0.2s ease;',
            '  position: relative;',
            '  overflow: hidden;',
            '}',
            '.v2-instr-step:hover {',
            '  border-color: var(--border-strong);',
            '  background: var(--bg-card-hover, rgba(255,255,255,0.04));',
            '  transform: translateX(4px);',
            '  box-shadow: var(--shadow-sm), 0 0 20px rgba(8,164,213,0.06);',
            '}',
            '.v2-instr-step::before {',
            '  content: "";',
            '  position: absolute;',
            '  left: 0; top: 0; bottom: 0;',
            '  width: 3px;',
            '  background: var(--gradient-accent);',
            '  opacity: 0;',
            '  transition: opacity 0.2s ease;',
            '}',
            '.v2-instr-step:hover::before { opacity: 1; }',

            '.v2-instr-step-num {',
            '  width: 24px; height: 24px;',
            '  display: flex; align-items: center; justify-content: center;',
            '  background: var(--accent-muted, rgba(8,164,213,0.1));',
            '  color: var(--accent);',
            '  font-family: var(--font-pixel, "Press Start 2P", monospace);',
            '  font-size: 9px;',
            '  border-radius: 6px;',
            '  flex-shrink: 0;',
            '  border: 1px solid var(--border);',
            '  margin-top: 2px;',
            '}',
            '.v2-instr-step-icon {',
            '  font-size: 1.3rem;',
            '  flex-shrink: 0;',
            '  margin-top: 1px;',
            '  filter: drop-shadow(0 1px 3px rgba(0,0,0,0.3));',
            '  transition: transform 0.2s var(--ease-bounce, ease);',
            '}',
            '.v2-instr-step:hover .v2-instr-step-icon {',
            '  transform: scale(1.25) rotate(-5deg);',
            '}',
            '.v2-instr-step-content { flex: 1; min-width: 0; }',
            '.v2-instr-step-title {',
            '  font-weight: 700;',
            '  font-size: 0.9rem;',
            '  color: var(--text-primary);',
            '  margin-bottom: 3px;',
            '}',
            '.v2-instr-step-desc {',
            '  font-size: 0.82rem;',
            '  color: var(--text-secondary);',
            '  line-height: 1.5;',
            '}',
            '.v2-instr-step-desc a { color: var(--accent); text-decoration: none; }',
            '.v2-instr-step-desc a:hover { text-decoration: underline; }',

            /* Tips */
            '.v2-instr-tips {',
            '  margin-top: 16px;',
            '  padding: 14px 16px;',
            '  border-radius: var(--radius-md, 12px);',
            '  background: linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(241,201,59,0.03) 100%);',
            '  border: 1px solid rgba(251,191,36,0.15);',
            '}',
            '.v2-instr-tips-title {',
            '  font-weight: 700;',
            '  font-size: 0.85rem;',
            '  color: var(--accent-gold, #f1c93b);',
            '  margin-bottom: 8px;',
            '}',
            '.v2-instr-tip {',
            '  font-size: 0.8rem;',
            '  color: var(--text-secondary);',
            '  padding: 4px 0 4px 16px;',
            '  position: relative;',
            '  line-height: 1.5;',
            '}',
            '.v2-instr-tip::before {',
            '  content: "▸";',
            '  position: absolute;',
            '  left: 0;',
            '  color: var(--accent-gold, #f1c93b);',
            '  font-size: 0.7rem;',
            '  top: 5px;',
            '}',

            /* Footer */
            '.v2-instr-footer {',
            '  display: flex;',
            '  align-items: center;',
            '  justify-content: space-between;',
            '  padding: 14px 24px;',
            '  border-top: 1px solid var(--border-subtle);',
            '}',
            '.v2-instr-checkbox {',
            '  display: flex;',
            '  align-items: center;',
            '  gap: 6px;',
            '  font-size: 0.78rem;',
            '  color: var(--text-tertiary);',
            '  cursor: pointer;',
            '}',
            '.v2-instr-checkbox input { width: 14px; height: 14px; cursor: pointer; }',
            '.v2-instr-gotit {',
            '  padding: 8px 20px;',
            '  background: var(--gradient-accent);',
            '  color: white;',
            '  border: none;',
            '  border-radius: var(--radius-sm, 8px);',
            '  font-weight: 700;',
            '  font-size: 0.85rem;',
            '  cursor: pointer;',
            '  transition: all 0.2s ease;',
            '  box-shadow: var(--shadow-sm), var(--accent-glow);',
            '  position: relative;',
            '  overflow: hidden;',
            '}',
            '.v2-instr-gotit::before {',
            '  content: "";',
            '  position: absolute;',
            '  top: 0; left: -100%;',
            '  width: 100%; height: 100%;',
            '  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);',
            '  animation: v2-shimmer 2.5s ease-in-out infinite;',
            '}',
            '.v2-instr-gotit:hover {',
            '  transform: translateY(-2px);',
            '  box-shadow: var(--shadow-md), var(--accent-glow-strong);',
            '  filter: brightness(1.1);',
            '}',
            '.v2-instr-gotit:active { transform: scale(0.96); }',

            /* Easter egg */
            '.v2-instr-egg {',
            '  position: absolute;',
            '  inset: 0;',
            '  pointer-events: none;',
            '  display: none;',
            '  overflow: hidden;',
            '  z-index: 10;',
            '}',
            '.v2-instr-egg-particle {',
            '  position: absolute;',
            '  font-size: 1.4rem;',
            '  animation: v2-instr-explode 1.2s ease-out forwards;',
            '  pointer-events: none;',
            '}',
            '@keyframes v2-instr-explode {',
            '  0% { transform: translate(0, 0) rotate(0deg) scale(1); opacity: 1; }',
            '  100% {',
            '    transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(0);',
            '    opacity: 0;',
            '  }',
            '}',
            '@keyframes v2-instr-shake {',
            '  0%, 100% { transform: translateX(0) rotate(0); }',
            '  10% { transform: translateX(-4px) rotate(-1deg); }',
            '  20% { transform: translateX(4px) rotate(1deg); }',
            '  30% { transform: translateX(-3px) rotate(-0.5deg); }',
            '  40% { transform: translateX(3px) rotate(0.5deg); }',
            '  50% { transform: translateX(-2px); }',
            '  60% { transform: translateX(2px); }',
            '  70% { transform: translateX(-1px); }',
            '}',

            /* Flash effect */
            '.v2-instr-flash {',
            '  position: absolute;',
            '  inset: 0;',
            '  background: var(--accent);',
            '  opacity: 0;',
            '  pointer-events: none;',
            '  z-index: 9;',
            '  animation: v2-instr-flash-anim 0.6s ease-out;',
            '  border-radius: inherit;',
            '}',
            '@keyframes v2-instr-flash-anim {',
            '  0% { opacity: 0.3; }',
            '  100% { opacity: 0; }',
            '}',

            /* Light theme overrides */
            '[data-theme="light"] .v2-instr-step {',
            '  background: rgba(0,0,0,0.02);',
            '  border-color: rgba(0,0,0,0.08);',
            '}',
            '[data-theme="light"] .v2-instr-step:hover {',
            '  background: rgba(0,0,0,0.04);',
            '  border-color: rgba(0,0,0,0.15);',
            '}',
            '[data-theme="light"] .v2-instr-tips {',
            '  background: linear-gradient(135deg, rgba(251,191,36,0.08) 0%, rgba(241,201,59,0.04) 100%);',
            '  border-color: rgba(251,191,36,0.2);',
            '}',

            /* Blackhole theme overrides */
            '[data-theme="blackhole"] .v2-instr-step-num {',
            '  box-shadow: 0 0 8px rgba(129,140,248,0.2);',
            '}',
            '[data-theme="blackhole"] .v2-instr-step:hover {',
            '  box-shadow: 0 0 20px rgba(129,140,248,0.08), var(--shadow-sm);',
            '}'
        ].join('\n');
        document.head.appendChild(style);
    }

    // Init after partials load
    function waitAndInit() {
        if (window.partialsReady) {
            window.partialsReady.then(function () {
                injectCSS();
                initV2Instructions();
            });
        } else {
            setTimeout(waitAndInit, 50);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitAndInit);
    } else {
        waitAndInit();
    }
})();
