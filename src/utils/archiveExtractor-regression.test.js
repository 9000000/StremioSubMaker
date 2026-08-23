'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findSubtitleFile } = require('./archiveExtractor');

test('findSubtitleFile accepts an SRT file with a trailing .txt suffix', () => {
    const result = findSubtitleFile([
        'README.txt',
        'The.Matrix-1999-DVDRip.Xvid.srt.txt'
    ]);

    assert.deepEqual(result, {
        filename: 'The.Matrix-1999-DVDRip.Xvid.srt.txt',
        isSrt: true
    });
});

test('findSubtitleFile still rejects arbitrary text files', () => {
    assert.deepEqual(findSubtitleFile(['README.txt', 'release-notes.txt']), {
        filename: null,
        isSrt: false
    });
});

test('season-pack matching includes SRT files with a trailing .txt suffix', () => {
    const result = findSubtitleFile([
        'Show.S01E01.srt.txt',
        'Show.S01E02.srt.txt'
    ], { isSeasonPack: true, season: 1, episode: 2 });

    assert.deepEqual(result, {
        filename: 'Show.S01E02.srt.txt',
        isSrt: true
    });
});
