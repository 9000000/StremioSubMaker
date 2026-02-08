const axios = require('axios');
const log = require('../utils/logger');
const { getShared, setShared, CACHE_PREFIXES, CACHE_TTLS } = require('../utils/sharedCache');
const { StorageAdapter } = require('../storage');

/**
 * AniList ID mapping service using AniList GraphQL API (free, no auth required)
 * Maps AniList anime IDs to IMDB IDs via external links or MAL ID cross-reference
 * 
 * MULTI-INSTANCE: Uses Redis-backed shared cache for cross-pod consistency
 */
class AniListService {
  constructor() {
    this.graphqlUrl = 'https://graphql.anilist.co';
    // Note: Cache is now Redis-backed via sharedCache utility
  }

  /**
   * Extract numeric ID from AniList ID string
   * @param {string} anilistId - AniList ID (e.g., "anilist:1234" or just "1234")
   * @returns {string|null} - Numeric ID
   */
  extractNumericId(anilistId) {
    if (!anilistId) return null;
    const match = String(anilistId).match(/(?:anilist[:-])?(\d+)/i);
    return match ? match[1] : null;
  }

  /**
   * Sleep helper for retry delays
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get IMDB ID from AniList ID
   * Strategy: AniList GraphQL → externalLinks for IMDB, or idMal → Jikan fallback
   * @param {string} anilistId - AniList ID (e.g., "anilist:1234")
   * @param {Object} [malService] - Optional MALService instance for MAL ID fallback
   * @returns {Promise<string|null>} - IMDB ID if found
   */
  async getImdbId(anilistId, malService = null) {
    const numericId = this.extractNumericId(anilistId);
    if (!numericId) {
      log.warn(() => `[AniList] Invalid AniList ID format: ${anilistId}`);
      return null;
    }

    // Check Redis shared cache first
    const cacheKey = `${CACHE_PREFIXES.ANILIST_IMDB}${numericId}`;
    try {
      const cached = await getShared(cacheKey, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA);
      if (cached !== null) {
        log.debug(() => `[AniList] Redis cache hit for ID ${numericId}`);
        return cached === 'null' ? null : cached;
      }
    } catch (e) {
      log.debug(() => `[AniList] Cache lookup failed, proceeding with API: ${e.message}`);
    }

    // Retry configuration
    const retryDelays = [2000, 6000];
    let lastError = null;

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          idMal
          externalLinks {
            site
            url
          }
        }
      }
    `;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        if (attempt === 0) {
          log.debug(() => `[AniList] Fetching media info for AniList ID: ${numericId}`);
        } else {
          log.debug(() => `[AniList] Retry ${attempt}/${retryDelays.length} for AniList ID: ${numericId}`);
        }

        const response = await axios.post(this.graphqlUrl, {
          query,
          variables: { id: parseInt(numericId, 10) }
        }, {
          timeout: 10000,
          headers: {
            'User-Agent': 'StremioSubMaker/1.0',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        const media = response.data?.data?.Media;
        if (!media) {
          log.debug(() => `[AniList] No media found for AniList ID ${numericId}`);
          await setShared(cacheKey, 'null', StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_NEGATIVE);
          return null;
        }

        // Check external links for IMDB
        if (media.externalLinks && Array.isArray(media.externalLinks)) {
          for (const link of media.externalLinks) {
            if (link.url && /imdb\.com\/title\/(tt\d+)/i.test(link.url)) {
              const match = link.url.match(/imdb\.com\/title\/(tt\d+)/i);
              if (match && match[1]) {
                const imdbId = match[1];
                log.info(() => `[AniList] Found IMDB ID ${imdbId} for AniList ID ${numericId} via external links`);
                await setShared(cacheKey, imdbId, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_POSITIVE);
                return imdbId;
              }
            }
          }
        }

        // Fallback: use MAL ID if available and MAL service is provided
        if (media.idMal && malService) {
          log.debug(() => `[AniList] No IMDB link found, trying MAL fallback with MAL ID ${media.idMal}`);
          const imdbId = await malService.getImdbId(String(media.idMal));
          if (imdbId) {
            log.info(() => `[AniList] Found IMDB ID ${imdbId} for AniList ID ${numericId} via MAL ${media.idMal}`);
            await setShared(cacheKey, imdbId, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_POSITIVE);
            return imdbId;
          }
        } else if (media.idMal && !malService) {
          log.debug(() => `[AniList] Has MAL ID ${media.idMal} but no MAL service available for fallback`);
        }

        // No IMDB mapping found
        log.debug(() => `[AniList] No IMDB ID found for AniList ID ${numericId}`);
        await setShared(cacheKey, 'null', StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_NEGATIVE);
        return null;
      } catch (error) {
        lastError = error;

        const isRetryable =
          error.response?.status >= 500 ||
          error.response?.status === 429 ||
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          !error.response;

        if (attempt < retryDelays.length && isRetryable) {
          const delay = error.response?.status === 429
            ? Math.max(retryDelays[attempt], 3000)
            : retryDelays[attempt];
          log.debug(() => `[AniList] Retryable error for AniList ID ${numericId} (${error.message}), waiting ${delay}ms before retry ${attempt + 1}/${retryDelays.length}`);
          await this.sleep(delay);
          continue;
        }

        break;
      }
    }

    log.warn(() => `[AniList] Failed to fetch media info for AniList ID ${numericId} after ${retryDelays.length} retries: ${lastError?.message}`);
    try {
      await setShared(cacheKey, 'null', StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_NEGATIVE);
    } catch (_) { }
    return null;
  }

  /**
   * Clear cache - Note: This now only logs since cache is Redis-backed
   */
  clearCache() {
    log.debug(() => '[AniList] Cache clear requested (Redis-backed cache - clearing not implemented for multi-instance safety)');
  }
}

module.exports = AniListService;
