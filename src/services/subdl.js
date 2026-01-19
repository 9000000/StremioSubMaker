const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { appendHiddenInformationalNote } = require('../utils/subtitle');
const { redactSensitiveData } = require('../utils/logger');
const log = require('../utils/logger');
const { detectArchiveType, extractSubtitleFromArchive, isArchive, createEpisodeNotFoundSubtitle, createZipTooLargeSubtitle } = require('../utils/archiveExtractor');
const { analyzeResponseContent, createInvalidResponseSubtitle } = require('../utils/responseAnalyzer');


const SUBDL_API_URL = 'https://api.subdl.com/api/v1';
const USER_AGENT = 'StremioSubtitleTranslator v1.0';
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // hard cap for ZIP downloads (~25MB) to avoid huge packs

class SubDLService {
  // Static/singleton axios client - shared across all instances for connection reuse
  static client = axios.create({
    baseURL: SUBDL_API_URL,
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br'
    },
    httpAgent,
    httpsAgent,
    lookup: dnsLookup,
    timeout: 12000,
    maxRedirects: 5,
    decompress: true
  });

  constructor(apiKey = null) {
    this.apiKey = apiKey;

    // Use static client for all instances (connection pooling optimization)
    this.client = SubDLService.client;

    if (this.apiKey && this.apiKey.trim() !== '') {
      log.debug(() => '[SubDL] Using API key for requests');
    } else {
      log.debug(() => '[SubDL] No API key provided');
    }
  }

  /**
   * Search for subtitles using SubDL API
   * @param {Object} params - Search parameters
   * @param {string} params.imdb_id - IMDB ID (with 'tt' prefix)
   * @param {string} params.type - 'movie' or 'episode'
   * @param {number} params.season - Season number (for episodes)
   * @param {number} params.episode - Episode number (for episodes)
   * @param {Array<string>} params.languages - Array of ISO-639-2 language codes
   * @returns {Promise<Array>} - Array of subtitle objects
   */
  async searchSubtitles(params) {
    try {
      // Check if API key is provided
      if (!this.apiKey || this.apiKey.trim() === '') {
        log.error(() => '[SubDL] API key is required for SubDL API');
        log.error(() => '[SubDL] Please get a free API key from https://subdl.com');
        return [];
      }

      const { imdb_id, type, season, episode, languages, providerTimeout } = params;

      // SubDL requires IMDB ID - skip if not available (e.g., anime with Kitsu IDs)
      if (!imdb_id || imdb_id === 'undefined') {
        log.debug(() => '[SubDL] No IMDB ID available, skipping search');
        return [];
      }

      // Convert ISO-639-2 codes to SubDL format (uppercase codes)
      // SubDL uses uppercase 2-letter codes with special cases like BR_PT
      const subdlLanguageMap = {
        'eng': 'EN', 'spa': 'ES', 'spn': 'ES', 'fre': 'FR', 'fra': 'FR', 'ger': 'DE', 'deu': 'DE',
        'por': 'PT', 'pob': 'BR_PT', 'pt-br': 'BR_PT', 'ptbr': 'BR_PT',
        'ita': 'IT', 'rus': 'RU', 'jpn': 'JA', 'chi': 'ZH', 'zho': 'ZH',
        'kor': 'KO', 'ara': 'AR', 'dut': 'NL', 'nld': 'NL', 'pol': 'PL',
        'tur': 'TR', 'swe': 'SV', 'nor': 'NO', 'dan': 'DA', 'fin': 'FI',
        'gre': 'EL', 'ell': 'EL', 'heb': 'HE', 'hin': 'HI', 'cze': 'CS',
        'ces': 'CS', 'hun': 'HU', 'rum': 'RO', 'ron': 'RO', 'tha': 'TH',
        'vie': 'VI', 'ind': 'ID', 'ukr': 'UK', 'bul': 'BG', 'hrv': 'HR',
        'srp': 'SR', 'slo': 'SK', 'slk': 'SK', 'slv': 'SL', 'est': 'ET',
        'lav': 'LV', 'lit': 'LT', 'per': 'FA', 'fas': 'FA', 'ben': 'BN',
        'cat': 'CA', 'baq': 'EU', 'eus': 'EU', 'glg': 'GL', 'bos': 'BS',
        'mac': 'MK', 'mkd': 'MK', 'alb': 'SQ', 'sqi': 'SQ', 'bel': 'BE',
        'aze': 'AZ', 'geo': 'KA', 'kat': 'KA', 'mal': 'ML', 'tam': 'TA',
        'tel': 'TE', 'urd': 'UR', 'may': 'MS', 'msa': 'MS', 'tgl': 'TL',
        'ice': 'IS', 'isl': 'IS', 'kur': 'KU'
      };

      const convertedLanguages = [...new Set(languages.map(lang => {
        const lower = lang.toLowerCase().trim();

        // Check SubDL mapping first
        if (subdlLanguageMap[lower]) {
          return subdlLanguageMap[lower];
        }

        // Try ISO-639-1 conversion then uppercase
        const iso1Code = toISO6391(lang);
        if (iso1Code && iso1Code !== 'pb') {
          return iso1Code.toUpperCase();
        }

        // Fallback: uppercase first 2 letters
        return lang.substring(0, 2).toUpperCase();
      }))];

      log.debug(() => `[SubDL] Converted languages: ${languages.join(',')} -> ${convertedLanguages.join(',')}`);

      // Build query parameters for SubDL API
      // NOTE: Do NOT add releases=1 or hi=1 here!
      // Although the API docs say they should just add extra fields, in practice
      // they cause the API to return significantly fewer results (filters to only
      // entries with these fields populated). Tested: 5 results with vs 30 without.
      const queryParams = {
        api_key: this.apiKey,
        imdb_id: imdb_id, // SubDL accepts 'tt' prefix
        type: type, // 'movie' or 'tv'
        subs_per_page: 30 // Get maximum results for better ranking (max is 30)
      };

      // Only add languages parameter if languages are specified (for "just fetch" mode)
      if (convertedLanguages.length > 0) {
        queryParams.languages = convertedLanguages.join(',');
      }

      // For TV shows and anime episodes, add season and episode parameters
      if ((type === 'episode' || type === 'anime-episode') && episode) {
        queryParams.type = 'tv';
        // Default to season 1 if not specified (common for anime)
        queryParams.season_number = season || 1;
        queryParams.episode_number = episode;
        // NOTE: Do NOT add full_season=1 here! 
        // According to SubDL API docs, full_season=1 means "only return full season subtitles" (filters to season packs only).
        // Without it, the API returns episode-specific subtitles which is what we want.
        // Season packs are still detected via filename pattern matching in the post-processing step below.
      }

      log.debug(() => ['[SubDL] Searching with params:', JSON.stringify(redactSensitiveData(queryParams))]);

      // Use providerTimeout from config if provided, otherwise use client default
      const requestConfig = { params: queryParams };
      if (providerTimeout) requestConfig.timeout = providerTimeout;
      const response = await this.client.get('/subtitles', requestConfig);

      if (!response.data || response.data.status !== true || !response.data.subtitles || response.data.subtitles.length === 0) {
        log.debug(() => '[SubDL] No subtitles found in response');
        return [];
      }

      let subtitles = response.data.subtitles.map(sub => {

        const originalLang = sub.lang || 'en';
        const normalizedLang = this.normalizeLanguageCode(originalLang);

        // SubDL provides IDs in the URL field: /subtitle/3028156-3032428.zip
        // Extract sd_id and subtitle_id from the URL
        let sdId = null;
        let subtitleId = null;

        if (sub.url) {
          // Parse URL like "/subtitle/3028156-3032428.zip"
          const urlMatch = sub.url.match(/\/subtitle\/(\d+)-(\d+)\.zip/);
          if (urlMatch) {
            sdId = urlMatch[1];
            subtitleId = urlMatch[2];
          }
        }

        const fileId = `subdl_${sdId}_${subtitleId}`;

        // Use download count from API, or 0 if not provided
        const downloadCount = parseInt(sub.download_count);
        const downloads = (!isNaN(downloadCount) && downloadCount > 0) ? downloadCount : 0;

        // Parse releases array from SubDL API (when releases=1 is set)
        // This provides all compatible release names for better matching
        const releases = Array.isArray(sub.releases) ? sub.releases : [];

        return {
          id: fileId,
          language: originalLang,
          languageCode: normalizedLang,
          name: sub.release_name || sub.name || 'Unknown',
          downloads: downloads,
          rating: parseFloat(sub.rating) || 0,
          uploadDate: sub.upload_date || sub.created_at,
          format: 'srt',
          fileId: fileId,
          downloadLink: sub.url, // SubDL provides direct download link
          hearing_impaired: sub.hi === 1 || false,
          foreign_parts_only: false,
          machine_translated: false,
          uploader: sub.author || 'Unknown',
          provider: 'subdl',
          // Store SubDL-specific IDs for download
          subdl_id: sdId,
          subtitles_id: subtitleId,
          // Store releases array for enhanced ranking
          releases: releases
        };
      });

      // CRITICAL: Filter out wrong episodes for TV shows and anime
      // SubDL API may return other episodes despite episode_number parameter
      if ((type === 'episode' || type === 'anime-episode') && season && episode) {
        const beforeCount = subtitles.length;

        subtitles = subtitles.filter(sub => {
          // Check all available names (primary + releases array)
          const namesToCheck = [sub.name, ...(sub.releases || [])];

          // Check for season pack patterns (season without specific episode)
          const seasonPackPatterns = [
            new RegExp(`(?:complete|full|entire)?\\s*(?:season|s)\\s*0*${season}(?:\\s+(?:complete|full|pack))?(?!.*e0*\\d)`, 'i'),
            new RegExp(`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+season(?!.*episode)`, 'i'),
            new RegExp(`s0*${season}\\s*(?:complete|full|pack)`, 'i')
          ];

          // Anime-specific season pack patterns (often don't include season numbers)
          const animeSeasonPackPatterns = [
            /(?:complete|batch|full(?:\s+series)?|\d{1,2}\s*[-~]\s*\d{1,2})/i,
            /\[(?:batch|complete|full)\]/i,
            /(?:episode\s*)?(?:01|001)\s*[-~]\s*(?:\d{2}|\d{3})/i  // 01-12, 001-024
          ];

          // Check if any name matches season pack pattern
          for (const name of namesToCheck) {
            if (!name) continue;
            const nameLower = name.toLowerCase();

            let isSeasonPack = false;

            if (type === 'anime-episode') {
              // For anime, use anime-specific patterns
              isSeasonPack = animeSeasonPackPatterns.some(pattern => pattern.test(nameLower)) &&
                !/(?:^|[^0-9])0*${episode}(?:v\d+)?(?:[^0-9]|$)/.test(nameLower);
            } else {
              // For regular TV shows, use season-based patterns
              isSeasonPack = seasonPackPatterns.some(pattern => pattern.test(nameLower)) &&
                !/s0*\d+e0*\d+|\d+x\d+|episode\s*\d+|ep\s*\d+/i.test(nameLower);
            }

            if (isSeasonPack) {
              // Mark as season pack and include it
              sub.is_season_pack = true;
              sub.season_pack_season = season;
              sub.season_pack_episode = episode;

              // Encode season/episode info in fileId for download extraction
              const originalFileId = sub.fileId || sub.id;
              sub.fileId = `${originalFileId}_seasonpack_s${season}e${episode}`;
              sub.id = sub.fileId;

              log.debug(() => `[SubDL] Detected season pack: ${sub.name}`);
              return true;
            }
          }

          for (const name of namesToCheck) {
            if (!name) continue;

            const nameLower = name.toLowerCase();

            // Season/Episode pattern matching
            // Patterns: S02E03, s02e03, 2x03, S02.E03, Season 2 Episode 3
            const seasonEpisodePatterns = [
              new RegExp(`s0*${season}e0*${episode}\\b`, 'i'),              // S02E03, s02e03
              new RegExp(`\\b${season}x0*${episode}\\b`, 'i'),              // 2x03
              new RegExp(`s0*${season}[\\s._-]*x[\\s._-]*e?0*${episode}\\b`, 'i'), // S02xE03, S02x3
              new RegExp(`\\b0*${season}[\\s._-]*x[\\s._-]*e?0*${episode}\\b`, 'i'), // 02xE03, 2xE03
              new RegExp(`s0*${season}\\.e0*${episode}\\b`, 'i'),           // S02.E03
              new RegExp(`season\\s*0*${season}.*episode\\s*0*${episode}\\b`, 'i')  // Season 2 Episode 3
            ];

            // If ANY name matches the correct episode, keep this subtitle
            if (seasonEpisodePatterns.some(pattern => pattern.test(nameLower))) {
              return true;
            }
          }

          // Check if subtitle has a DIFFERENT episode number (wrong episode)
          // IMPORTANT: Only check the PRIMARY subtitle name here, NOT the releases array!
          // The 'releases' array from SubDL contains episode-specific release names that
          // the season pack is compatible with (e.g., S01E06, S01E07 filenames), which
          // doesn't mean the subtitle itself is only for that episode. Using releases
          // for negative filtering causes false positives with season packs.
          const primaryName = sub.name || '';
          const primaryNameLower = primaryName.toLowerCase();

          // Extract season/episode from the PRIMARY subtitle name only
          const episodeMatch = primaryNameLower.match(/s0*(\d+)e0*(\d+)|(\d+)x0*(\d+)/i);
          if (episodeMatch) {
            const subSeason = parseInt(episodeMatch[1] || episodeMatch[3]);
            const subEpisode = parseInt(episodeMatch[2] || episodeMatch[4]);

            // If the primary name explicitly mentions a different episode, filter it out
            if (subSeason === season && subEpisode !== episode) {
              return false; // Wrong episode - exclude
            }
          }

          // No episode info found in any name - keep it (might be generic subtitle)
          // The ranking algorithm will handle these with lower scores
          return true;
        });

        const filteredCount = beforeCount - subtitles.length;
        const seasonPackCount = subtitles.filter(s => s.is_season_pack).length;
        if (filteredCount > 0) {
          log.debug(() => `[SubDL] Filtered out ${filteredCount} wrong episode subtitles (requested: S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')})`);
        }
        if (seasonPackCount > 0) {
          log.debug(() => `[SubDL] Included ${seasonPackCount} season pack subtitles`);
        }
      }

      // Limit to 14 results per language to control response size
      const MAX_RESULTS_PER_LANGUAGE = 14;
      const groupedByLanguage = {};

      for (const sub of subtitles) {
        const lang = sub.languageCode || 'unknown';
        if (!groupedByLanguage[lang]) {
          groupedByLanguage[lang] = [];
        }
        if (groupedByLanguage[lang].length < MAX_RESULTS_PER_LANGUAGE) {
          groupedByLanguage[lang].push(sub);
        }
      }

      const limitedSubtitles = Object.values(groupedByLanguage).flat();
      return limitedSubtitles;

    } catch (error) {
      return handleSearchError(error, 'SubDL');
    }
  }

  /**
   * Download subtitle content
   * @param {string} fileId - File ID from search results (format: subdl_<sd_id>_<subtitles_id> or subdl_<sd_id>_<subtitles_id>_seasonpack_s<season>e<episode>)
   * @param {string} subdl_id - SubDL subtitle ID
   * @param {string} subtitles_id - SubDL subtitle file ID
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId, options = {}) {
    // Support legacy call pattern: downloadSubtitle(fileId, subdl_id, subtitles_id)
    // New pattern: downloadSubtitle(fileId, { timeout })
    let subdl_id = null;
    let subtitles_id = null;
    let timeout = options?.timeout || 12000; // Default 12s

    // Handle legacy call pattern where second arg is subdl_id string
    if (typeof options === 'string') {
      subdl_id = options;
      subtitles_id = arguments[2] || null;
      timeout = 12000;
    }
    try {
      log.debug(() => ['[SubDL] Downloading subtitle:', fileId]);

      // Check if this is a season pack download
      let isSeasonPack = false;
      let seasonPackSeason = null;
      let seasonPackEpisode = null;

      // Parse the fileId to extract subdl_id and subtitles_id if not provided
      if (!subdl_id || !subtitles_id) {
        const parts = fileId.split('_');
        if (parts.length >= 3 && parts[0] === 'subdl') {
          subdl_id = parts[1];
          subtitles_id = parts[2];

          // Check for season pack format: subdl_<sd_id>_<subtitles_id>_seasonpack_s<season>e<episode>
          if (parts.length >= 5 && parts[3] === 'seasonpack') {
            isSeasonPack = true;
            // Parse s<season>e<episode> from parts[4]
            const match = parts[4].match(/s(\d+)e(\d+)/i);
            if (match) {
              seasonPackSeason = parseInt(match[1]);
              seasonPackEpisode = parseInt(match[2]);
              log.debug(() => `[SubDL] Season pack download requested: S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')}`);
            }
          }
        } else {
          throw new Error('Invalid SubDL file ID format');
        }
      }


      // Construct download URL according to SubDL API documentation
      // Format: https://dl.subdl.com/subtitle/<sd_id>-<subtitles_id>.zip
      const downloadUrl = `https://dl.subdl.com/subtitle/${subdl_id}-${subtitles_id}.zip`;

      log.debug(() => ['[SubDL] Download URL:', downloadUrl]);

      // Download the subtitle file (it's a ZIP file)
      const subtitleResponse = await this.client.get(downloadUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': USER_AGENT
        },
        timeout: timeout // Use configurable timeout
      });

      log.debug(() => ['[SubDL] Response status:', subtitleResponse.status]);
      log.debug(() => ['[SubDL] Response Content-Type:', subtitleResponse.headers['content-type']]);
      log.debug(() => ['[SubDL] Response size:', subtitleResponse.data.length, 'bytes']);

      // Validate that we received binary data (not HTML error page)
      if (!subtitleResponse.data || subtitleResponse.data.length === 0) {
        throw new Error('Downloaded file is empty');
      }

      // Analyze response content to detect HTML error pages, Cloudflare blocks, etc.
      const responseBuffer = Buffer.isBuffer(subtitleResponse.data) ? subtitleResponse.data : Buffer.from(subtitleResponse.data);
      const contentAnalysis = analyzeResponseContent(responseBuffer);

      // Check for valid archive signature (ZIP or RAR)
      const archiveType = detectArchiveType(responseBuffer);
      if (!archiveType) {
        // Not a valid archive - provide user-friendly error message
        log.error(() => `[SubDL] Response is not a valid archive. Content analysis: ${contentAnalysis.type} - ${contentAnalysis.hint}`);
        if (responseBuffer.length > 0 && responseBuffer.length < 500) {
          log.debug(() => ['[SubDL] Response preview:', responseBuffer.toString('utf8', 0, Math.min(200, responseBuffer.length))]);
        } else {
          log.debug(() => ['[SubDL] First 20 bytes:', Array.from(responseBuffer.slice(0, 20)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')]);
        }
        return createInvalidResponseSubtitle('SubDL', contentAnalysis, responseBuffer.length);
      }

      log.debug(() => `[SubDL] Detected ${archiveType.toUpperCase()} archive`);

      // Use the centralized archive extractor that handles both ZIP and RAR
      return await extractSubtitleFromArchive(responseBuffer, {
        providerName: 'SubDL',
        maxBytes: MAX_ZIP_BYTES,
        isSeasonPack: isSeasonPack,
        season: seasonPackSeason,
        episode: seasonPackEpisode
      });

    } catch (error) {
      handleDownloadError(error, 'SubDL');
    }
  }

  /**
   * Normalize language code to ISO-639-2 for Stremio
   * @param {string} language - Language code or name from SubDL
   * @returns {string} - ISO-639-2 language code (3-letter)
   */
  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    // Map SubDL language names to ISO-639-2 codes
    const languageNameMap = {
      'english': 'eng',
      'spanish': 'spa',
      'french': 'fre',
      'german': 'ger',
      'italian': 'ita',
      'portuguese': 'por',
      'portuguese (brazil)': 'pob',
      'portuguese-brazilian': 'pob',
      'russian': 'rus',
      'japanese': 'jpn',
      'chinese': 'chi',
      'korean': 'kor',
      'arabic': 'ara',
      'dutch': 'dut',
      'polish': 'pol',
      'turkish': 'tur',
      'swedish': 'swe',
      'norwegian': 'nor',
      'danish': 'dan',
      'finnish': 'fin',
      'greek': 'gre',
      'hebrew': 'heb',
      'hindi': 'hin',
      'czech': 'cze',
      'hungarian': 'hun',
      'romanian': 'rum',
      'thai': 'tha',
      'vietnamese': 'vie',
      'indonesian': 'ind',
      'malay': 'may',
      'ukrainian': 'ukr',
      'bulgarian': 'bul',
      'croatian': 'hrv',
      'serbian': 'srp',
      'serbian (latin)': 'srp',
      'serbian (cyrillic)': 'srp',
      'serbian latin': 'srp',
      'serbian cyrillic': 'srp',
      'slovak': 'slo',
      'slovenian': 'slv',
      'estonian': 'est',
      'latvian': 'lav',
      'lithuanian': 'lit',
      'farsi': 'per',
      'persian': 'per',
      'bengali': 'ben',
      'catalan': 'cat',
      'basque': 'baq',
      'galician': 'glg'
    };

    // Check if it's a language name
    if (languageNameMap[lower]) {
      return languageNameMap[lower];
    }

    // Handle special cases for Portuguese Brazilian
    if (lower.includes('portuguese') && (lower.includes('brazil') || lower.includes('br'))) {
      return 'pob';
    }
    if (lower === 'brazilian' || lower === 'pt-br' || lower === 'ptbr') {
      return 'pob';
    }

    // If it's already 3 letters, assume it's ISO-639-2
    if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
      return lower;
    }

    // If it's 2 letters, convert from ISO-639-1 to ISO-639-2
    if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2;
      }
    }

    // Unknown language
    log.warn(() => `[SubDL] Unknown language format: "${language}", filtering out`);
    return null;
  }
}

module.exports = SubDLService;
