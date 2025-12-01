                    : windowSeconds,
                requestedWindowSeconds,
                coverageSeconds,
                coverageTargetPct: targetCoveragePct,
                durationSeconds,
                minWindows: minWindows || null,
                maxWindows: maxWindows || null,
                strategy: preset.plan?.strategy || (fullScan ? 'full' : 'spread'),
                fullScan,
                durationAdjusted,
                modeGroup: primaryMode,
                primaryMode
            };

            if (durationSeconds && plan.windowSeconds && plan.windowSeconds > durationSeconds) {
                plan.windowSeconds = durationSeconds;
            }

            return plan;
        }

        function describeSyncPlan(plan) {
            if (!plan) return '';
            if (plan.fullScan) {
                if (plan.windowSeconds) return \`Full runtime (\${Math.round(plan.windowSeconds)}s) scan\`;
                return 'Full runtime scan';
            }
            const parts = [];
            if (plan.windowCount && plan.windowSeconds) {
                parts.push(\`\${plan.windowCount} x \${Math.round(plan.windowSeconds)}s\`);
            } else if (plan.windowCount) {
                parts.push(\`\${plan.windowCount} windows\`);
            }
            if (plan.durationSeconds && plan.coverageSeconds) {
                const pct = Math.min(100, Math.round((plan.coverageSeconds / plan.durationSeconds) * 100));
                parts.push(\`~\${pct}% of detected runtime\`);
            } else if (plan.coverageTargetPct) {
                parts.push(\`~\${Math.round(plan.coverageTargetPct * 100)}% target coverage\`);
            }
            return parts.join(' • ');
        }

        function offsetSubtitles(srtContent, offsetMs) {
            const subtitles = parseSRT(srtContent);
            let result = '';

            for (const sub of subtitles) {
                const newStart = Math.max(0, sub.start + offsetMs);
                const newEnd = Math.max(newStart, sub.end + offsetMs);

                result += \`\${sub.index}\\n\`;
                result += \`\${formatTime(newStart)} --> \${formatTime(newEnd)}\\n\`;
                result += sub.text;
                result += '\\n';
            }

            return result.trim();
        }

        // Chrome Extension Communication
        let extensionInstalled = false;
        let pingTimer = null;
        let pingAttempts = 0;
        const MAX_PINGS = 5;
        const extDot = document.getElementById('ext-dot');
        const extLabel = document.getElementById('ext-label');
        const extStatus = document.getElementById('ext-status');
        const EXT_INSTALL_URL = 'https://chromewebstore.google.com/detail/submaker-xsync/lpocanpndchjkkpgchefobjionncknjn?authuser=0&hl=en';
        const primaryModeSelect = document.getElementById('primarySyncMode');
        const secondaryModeSelect = document.getElementById('secondarySyncMode');
        const secondaryModeGroup = document.getElementById('secondaryModeGroup');
        const manualOffsetInput = document.getElementById('offsetMs');
        const manualOffsetSlider = document.getElementById('offsetSlider');
        const manualOffsetSummary = document.getElementById('offsetSummary');

        function setAutoSyncAvailability(enabled) {
            const primaryOptions = ['alass', 'ffsubsync', 'vosk-ctc', 'whisper-alass'];
            primaryOptions.forEach((mode) => {
                const opt = primaryModeSelect?.querySelector('option[value="' + mode + '"]');
                if (opt) opt.disabled = !enabled;
            });
            if (secondaryModeSelect) {
                secondaryModeSelect.disabled = !enabled;
            }
        }

        function formatOffsetLabel(ms) {
            if (!Number.isFinite(ms)) return 'On time';
            if (ms === 0) return 'On time';
            const dir = ms > 0 ? 'later' : 'earlier';
            const abs = Math.abs(ms);
            const pretty = abs >= 1000 ? (abs / 1000).toFixed(abs % 1000 === 0 ? 0 : 1) + 's' : abs + 'ms';
            return `${pretty} ${dir}`;
        }

        function setManualOffset(ms) {
            const min = Number(manualOffsetSlider?.min) || -15000;
            const max = Number(manualOffsetSlider?.max) || 15000;
            const clamped = Math.min(max, Math.max(min, Math.round(ms || 0)));
            if (manualOffsetInput) manualOffsetInput.value = clamped;