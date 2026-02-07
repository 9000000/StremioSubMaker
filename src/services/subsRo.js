/**
 * Subs.ro API Integration
 * 
 * Subs.ro is a Romanian subtitle database with a REST API access.
 * Primarily focuses on Romanian subtitles but supports multiple languages.
 * 
 * API Version: 1.0
 * API Docs: https://subs.ro/api
 * OpenAPI Spec: https://subs.ro/apiv10-openapispecyaml
 * 
 * Features:
 * - Supports search by IMDB ID, TMDB ID, title, or release name
 * - Language filtering (ro, en, ita, fra, ger, ung, gre, por, spa, alt)
 * - Direct subtitle download (returns ZIP archives)
 * - Daily quota limits with API key
 * 
 * Authentication:
 * - Requires API key (generated in user profile at subs.ro)
 * - API key sent via X-Subs-Api-Key header or ?apiKey= query param
 */

const axios = require('axios');
const { toISO6391 } = require('../utils/languages');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { appendHiddenInformationalNote } = require('../utils/subtitle');
const log = require('../utils/logger');
const { version } = require('../utils/version');
const { sanitizeApiKeyForHeader } = require('../utils/security');
const { detectArchiveType, extractSubtitleFromArchive, isArchive, createEpisodeNotFoundSubtitle, createZipTooLargeSubtitle } = require('../utils/archiveExtractor');
const { analyzeResponseContent, createInvalidResponseSubtitle } = require('../utils/responseAnalyzer');

const SUBS_RO_API_URL = 'https://subs.ro/api/v1.0';
const USER_AGENT = `SubMaker v${version}`;

// Maximum results per language to prevent overwhelming the user with choices
const MAX_RESULTS_PER_LANGUAGE = 14;

// Maximum ZIP file size to process (25MB - same as other providers)
const MAX_ZIP_BYTES = 25 * 1024 * 1024;

/**
 * Language mapping: ISO 639-2/B (SubMaker internal) → subs.ro codes
 * subs.ro uses a limited set of language codes: ro, en, ita, fra, ger, ung, gre, por, spa, alt
 */
const ISO2_TO_SUBSRO = {
    // Romanian
    'rum': 'ro', 'ron': 'ro', 'ro': 'ro',
    // English
    'eng': 'en', 'en': 'en',
    // Italian
    'ita': 'ita', 'it': 'ita',
    // French
    'fre': 'fra', 'fra': 'fra', 'fr': 'fra',
    // German
    'ger': 'ger', 'deu': 'ger', 'de': 'ger',
    // Hungarian
    'hun': 'ung', 'hu': 'ung',
    // Greek
    'gre': 'gre', 'ell': 'gre', 'el': 'gre',
    // Portuguese (including Brazilian)
    'por': 'por', 'pob': 'por', 'pt': 'por',
    // Spanish
    'spa': 'spa', 'spn': 'spa', 'es': 'spa'
    // All other languages would map to 'alt' (handled in code)
};

/**
 * Reverse mapping: subs.ro language codes → ISO 639-2/B (SubMaker internal)
 */
const SUBSRO_TO_ISO2 = {
    'ro': 'rum',
    'en': 'eng',
    'ita': 'ita',
    'fra': 'fre',
    'ger': 'ger',
    'ung': 'hun',
    'gre': 'gre',
    'por': 'por',
    'spa': 'spa',
    'alt': 'und'  // Unknown/other
};

/**
 * Convert ISO 639-2/B language code to subs.ro format
 * @param {string} lang - ISO 639-2/B language code
 * @returns {string|null} - subs.ro language code or null if not supported
 */
function toSubsRoLanguage(lang) {
    if (!lang) return null;
    const lower = lang.toLowerCase().trim();
    return ISO2_TO_SUBSRO[lower] || null;
}

/**
 * Normalize language code from subs.ro format to SubMaker's ISO 639-2/B
 * @param {string} lang - Language code from subs.ro API
 * @returns {string} - ISO 639-2/B language code for SubMaker
 */
function normalizeLanguageCode(lang) {
    if (!lang) return 'und';
    const lower = lang.toLowerCase().trim();
    return SUBSRO_TO_ISO2[lower] || 'und';
}

/**
 * Infer subtitle format from filename
 * @param {string} filename - Filename to check
 * @returns {string} - Detected format or 'srt' as default
 */
