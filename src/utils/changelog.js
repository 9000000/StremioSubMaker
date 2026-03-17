const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_ENTRIES = 15;
const FALLBACK_CONTENT = [
    '### Release Notes',
    '- Release notes are unavailable in this deployment.',
    '- Use the GitHub release link below for the full changelog.'
].join('\n');

function parseChangelogMarkdown(raw, maxEntries = DEFAULT_MAX_ENTRIES) {
    if (typeof raw !== 'string' || !raw.trim()) {
        return [];
    }

    const entries = [];
    const versionRegex = /^## SubMaker v([\d.]+)/gm;
    const positions = [];
    let match;

    while ((match = versionRegex.exec(raw)) !== null) {
        positions.push({
            version: match[1],
            index: match.index,
            headerEnd: match.index + match[0].length
        });
    }

    for (let i = 0; i < Math.min(positions.length, maxEntries); i++) {
        const start = positions[i].headerEnd;
        const end = i + 1 < positions.length ? positions[i + 1].index : raw.length;
        entries.push({
            version: positions[i].version,
            content: raw.slice(start, end).trim()
        });
    }

    return entries;
}

function createFallbackChangelog(currentVersion) {
    return {
        currentVersion,
        entries: [{
            version: currentVersion,
            content: FALLBACK_CONTENT
        }],
        isFallback: true
    };
}

function logMessage(logger, level, message) {
    if (!logger || typeof logger[level] !== 'function') {
        return;
    }

    logger[level](() => message);
}

function loadChangelog(options = {}) {
    const {
        currentVersion,
        baseDir = process.cwd(),
        cwd = process.cwd(),
        maxEntries = DEFAULT_MAX_ENTRIES,
        logger = null,
        fsImpl = fs
    } = options;

    const candidatePaths = Array.from(new Set([
        path.resolve(baseDir, 'CHANGELOG.md'),
        path.resolve(cwd, 'CHANGELOG.md')
    ]));

    let lastError = null;

    for (const candidatePath of candidatePaths) {
        try {
            const raw = fsImpl.readFileSync(candidatePath, 'utf-8');
            const entries = parseChangelogMarkdown(raw, maxEntries);

            if (!entries.length) {
                logMessage(logger, 'warn', `[Changelog] No release entries found in ${candidatePath}. Serving fallback release note.`);
                return createFallbackChangelog(currentVersion);
            }

            return {
                currentVersion,
                entries,
                sourcePath: candidatePath
            };
        } catch (err) {
            lastError = err;
            if (err && err.code !== 'ENOENT') {
                break;
            }
        }
    }

    if (lastError && lastError.code === 'ENOENT') {
        logMessage(
            logger,
            'info',
            `[Changelog] CHANGELOG.md not found in ${candidatePaths.join(', ')}. Serving fallback release note.`
        );
    } else if (lastError) {
        logMessage(logger, 'warn', `[Changelog] Failed to parse CHANGELOG.md: ${lastError.message}`);
    }

    return createFallbackChangelog(currentVersion);
}

module.exports = {
    FALLBACK_CONTENT,
    createFallbackChangelog,
    loadChangelog,
    parseChangelogMarkdown
};