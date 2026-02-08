const axios = require('axios');
const log = require('../utils/logger');
const { getShared, setShared, CACHE_PREFIXES, CACHE_TTLS } = require('../utils/sharedCache');
const { StorageAdapter } = require('../storage');

/**
 * AniDB ID mapping service
 *
 * AniDB does NOT have a public REST API suitable for direct lookups.
 * Instead, we resolve AniDB → IMDB via:
 *   1. Wikidata SPARQL (AniDB property P5646 → IMDB property P345)
 *   2. Cinemeta title search fallback (using AniDB title from Wikidata)
 *
 * Both are free and require no API keys.
 * 
 * MULTI-INSTANCE: Uses Redis-backed shared cache for cross-pod consistency
 */
class AniDBService {
  constructor() {
    // Note: Cache is now Redis-backed via sharedCache utility
  }

  /**
   * Extract numeric ID from AniDB ID string
   * @param {string} anidbId - AniDB ID (e.g., "anidb:1234" or just "1234")
   * @returns {string|null} - Numeric ID
   */
  extractNumericId(anidbId) {
    if (!anidbId) return null;
    const match = String(anidbId).match(/(?:anidb[:-])?(\d+)/i);
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
   * Get IMDB ID from AniDB ID
   * Strategy:
   *   1. Wikidata SPARQL: AniDB ID (P5646) → IMDB ID (P345)
   *   2. Fallback: Wikidata SPARQL to get the title, then Cinemeta title search
   * @param {string} anidbId - AniDB ID (e.g., "anidb:1234")
   * @returns {Promise<string|null>} - IMDB ID if found
   */
  async getImdbId(anidbId) {
    const numericId = this.extractNumericId(anidbId);
    if (!numericId) {
      log.warn(() => `[AniDB] Invalid AniDB ID format: ${anidbId}`);
      return null;
    }

    // Check Redis shared cache first
    const cacheKey = `${CACHE_PREFIXES.ANIDB_IMDB}${numericId}`;
    try {
      const cached = await getShared(cacheKey, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA);
      if (cached !== null) {
        log.debug(() => `[AniDB] Redis cache hit for ID ${numericId}`);
        return cached === 'null' ? null : cached;
      }
    } catch (e) {
      log.debug(() => `[AniDB] Cache lookup failed, proceeding with API: ${e.message}`);
    }

    // Step 1: Try Wikidata SPARQL for direct AniDB → IMDB mapping
    const wikidataResult = await this.queryWikidataAnidbToImdb(numericId);
    if (wikidataResult?.imdbId) {
      log.info(() => `[AniDB] Wikidata found IMDB ${wikidataResult.imdbId} for AniDB ${numericId}`);
      await setShared(cacheKey, wikidataResult.imdbId, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_POSITIVE);
      return wikidataResult.imdbId;
    }

    // Step 2: If Wikidata found the entity but no IMDB, try title-based Cinemeta search
    // Use the title from Wikidata if available, otherwise skip
    const title = wikidataResult?.title;
    if (title) {
      log.debug(() => `[AniDB] No direct IMDB mapping, trying Cinemeta title search for "${title}"`);
      const imdbId = await this.searchCinemetaByTitle(title);
      if (imdbId) {
        log.info(() => `[AniDB] Found IMDB ${imdbId} via Cinemeta title search for AniDB ${numericId} ("${title}")`);
        await setShared(cacheKey, imdbId, StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_POSITIVE);
        return imdbId;
      }
    }

    log.debug(() => `[AniDB] No IMDB ID found for AniDB ${numericId}`);
    try {
      await setShared(cacheKey, 'null', StorageAdapter.CACHE_TYPES.PROVIDER_METADATA, CACHE_TTLS.ANIME_NEGATIVE);
    } catch (_) { }
    return null;
  }

  /**
   * Query Wikidata to get IMDB ID (and optionally title) from AniDB ID
   * Wikidata properties: P5646 = AniDB anime ID, P345 = IMDB ID
   * Also fetches the English label as a fallback title for Cinemeta search
   * @param {string} anidbNumericId - Numeric AniDB ID
   * @returns {Promise<{imdbId: string|null, title: string|null}>}
   */
  async queryWikidataAnidbToImdb(anidbNumericId) {
    // Sanitize: AniDB IDs must be numeric
    if (!/^\d+$/.test(String(anidbNumericId))) {
      log.warn(() => `[AniDB] Invalid AniDB numeric ID for Wikidata lookup: ${anidbNumericId}`);
      return { imdbId: null, title: null };
    }

    const retryDelays = [2000, 6000];
    let lastError = null;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        if (attempt > 0) {
          log.debug(() => `[AniDB] Wikidata retry ${attempt}/${retryDelays.length} for AniDB ${anidbNumericId}`);
        }

        // SPARQL query: find entity with AniDB ID, get IMDB ID and English label
        const sparqlQuery = `
          SELECT ?imdb ?itemLabel WHERE {
            ?item wdt:P5646 "${anidbNumericId}".
            OPTIONAL { ?item wdt:P345 ?imdb. }
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ja". }
          } LIMIT 1
        `.trim().replace(/\s+/g, ' ');

        const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparqlQuery)}&format=json`;

        const response = await axios.get(url, {
          timeout: 8000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'StremioSubMaker/1.0 (subtitle addon; contact via GitHub)'
          }
        });

        const bindings = response?.data?.results?.bindings;
        if (!bindings || bindings.length === 0) {
          log.debug(() => `[AniDB] Wikidata has no entity for AniDB ${anidbNumericId}`);
          return { imdbId: null, title: null };
        }

        const binding = bindings[0];
        const imdbRaw = binding?.imdb?.value || null;
        const title = binding?.itemLabel?.value || null;

        const imdbId = imdbRaw
          ? (imdbRaw.startsWith('tt') ? imdbRaw : `tt${imdbRaw}`)
          : null;

        return { imdbId, title };
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
          const delay = retryDelays[attempt];
          log.debug(() => `[AniDB] Wikidata retryable error (${error.message}), waiting ${delay}ms`);
          await this.sleep(delay);
          continue;
        }

        break;
      }
    }

    log.debug(() => `[AniDB] Wikidata lookup failed for AniDB ${anidbNumericId}: ${lastError?.message}`);
    return { imdbId: null, title: null };
  }

  /**
   * Search Cinemeta by title to find IMDB ID
   * Used as fallback when Wikidata has the entity but no IMDB mapping
   * @param {string} title - Anime title
   * @returns {Promise<string|null>} - IMDB ID if found
   */
  async searchCinemetaByTitle(title) {
    if (!title) return null;

    // Search both series and movies (anime can be either)
    const searchUrls = [
      `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(title)}.json`,
      `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(title)}.json`
    ];

    for (const url of searchUrls) {
      try {
        const response = await axios.get(url, {
          timeout: 10000,
          headers: { 'User-Agent': 'StremioSubMaker/1.0' }
        });

        const metas = response.data?.metas || [];
        if (metas.length === 0) continue;

        const searchLower = title.toLowerCase();

        // Try exact or close match first
        for (const meta of metas) {
          const metaName = meta.name?.toLowerCase();
          if (metaName === searchLower ||
            metaName?.includes(searchLower) ||
            searchLower.includes(metaName)) {
            if (meta.imdb_id) {
              log.debug(() => `[AniDB] Cinemeta match: "${meta.name}" (${meta.imdb_id})`);
              return meta.imdb_id;
            }
          }
        }

        // Fall back to first result
        if (metas[0]?.imdb_id) {
          log.debug(() => `[AniDB] Cinemeta first result: "${metas[0].name}" (${metas[0].imdb_id})`);
          return metas[0].imdb_id;
        }
      } catch (error) {
        log.debug(() => `[AniDB] Cinemeta search failed for "${title}": ${error.message}`);
      }
    }

    return null;
  }

  /**
   * Clear cache - Note: This now only logs since cache is Redis-backed
   */
  clearCache() {
    log.debug(() => '[AniDB] Cache clear requested (Redis-backed cache - clearing not implemented for multi-instance safety)');
  }
}

module.exports = AniDBService;
