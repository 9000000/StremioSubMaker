/**
 * Download Cache for Subtitle Files
 *
 * Shared LRU cache for downloaded subtitle content to prevent repeated downloads
 * of the same subtitle files from providers. Used by both direct download routes
 * and translation flow.
 *
 * Environment variables:
 * - DISABLE_DOWNLOAD_CACHE=true: Disable the download cache entirely
 */

const { LRUCache } = require('lru-cache');
const log = require('./logger');

// Check if download cache is disabled via environment variable
const CACHE_DISABLED = process.env.DISABLE_DOWNLOAD_CACHE === 'true';

// Performance: LRU cache for downloaded subtitle files to prevent repeated downloads
// Caches actual subtitle file content after download from providers
// This prevents wasting bandwidth and API quota when users click the same subtitle multiple times
const subtitleDownloadCache = CACHE_DISABLED ? null : new LRUCache({
    max: 5000, // Max 5000 downloaded subtitles cached
    ttl: 1000 * 60 * 10, // 10 minute TTL (short-term cache for active browsing)
    updateAgeOnGet: true, // Extend TTL on access (if user keeps selecting same subtitle)
    maxSize: 500 * 1024 * 1024, // 500MB total cache size limit
    sizeCalculation: (value) => value ? value.length : 0, // Calculate size based on subtitle content length
    // LRU automatically evicts oldest (least recently used) entries when limits are reached
});

// Log once at startup if cache is disabled
if (CACHE_DISABLED) {
    log.info(() => '[Download Cache] DISABLED via DISABLE_DOWNLOAD_CACHE=true');
}

/**
 * Get cached subtitle content if available
 * @param {string} fileId - Subtitle file ID
 * @returns {string|undefined} Cached content or undefined if not in cache
 */
function getCached(fileId) {
    if (CACHE_DISABLED || !subtitleDownloadCache) {
        return undefined;
    }
    const cacheKey = `download:${fileId}`;
    return subtitleDownloadCache.get(cacheKey);
}

/**
 * Save subtitle content to cache
 * @param {string} fileId - Subtitle file ID
 * @param {string} content - Subtitle content
 * @returns {boolean} True if saved successfully
 */
function saveCached(fileId, content) {
    if (CACHE_DISABLED || !subtitleDownloadCache) {
        return false;
    }
    if (!content || typeof content !== 'string' || content.length === 0) {
        log.warn(() => `[Download Cache] Cannot save invalid content for ${fileId}`);
        return false;
    }

    const cacheKey = `download:${fileId}`;
    subtitleDownloadCache.set(cacheKey, content);

    const cacheStats = {
        size: subtitleDownloadCache.size,
        max: subtitleDownloadCache.max,
        calculatedSize: subtitleDownloadCache.calculatedSize,
        maxSize: subtitleDownloadCache.maxSize,
        sizeMB: (subtitleDownloadCache.calculatedSize / (1024 * 1024)).toFixed(2),
        maxSizeMB: (subtitleDownloadCache.maxSize / (1024 * 1024)).toFixed(0)
    };
    log.debug(() => `[Download Cache] SAVED ${fileId} (${content.length} bytes) - Cache: ${cacheStats.size}/${cacheStats.max} entries, ${cacheStats.sizeMB}/${cacheStats.maxSizeMB}MB`);

    return true;
}

/**
 * Get cache statistics
 * @returns {Object} Cache stats
 */
function getCacheStats() {
    if (CACHE_DISABLED || !subtitleDownloadCache) {
        return {
            size: 0,
            max: 0,
            calculatedSize: 0,
            maxSize: 0,
            sizeMB: '0.00',
            maxSizeMB: '0',
            disabled: true
        };
    }
    return {
        size: subtitleDownloadCache.size,
        max: subtitleDownloadCache.max,
        calculatedSize: subtitleDownloadCache.calculatedSize,
        maxSize: subtitleDownloadCache.maxSize,
        sizeMB: (subtitleDownloadCache.calculatedSize / (1024 * 1024)).toFixed(2),
        maxSizeMB: (subtitleDownloadCache.maxSize / (1024 * 1024)).toFixed(0)
    };
}

/**
 * Check if the download cache is enabled
 * @returns {boolean} True if cache is enabled
 */
function isEnabled() {
    return !CACHE_DISABLED;
}

module.exports = {
    subtitleDownloadCache,
    getCached,
    saveCached,
    getCacheStats,
    isEnabled
};
