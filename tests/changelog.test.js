const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { FALLBACK_CONTENT, loadChangelog, parseChangelogMarkdown } = require('../src/utils/changelog');

test('parseChangelogMarkdown returns the newest release entries in order', () => {
    const raw = [
        '# Changelog',
        '',
        '## SubMaker v1.4.76',
        '### Improvements',
        '- Fixed Docker changelog packaging.',
        '',
        '## SubMaker v1.4.75',
        '### Bug Fixes',
        '- Fixed parser edge case.'
    ].join('\n');

    assert.deepEqual(parseChangelogMarkdown(raw, 2), [
        {
            version: '1.4.76',
            content: '### Improvements\n- Fixed Docker changelog packaging.'
        },
        {
            version: '1.4.75',
            content: '### Bug Fixes\n- Fixed parser edge case.'
        }
    ]);
});

test('loadChangelog falls back cleanly when CHANGELOG.md is missing', () => {
    const messages = { info: [], warn: [] };
    const missingFs = {
        readFileSync() {
            const err = new Error("ENOENT: no such file or directory, open 'CHANGELOG.md'");
            err.code = 'ENOENT';
            throw err;
        }
    };
    const logger = {
        info(factory) {
            messages.info.push(typeof factory === 'function' ? factory() : factory);
        },
        warn(factory) {
            messages.warn.push(typeof factory === 'function' ? factory() : factory);
        }
    };

    const changelog = loadChangelog({
        currentVersion: '1.4.76',
        baseDir: '/app',
        cwd: '/workdir',
        fsImpl: missingFs,
        logger
    });

    assert.equal(changelog.currentVersion, '1.4.76');
    assert.equal(changelog.isFallback, true);
    assert.deepEqual(changelog.entries, [{
        version: '1.4.76',
        content: FALLBACK_CONTENT
    }]);
    assert.equal(messages.warn.length, 0);
    assert.equal(messages.info.length, 1);
    assert.match(messages.info[0], /CHANGELOG\.md not found/i);
});

test('loadChangelog retries from cwd when the base directory copy is missing', () => {
    const basePath = path.resolve('/app', 'CHANGELOG.md');
    const cwdPath = path.resolve('/workdir', 'CHANGELOG.md');
    const readCalls = [];
    const fakeFs = {
        readFileSync(filePath) {
            readCalls.push(filePath);
            if (filePath === basePath) {
                const err = new Error(`ENOENT: no such file or directory, open '${basePath}'`);
                err.code = 'ENOENT';
                throw err;
            }

            return [
                '# Changelog',
                '',
                '## SubMaker v1.4.76',
                '- Loaded from cwd fallback.'
            ].join('\n');
        }
    };

    const changelog = loadChangelog({
        currentVersion: '1.4.76',
        baseDir: '/app',
        cwd: '/workdir',
        fsImpl: fakeFs
    });

    assert.equal(changelog.entries.length, 1);
    assert.equal(changelog.entries[0].version, '1.4.76');
    assert.match(changelog.entries[0].content, /Loaded from cwd fallback\./);
    assert.deepEqual(readCalls, [basePath, cwdPath]);
});