function inferFormatFromFilename(filename) {
    if (!filename) return 'srt';
    const lower = filename.toLowerCase();
    if (lower.endsWith('.srt')) return 'srt';
    if (lower.endsWith('.vtt')) return 'vtt';
    if (lower.endsWith('.ass')) return 'ass';
    if (lower.endsWith('.ssa')) return 'ssa';
    if (lower.endsWith('.sub')) return 'sub';
    return 'srt';
}

class SubsRoService {
    static initLogged = false;

    /**
     * Create a new SubsRoService instance
     * @param {string|null} apiKey - subs.ro API key (required for authenticated access)
     */
    constructor(apiKey = null) {
        this.apiKey = apiKey;

        const headers = {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json'
        };

        // Add API key to headers if provided (sanitize to prevent header injection)
        const sanitizedApiKey = sanitizeApiKeyForHeader(apiKey);
        if (sanitizedApiKey) {
            headers['X-Subs-Api-Key'] = sanitizedApiKey;
        }

        this.client = axios.create({
            baseURL: SUBS_RO_API_URL,
            headers,
            httpAgent,
            httpsAgent,
            lookup: dnsLookup,
            timeout: 12000 // 12 second timeout (must fit within global provider timeout)
        });

        if (!SubsRoService.initLogged) {
            log.debug(() => `[SubsRo] Initialized Subs.ro service (API key: ${apiKey ? 'provided' : 'missing'})`);
            SubsRoService.initLogged = true;
        }
    }

