const axios = require('axios');
const log = require('../utils/logger');

/**
 * MyAnimeList (MAL) ID mapping service using Jikan API (free, no auth required)
 * Maps MAL anime IDs to IMDB IDs via external links and relations
 */
class MALService {
  constructor() {
    this.baseUrl = 'https://api.jikan.moe/v4';
    this.cache = new Map();
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
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

    // Check cache first
    const cacheKey = `mal_imdb_${numericId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < (cached.expiry || this.cacheExpiry)) {
      log.debug(() => `[MAL] Cache hit for ID ${numericId}`);
      return cached.data;
    }

    // Retry configuration: 2 retries with delays of 2s and 6s (matching other services)
    const retryDelays = [2000, 6000];
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
              this.cache.set(cacheKey, { data: imdbId, timestamp: Date.now() });
              return imdbId;
            }
          }
        }

        // No IMDB link found in external links
        log.debug(() => `[MAL] No IMDB link found in external links for MAL ID ${numericId}`);

        // Cache null result with shorter expiry
        this.cache.set(cacheKey, {
          data: null,
          timestamp: Date.now(),
          expiry: 10 * 60 * 1000 // 10 minutes for failed lookups
        });

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
          // On 429, use longer delay to respect rate limit
          const delay = error.response?.status === 429
            ? Math.max(retryDelays[attempt], 3000)
            : retryDelays[attempt];
          log.debug(() => `[MAL] Retryable error for MAL ID ${numericId} (${error.message}), waiting ${delay}ms before retry ${attempt + 1}/${retryDelays.length}`);
          await this.sleep(delay);
          continue;
        }

        break;
      }
    }

    log.warn(() => `[MAL] Failed to fetch external links for MAL ID ${numericId} after ${retryDelays.length} retries: ${lastError?.message}`);

    // Cache null result with shorter expiry
    this.cache.set(cacheKey, {
      data: null,
      timestamp: Date.now(),
      expiry: 10 * 60 * 1000
    });

    return null;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    log.debug(() => '[MAL] Cache cleared');
  }
}

module.exports = MALService;
