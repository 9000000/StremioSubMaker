'use strict';

// Keep these limits deliberately generous. They are hard safety ceilings, not
// normal subtitle/model size recommendations, and should not affect ordinary
// season packs or complex ASS/SSA files.
const MIB = 1024 * 1024;

const MAX_REMOTE_SUBTITLE_BYTES = 25 * MIB;
const MAX_ANIME_LIST_BYTES = 128 * MIB;
const MAX_AI_RESPONSE_BYTES = 64 * MIB;

const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
    maxEntries: 2048,
    maxEntryBytes: 64 * MIB,
    maxTotalBytes: 256 * MIB,
    maxCompressionRatio: 1000,
    minRatioBytes: 16 * MIB,
    maxDepth: 4
});

module.exports = {
    MIB,
    MAX_REMOTE_SUBTITLE_BYTES,
    MAX_ANIME_LIST_BYTES,
    MAX_AI_RESPONSE_BYTES,
    DEFAULT_ARCHIVE_LIMITS
};