    /**
     * Search for subtitles using Subs.ro API
     * @param {Object} params - Search parameters
     * @param {string} params.imdb_id - IMDB ID (with 'tt' prefix)
     * @param {string} params.tmdb_id - TMDB ID (numeric)
     * @param {string} params.type - 'movie' or 'episode'
     * @param {number} params.season - Season number (for episodes)
     * @param {number} params.episode - Episode number (for episodes)
     * @param {Array<string>} params.languages - Array of ISO-639-2 language codes
     * @param {boolean} params.excludeHearingImpairedSubtitles - Whether to exclude HI subs
     * @returns {Promise<Array>} - Array of subtitle objects
     */
    async searchSubtitles(params) {
        try {
            const { imdb_id, tmdb_id, type, season, episode, languages, excludeHearingImpairedSubtitles, providerTimeout } = params;

            // Determine search field and value
            // Priority: IMDB ID > TMDB ID
            let searchField, searchValue;

            if (imdb_id && imdb_id !== 'undefined') {
                searchField = 'imdbid';
                // subs.ro expects IMDB ID without 'tt' prefix
                searchValue = imdb_id.replace(/^tt/i, '');
            } else if (tmdb_id && tmdb_id !== 'undefined') {
                searchField = 'tmdbid';
                searchValue = String(tmdb_id).replace(/^tt/i, ''); // Remove tt if accidentally included
            } else {
                log.debug(() => '[SubsRo] No IMDB/TMDB ID available, skipping search');
                return [];
            }

            // Convert requested languages to subs.ro format
            // Filter out unsupported languages
            const subsRoLangs = [];
            if (languages && languages.length > 0) {
                for (const lang of languages) {
                    const subsRoLang = toSubsRoLanguage(lang);
                    if (subsRoLang) {
                        subsRoLangs.push(subsRoLang);
                    }
                }
                // Warn if none of the requested languages are supported
                if (subsRoLangs.length === 0) {
                    log.warn(() => `[SubsRo] None of the requested languages (${languages.join(', ')}) are supported. Subs.ro supports: ro, en, ita, fra, ger, ung, gre, por, spa, alt`);
                }
            }

            // Build URL: /search/{searchField}/{value}
            let url = `/search/${searchField}/${searchValue}`;

            // Add language filter if we have supported languages
            if (subsRoLangs.length > 0) {
                const uniqueLangs = [...new Set(subsRoLangs)];
                url += `?language=${uniqueLangs.join(',')}`;
            }

            log.debug(() => `[SubsRo] Searching: ${url}`);

            // Use providerTimeout from config if provided, otherwise use client default
            const requestConfig = providerTimeout ? { timeout: providerTimeout } : {};
            const response = await this.client.get(url, requestConfig);

            // Check for valid response
            if (!response.data) {
                log.debug(() => '[SubsRo] Empty response');
                return [];
            }

            // API returns: { status: 200, meta: {...}, count: N, items: [...] }
            if (response.data.status !== 200) {
                log.debug(() => `[SubsRo] Non-200 status in response: ${response.data.status}`);
                return [];
            }

            const items = response.data.items || [];
            if (items.length === 0) {
                log.debug(() => '[SubsRo] No subtitles found');
                return [];
            }

            log.debug(() => `[SubsRo] Found ${items.length} subtitle(s)`);

            // Track language stats for debugging
            const langStats = new Map();
            const languageCounts = new Map();

            // Determine if we're searching for TV episode
            const isEpisodeSearch = (type === 'episode' || type === 'anime-episode') && episode;
            const targetSeason = season || 1;
            const targetEpisode = episode;

            let results = items
                .map(sub => {
                    // Normalize language code from subs.ro to SubMaker's ISO 639-2/B
                    const normalizedLang = normalizeLanguageCode(sub.language);

                    // Track for stats
                    const key = sub.language === normalizedLang ? sub.language : `${sub.language}→${normalizedLang}`;
                    langStats.set(key, (langStats.get(key) || 0) + 1);

                    // Build display name from available data
                    // Format: [translator] description OR title (year)
                    let displayName = sub.description || '';
                    if (!displayName && sub.title) {
                        displayName = sub.year ? `${sub.title} (${sub.year})` : sub.title;
                    }
                    if (!displayName) {
                        displayName = `[Subs.ro] ${sub.language || 'Unknown'}`;
                    }

                    // Add translator info if available
                    if (sub.translator && !displayName.includes(sub.translator)) {
                        displayName = `[${sub.translator}] ${displayName}`;
                    }

                    // Use createdAt for upload date (for quality scoring)
                    const uploadDate = sub.createdAt || sub.updatedAt || null;

                    // Infer format from filename if available
                    const inferredFormat = inferFormatFromFilename(displayName);

                    // Heuristic HI detection from filename patterns (API doesn't provide this field)
                    // Common patterns: "HI", "SDH", "hearing impaired", "closed captions", "CC"
                    const lowerName = displayName.toLowerCase();
                    const hearingImpairedHeuristic = /\[(?:hi|sdh|cc)\]|\((?:hi|sdh|cc)\)|\.hi\.|\.sdh\.|hearing.?impaired|closed.?caption/i.test(lowerName);

                    return {
                        id: `subsro_${sub.id}`,
                        language: sub.language,
                        languageCode: normalizedLang, // ISO 639-2/B for SubMaker filtering
                        name: displayName,
                        url: sub.downloadLink || sub.link,
                        downloads: 0, // subs.ro API doesn't provide download counts
                        rating: 0,
                        uploadDate: uploadDate,
                        format: inferredFormat, // Inferred from filename, fallback to 'srt'
                        hearing_impaired: hearingImpairedHeuristic, // Heuristic - not 100% reliable
                        foreign_parts_only: false,
                        machine_translated: false,
                        provider: 'subsro', // Use lowercase for providerReputation matching
                        translator: sub.translator,
                        year: sub.year,
                        type: sub.type, // 'movie' or 'series'
                        imdbid: sub.imdbid,
                        tmdbid: sub.tmdbid,
                        poster: sub.poster,
                        createdAt: sub.createdAt,
                        updatedAt: sub.updatedAt,
                        fileId: `subsro_${sub.id}`,
                        _subsRoId: sub.id
                    };
                });

            // CLIENT-SIDE EPISODE FILTERING for TV shows
            // subs.ro API doesn't support season/episode filtering, so we must filter results
            if (isEpisodeSearch) {
                const beforeCount = results.length;

                results = results.filter(sub => {
                    const name = String(sub.name || '').toLowerCase();

                    // Season pack patterns (keep as fallback, mark for extraction)
                    const seasonPackPatterns = [
                        new RegExp(`(?:complete|full|entire)?\\s*(?:season|s)\\s*0*${targetSeason}(?:\\s+(?:complete|full|pack))?(?!.*e0*\\d)`, 'i'),
                        new RegExp(`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+season(?!.*episode)`, 'i'),
                        new RegExp(`s0*${targetSeason}\\s*(?:complete|full|pack)`, 'i')
                    ];

                    // Anime-specific season pack patterns
                    const animeSeasonPackPatterns = [
                        /(?:complete|batch|full(?:\s+series)?|\d{1,2}\s*[-~]\s*\d{1,2})/i,
                        /\[(?:batch|complete|full)\]/i,
                        /(?:episode\s*)?(?:01|001)\s*[-~]\s*(?:\d{2}|\d{3})/i
                    ];

                    let isSeasonPack = false;
                    if (type === 'anime-episode') {
                        isSeasonPack = animeSeasonPackPatterns.some(p => p.test(name)) &&
                            !new RegExp(`(?:^|[^0-9])0*${targetEpisode}(?:v\\d+)?(?:[^0-9]|$)`, 'i').test(name);
                    } else {
                        isSeasonPack = seasonPackPatterns.some(p => p.test(name)) &&
                            !/s0*\d+e0*\d+|\d+x\d+|episode\s*\d+|ep\s*\d+/i.test(name);
                    }

                    if (isSeasonPack) {
                        // Mark as season pack for download extraction
                        sub.is_season_pack = true;
                        sub.season_pack_season = targetSeason;
                        sub.season_pack_episode = targetEpisode;

                        // Encode episode info in fileId for download extraction
                        const originalFileId = sub.fileId || sub.id;
                        sub.fileId = `${originalFileId}_seasonpack_s${targetSeason}e${targetEpisode}`;
                        sub.id = sub.fileId;

                        log.debug(() => `[SubsRo] Detected season pack: ${sub.name}`);
                        return true;
                    }

                    // Episode match patterns
                    const seasonEpisodePatterns = [
                        new RegExp(`s0*${targetSeason}e0*${targetEpisode}(?![0-9])`, 'i'),
                        new RegExp(`${targetSeason}x0*${targetEpisode}(?![0-9])`, 'i'),
                        new RegExp(`s0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'),
                        new RegExp(`0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'),
                        new RegExp(`s0*${targetSeason}\\.e0*${targetEpisode}(?![0-9])`, 'i'),
                        new RegExp(`season\\s*0*${targetSeason}.*episode\\s*0*${targetEpisode}(?![0-9])`, 'i')
                    ];

                    // Anime episode patterns (episode only, no season)
                    const animeEpisodePatterns = [
                        new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e(?:p(?:isode)?)?[\\s._-]*0*${targetEpisode}(?:v\\d+)?(?=\\b|\\s|\\]|\\)|\\.|-|_|$)`, 'i'),
                        new RegExp(`(?:^|[\\s\\[\\(\\-_.])0*${targetEpisode}(?:v\\d+)?(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
                        new RegExp(`(?:episode|episodio|ep|cap(?:itulo)?)\\s*0*${targetEpisode}(?![0-9])`, 'i')
                    ];

                    // Check for exact episode match
                    if (seasonEpisodePatterns.some(p => p.test(name))) {
                        return true;
                    }

                    // For anime, also check episode-only patterns
                    if (type === 'anime-episode' && animeEpisodePatterns.some(p => p.test(name))) {
                        return true;
                    }

                    // Check if subtitle explicitly mentions a DIFFERENT episode - exclude it
                    const episodeMatch = name.match(/s0*(\d+)e0*(\d+)|(\d+)x0*(\d+)/i);
                    if (episodeMatch) {
                        const subSeason = parseInt(episodeMatch[1] || episodeMatch[3], 10);
                        const subEpisode = parseInt(episodeMatch[2] || episodeMatch[4], 10);
                        if (subSeason === targetSeason && subEpisode !== targetEpisode) {
                            return false; // Wrong episode - exclude
                        }
                    }

                    // Keep subtitles that don't specify any episode (might be movie format or generic)
                    // Only if this is actually a series type from the API
                    if (sub.type === 'series') {
                        // If it's marked as series but has no episode info, it might be a season pack
                        // Keep it but don't mark as season pack yet (could be single file for the show)
                        return true;
                    }

                    // Keep generic subtitles as they might still be relevant
                    return true;
                });

                const filteredCount = beforeCount - results.length;
                const seasonPackCount = results.filter(s => s.is_season_pack).length;
                if (filteredCount > 0 || seasonPackCount > 0) {
                    log.debug(() => `[SubsRo] Episode filtering: kept ${results.length}/${beforeCount}, season packs: ${seasonPackCount}`);
                }
            }

            // Client-side HI subtitle filtering using filename heuristics
            // Since subs.ro API doesn't provide HI flag, we use filename pattern detection
            if (excludeHearingImpairedSubtitles === true) {
                const beforeHiCount = results.length;
                results = results.filter(sub => !sub.hearing_impaired);
                const removedHi = beforeHiCount - results.length;
                if (removedHi > 0) {
                    log.debug(() => `[SubsRo] HI filtering: removed ${removedHi} subtitle(s) based on filename heuristics (patterns like .HI., [SDH], etc.)`);
                }
            }

            // Apply per-language limit
            results = results.filter(sub => {
                const lang = sub.languageCode || 'unknown';
                const count = languageCounts.get(lang) || 0;
                if (count >= MAX_RESULTS_PER_LANGUAGE) {
                    return false;
                }
                languageCounts.set(lang, count + 1);
                return true;
            });

            // Log language stats
            if (langStats.size > 0) {
                const statsStr = Array.from(langStats.entries())
                    .map(([k, v]) => `${k}:${v}`)
                    .join(', ');
                log.debug(() => `[SubsRo] Languages received: ${statsStr}`);
            }

            log.debug(() => `[SubsRo] Returning ${results.length} results (limited to ${MAX_RESULTS_PER_LANGUAGE} per language)`);

            return results;

        } catch (error) {
            // Use warn instead of error for operational failures
            if (error.response?.status === 404) {
                log.debug(() => `[SubsRo] No results (404) for requested content`);
            } else if (error.response?.status === 400) {
                log.debug(() => `[SubsRo] Bad request (400): ${error.response?.data?.message || error.message}`);
            } else if (error.response?.status === 401) {
                log.warn(() => `[SubsRo] API key rejected (401) - check your subs.ro API key`);
            } else {
                log.warn(() => `[SubsRo] Search failed: ${error.message}`);
            }
            return [];
        }
    }

    /**
     * Download subtitle content from Subs.ro
     * The API returns binary ZIP archives that need to be extracted
     * @param {string} fileId - File ID from search results (format: subsro_{id} or subsro_{id}_seasonpack_s{season}e{episode})
     * @param {number} maxRetries - Maximum number of retries (default: 3)
     * @returns {Promise<string>} - Subtitle content as text
     */
    async downloadSubtitle(fileId, options = {}) {
        // Support legacy call pattern: downloadSubtitle(fileId, maxRetries)
        // New pattern: downloadSubtitle(fileId, { timeout, maxRetries })
        let maxRetries = 3;
        let timeout = 20000; // Default 20s for downloads (larger files)

        if (typeof options === 'number') {
            // Legacy: second arg was maxRetries
            maxRetries = options;
        } else if (options) {
            timeout = options.timeout || 20000;
            maxRetries = options.maxRetries || 3;
        }
        // Validate fileId format
        if (!fileId || !fileId.startsWith('subsro_')) {
            throw new Error('Invalid Subs.ro file ID format');
        }

        // Check for season pack encoding in fileId
        let isSeasonPack = false;
        let seasonPackSeason = null;
        let seasonPackEpisode = null;
        let baseFileId = fileId;

        const seasonPackMatch = fileId.match(/^(subsro_\d+)_seasonpack_s(\d+)e(\d+)$/i);
        if (seasonPackMatch) {
            isSeasonPack = true;
            baseFileId = seasonPackMatch[1];
            seasonPackSeason = parseInt(seasonPackMatch[2], 10);
            seasonPackEpisode = parseInt(seasonPackMatch[3], 10);
            log.debug(() => `[SubsRo] Season pack download: S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')}`);
        }

        // Extract the numeric ID
        const subsroId = baseFileId.substring(7); // Remove 'subsro_' prefix
        if (!subsroId || !/^\d+$/.test(subsroId)) {
            throw new Error(`Invalid Subs.ro subtitle ID: ${subsroId}`);
        }

        const downloadUrl = `/subtitle/${subsroId}/download`;

        log.debug(() => `[SubsRo] Downloading subtitle ID: ${subsroId}`);

        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                log.debug(() => `[SubsRo] Download attempt ${attempt}/${maxRetries}`);

                const response = await this.client.get(downloadUrl, {
                    responseType: 'arraybuffer',
                    timeout: timeout // Use configurable timeout
                });

                const buffer = Buffer.from(response.data);

                // Check size limits
                if (buffer.length > MAX_ZIP_BYTES) {
                    log.warn(() => `[SubsRo] ZIP too large: ${buffer.length} bytes > ${MAX_ZIP_BYTES} limit`);
                    return createZipTooLargeSubtitle(MAX_ZIP_BYTES, buffer.length);
                }

                // Check for valid archive (ZIP or RAR)
                const archiveType = detectArchiveType(buffer);

                if (archiveType) {
                    log.debug(() => `[SubsRo] Received ${archiveType.toUpperCase()} archive (${buffer.length} bytes), extracting...`);

                    // Use the centralized archive extractor that handles both ZIP and RAR
                    return await extractSubtitleFromArchive(buffer, {
                        providerName: 'SubsRo',
                        maxBytes: MAX_ZIP_BYTES,
                        isSeasonPack: isSeasonPack,
                        season: seasonPackSeason,
                        episode: seasonPackEpisode,
                        languageHint: options.languageHint || null
                    });

                } else {
                    // Not an archive - analyze what we received
                    const contentAnalysis = analyzeResponseContent(buffer);
                    log.debug(() => `[SubsRo] Response is not an archive (${buffer.length} bytes). Content analysis: ${contentAnalysis.type} - ${contentAnalysis.hint}`);

                    // If it's an error response (HTML, Cloudflare, JSON error, etc.), show user-friendly message
                    if (contentAnalysis.type.startsWith('html') || contentAnalysis.type === 'json_error' || contentAnalysis.type === 'text_error' || contentAnalysis.type === 'empty' || contentAnalysis.type === 'truncated' || contentAnalysis.type === 'gzip') {
                        log.error(() => `[SubsRo] Download failed: ${contentAnalysis.type} - ${contentAnalysis.hint}`);
                        return createInvalidResponseSubtitle('SubsRo', contentAnalysis, buffer.length);
                    }

                    // If it looks like subtitle content, decode and return it
                    if (contentAnalysis.type === 'subtitle') {
                        const text = detectAndConvertEncoding(buffer, 'SubsRo', options.languageHint || null);
                        return text;
                    }

                    // For unknown content, try to decode it as subtitle
                    const text = detectAndConvertEncoding(buffer, 'SubsRo', options.languageHint || null);
                    const hasTimecodes = /\d{2}:\d{2}:\d{2}[,.:]+\d{2,3}/.test(text);
                    if (!hasTimecodes && text.length < 100) {
                        log.error(() => `[SubsRo] Response does not appear to be valid subtitle content`);
                        return createInvalidResponseSubtitle('SubsRo', { type: 'unknown', hint: 'Unrecognized content format', isRetryable: false }, buffer.length);
                    }

                    return text;
                }

            } catch (error) {
                lastError = error;
                const status = error.response?.status;

                // Don't retry for non-retryable errors
                if (status === 404 || status === 401 || status === 403) {
                    log.warn(() => `[SubsRo] Non-retryable error (${status}), aborting: ${error.message}`);
                    break;
                }

                // Retry with backoff for server errors
                if (status >= 500 && attempt < maxRetries) {
                    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    log.warn(() => `[SubsRo] Download failed (status ${status}), retrying in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                }

                // Rate limit - retry with longer backoff
                if (status === 429 && attempt < maxRetries) {
                    const backoffMs = 3000 * attempt;
                    log.warn(() => `[SubsRo] Rate limited (429), retrying in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                }
            }
        }

        throw new Error(`SubsRo download failed after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
    }

    /**
     * Check API quota status
     * Useful for debugging and monitoring API usage
     * @returns {Promise<Object|null>} - Quota information or null on error
     */
    async checkQuota() {
        try {
            const response = await this.client.get('/quota');
            if (response.data && response.data.status === 200) {
                const quota = response.data.quota;
                log.debug(() => `[SubsRo] Quota: ${quota.remaining_quota}/${quota.total_quota} remaining (${quota.quota_type})`);
                return quota;
            }
            return null;
        } catch (error) {
            log.warn(() => `[SubsRo] Failed to check quota: ${error.message}`);
            return null;
        }
    }
}

module.exports = SubsRoService;
