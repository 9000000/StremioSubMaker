const axios = require('axios');
const log = require('../utils/logger');
const { getShared, setShared, CACHE_PREFIXES, CACHE_TTLS } = require('../utils/sharedCache');
const { StorageAdapter } = require('../storage');

/**
 * MyAnimeList (MAL) ID mapping service using Jikan API (free, no auth required)
 * Maps MAL anime IDs to IMDB IDs via external links and relations
 * 
 * Jikan API rate limits: 3 requests/second, 60 requests/minute
 * 
 * MULTI-INSTANCE: Uses Redis-backed shared cache for cross-pod consistency
 */
class MALService {
  constructor() {
    this.baseUrl = 'https://api.jikan.moe/v4';
    // Note: Cache is now Redis-backed via sharedCache utility
  }

  /**
   * Extract numeric ID from MAL ID string
   * @param {string} malId - MAL ID (e.g., "mal:1234" or just "1234")
   * @returns {string|null} - Numeric ID
   */
  extractNumericId(malId) {
    if (!malId) return null;
    const match = String(malId).match(/(?:mal[:-])?(\d+)/i);
    return match ? match[1] : null;
  }

  /**
   * Sleep helper for retry delays and rate limiting
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get IMDB ID from MAL ID
   * Strategy: Jikan /anime/{id}/external → look for IMDB link
   * @param {string} malId - MAL ID (e.g., "mal:1234")
   * @returns {Promise<string|null>} - IMDB ID if found
   */
  async getImdbId(malId) {
    const numericId = this.extractNumericId(malId);
    if (!numericId) {
      log.warn(() => `[MAL] Invalid MAL ID format: ${malId}`);
      return null;
    }

    // Check Redis shared cache first
    const cacheKey = `${CACHE_PREFIXES.MAL_IMDB}${numericId}`;
    try {
      const cached = await getShared(cacheKey, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA);
      if (cached !== null) {
        log.debug(() => `[MAL] Redis cache hit for ID ${numericId}`);
        // Handle cached null values (stored as 'null' string)
        return cached === 'null' ? null : cached;
      }
    } catch (e) {
      log.debug(() => `[MAL] Cache lookup failed, proceeding with API: ${e.message}`);
    }

    // Retry configuration: 2 retries with conservative delays for Jikan rate limits
    const retryDelays = [3000, 6000];
    let lastError = null;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        if (attempt === 0) {
          log.debug(() => `[MAL] Fetching external links for MAL ID: ${numericId}`);
        } else {
          log.debug(() => `[MAL] Retry ${attempt}/${retryDelays.length} for MAL ID: ${numericId}`);
        }

        const response = await axios.get(`${this.baseUrl}/anime/${numericId}/external`, {
          timeout: 10000,
          headers: {
            'User-Agent': 'StremioSubMaker/1.0',
            'Accept': 'application/json'
          }
        });

        const externalLinks = response.data?.data || [];

        // Look for IMDB link in external links
        for (const link of externalLinks) {
          if (link.url && /imdb\.com\/title\/(tt\d+)/i.test(link.url)) {
            const match = link.url.match(/imdb\.com\/title\/(tt\d+)/i);
            if (match && match[1]) {
              const imdbId = match[1];
              log.info(() => `[MAL] Found IMDB ID ${imdbId} for MAL ID ${numericId} via external links`);
              // Cache in Redis with 24h TTL
              await setShared(cacheKey, imdbId, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_POSITIVE);
              return imdbId;
            }
          }
        }

        // No IMDB link found in external links
        log.debug(() => `[MAL] No IMDB link found in external links for MAL ID ${numericId}`);

        // Cache null result with shorter TTL (10 min) to allow retry sooner
        await setShared(cacheKey, 'null', StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_NEGATIVE);

        return null;
      } catch (error) {
        lastError = error;

        // Jikan rate limit is 3 req/s; 429 is retryable
        const isRetryable =
          error.response?.status >= 500 ||
          error.response?.status === 429 ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          !error.response;

        if (attempt < retryDelays.length && isRetryable) {
          // On 429, parse Retry-After header if present, otherwise use longer delay
          let delay = retryDelays[attempt];
          if (error.response?.status === 429) {
            const retryAfter = parseInt(error.response.headers?.['retry-after'], 10);
            if (!isNaN(retryAfter) && retryAfter > 0) {
              // Retry-After is in seconds, add 500ms buffer
              delay = retryAfter * 1000 + 500;
            } else {
              // No Retry-After header, use conservative 4s delay
              delay = Math.max(delay, 4000);
            }
          }
          log.debug(() => `[MAL] Retryable error for MAL ID ${numericId} (${error.message}), waiting ${delay}ms before retry ${attempt + 1}/${retryDelays.length}`);
          await this.sleep(delay);
          continue;
        }

        break;
      }
    }

    log.warn(() => `[MAL] Failed to fetch external links for MAL ID ${numericId} after ${retryDelays.length} retries: ${lastError?.message}`);

    // Cache null result with shorter TTL (10 min) to allow retry sooner
    try {
      await setShared(cacheKey, 'null', StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_NEGATIVE);
    } catch (_) { }

    return null;
  }

  /**
   * Clear cache - Note: This now only logs since cache is Redis-backed
   * For Redis cache clearing, use the storage adapter directly
   */
  clearCache() {
    log.debug(() => '[MAL] Cache clear requested (Redis-backed cache - clearing not implemented for multi-instance safety)');
  }
}

module.exports = MALService;
