const log = require('./logger');
const animeIdResolver = require('../services/animeIdResolver');

function toPositiveSeason(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toPositiveEpisode(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isAnimeSeasonHintEnabled() {
  return process.env.ANIME_SEASON_HINT_ENABLED !== 'false';
}

function buildResolvedSummary(resolved) {
  return [
    resolved?.imdbId || null,
    resolved?.tmdbId ? `tmdb:${resolved.tmdbId}` : null
  ].filter(Boolean).join(' | ');
}

function parseExplicitSeasonEpisode(name) {
  return getExplicitSeasonEpisodeMatches(name)[0] || null;
}

function getExplicitSeasonEpisodeMatches(name) {
  const input = String(name || '');
  if (!input) {
    return [];
  }

  const matches = [];
  const patterns = [
    /(?:^|[^a-z0-9])s0*(\d+)\s*[._ -]*e0*(\d{1,3})(?:v\d+)?(?!\d)/gi,
    /(?:^|[^a-z0-9])(\d+)\s*x\s*0*(\d{1,3})(?:v\d+)?(?!\d)/gi,
    /(?:^|[^a-z0-9])s0*(\d+)\s*[-_. ]+\s*0*(\d{1,3})(?:v\d+)?(?!\d)(?!\s*[-~]\s*\d)/gi,
    /(?:^|[^a-z0-9])season\s*0*(\d+)\s*[-_. ]+\s*0*(\d{1,3})(?:v\d+)?(?!\d)(?!\s*[-~]\s*\d)/gi,
    /(?:^|[^a-z0-9])(\d+)(?:st|nd|rd|th)\s+season\s*[-_. ]+\s*0*(\d{1,3})(?:v\d+)?(?!\d)(?!\s*[-~]\s*\d)/gi,
    /season\s*0*(\d+).*?episode\s*0*(\d{1,3})(?:v\d+)?(?!\d)/gi
  ];

  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) {
      const season = toPositiveSeason(match[1]);
      const episode = toPositiveEpisode(match[2]);
      if (!season || !episode) {
        continue;
      }
      matches.push({ season, episode });
    }
  }

  if (matches.length <= 1) {
    return matches;
  }

  const seen = new Set();
  return matches.filter(({ season, episode }) => {
    const key = `${season}:${episode}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasExplicitSeasonEpisodeMismatch(name, targetSeason, targetEpisode) {
  const matches = getExplicitSeasonEpisodeMatches(name);
  if (!matches.length) {
    return false;
  }

  return !matches.some(({ season, episode }) => season === targetSeason && episode === targetEpisode);
}

function applyExplicitFilenameSeasonHint(videoInfo, streamFilename) {
  if (!videoInfo || !streamFilename) {
    return videoInfo;
  }

  if (!videoInfo.episode || (videoInfo.type !== 'anime-episode' && videoInfo.type !== 'episode')) {
    return videoInfo;
  }

  // Direct tmdb: TV/anime IDs can carry TMDB-specific season numbering in the ID
  // while the stream filename still reflects the Stremio/TVDB-facing season.
  // Allow the explicit SxxExx filename season to override that incoming tmdb season
  // so later resolver/provider steps can keep both season hints instead of locking
  // the whole search to the TMDB season.
  const allowTmdbSeasonOverride = !!videoInfo.tmdbId;
  if (videoInfo.season && !allowTmdbSeasonOverride) {
    return videoInfo;
  }

  const parsed = parseExplicitSeasonEpisode(streamFilename);
  if (!parsed || parsed.episode !== videoInfo.episode || !parsed.season) {
    return videoInfo;
  }

  if (!videoInfo.season || parsed.season !== videoInfo.season) {
    if (allowTmdbSeasonOverride && videoInfo.season && !videoInfo.tmdbSeason) {
      videoInfo.tmdbSeason = videoInfo.season;
    }
    if (allowTmdbSeasonOverride && !videoInfo.tvdbSeason) {
      videoInfo.tvdbSeason = parsed.season;
    }
    videoInfo.season = parsed.season;
  }
  return videoInfo;
}

function applyAnimeResolverMetadata(videoInfo, resolved, { enableSeasonHint = isAnimeSeasonHintEnabled() } = {}) {
  if (!videoInfo || !resolved || typeof resolved !== 'object') {
    return videoInfo;
  }

  if (resolved.imdbId) {
    videoInfo.imdbId = resolved.imdbId;
  }

  if (resolved.tmdbId && !videoInfo.tmdbId) {
    videoInfo.tmdbId = String(resolved.tmdbId);
  }

  const stremioSeason = toPositiveSeason(resolved.season);
  const tvdbSeason = toPositiveSeason(resolved.seasonTvdb);
  const tmdbSeason = toPositiveSeason(resolved.seasonTmdb);

  if (tvdbSeason) {
    videoInfo.tvdbSeason = tvdbSeason;
  }

  if (tmdbSeason) {
    videoInfo.tmdbSeason = tmdbSeason;
  }

  if (
    videoInfo.type === 'anime-episode' &&
    !videoInfo.season &&
    enableSeasonHint &&
    stremioSeason
  ) {
    videoInfo.season = stremioSeason;
  }

  return videoInfo;
}

function getPreferredSeasonHint(params, { preferTmdb = false, fallback = 1 } = {}) {
  return getSeasonHintCandidates(params, { preferTmdb, fallback })[0] || null;
}

function getSeasonHintCandidates(params, { preferTmdb = false, fallback = 1 } = {}) {
  const primary = preferTmdb
    ? toPositiveSeason(params?.tmdbSeason)
    : toPositiveSeason(params?.season);
  const secondary = preferTmdb
    ? toPositiveSeason(params?.season)
    : toPositiveSeason(params?.tmdbSeason);
  const fallbackSeason = toPositiveSeason(fallback);

  return [primary, secondary, fallbackSeason].filter((value, index, values) => (
    value && values.indexOf(value) === index
  ));
}

async function resolveAnimeVideoInfo(videoInfo, {
  anidbService = null,
  kitsuService = null,
  malService = null,
  anilistService = null,
  logger = log,
  logContext = 'Subtitles',
  enableSeasonHint = isAnimeSeasonHintEnabled()
} = {}) {
  if (!videoInfo?.isAnime || !videoInfo.animeId) {
    return { source: null, resolved: false, videoInfo };
  }

  logger.debug(() => `[${logContext}] Anime content detected (${videoInfo.animeIdType}), attempting to map to IMDB ID`);

  const offlineResult = animeIdResolver.resolveImdbId(videoInfo.animeIdType, videoInfo.animeId, {
    seasonHint: videoInfo.season || null
  });
  if (offlineResult?.imdbId || offlineResult?.tmdbId) {
    applyAnimeResolverMetadata(videoInfo, offlineResult, { enableSeasonHint });
    logger.info(() => `[${logContext}] Offline mapped ${videoInfo.animeIdType} ${videoInfo.animeId} -> ${buildResolvedSummary(offlineResult)}`);
    return { source: 'offline', resolved: true, result: offlineResult, videoInfo };
  }

  logger.debug(() => `[${logContext}] No offline mapping for ${videoInfo.animeIdType} ${videoInfo.animeId}, falling back to live API`);

  try {
    if (videoInfo.animeIdType === 'anidb' && anidbService?.getImdbId) {
      const lookupId = videoInfo.anidbId || videoInfo.animeId;
      const imdbId = await anidbService.getImdbId(lookupId);
      if (imdbId) {
        logger.info(() => `[${logContext}] Live-mapped AniDB ${lookupId} -> ${imdbId}`);
        videoInfo.imdbId = imdbId;
        return { source: 'live', resolved: true, result: { imdbId }, videoInfo };
      }
      logger.warn(() => `[${logContext}] Could not find IMDB mapping for AniDB ${lookupId}, subtitles may be limited`);
      return { source: 'live', resolved: false, result: null, videoInfo };
    }

    if (videoInfo.animeIdType === 'kitsu' && kitsuService?.getImdbId) {
      const imdbId = await kitsuService.getImdbId(videoInfo.animeId);
      if (imdbId) {
        logger.info(() => `[${logContext}] Live-mapped Kitsu ${videoInfo.animeId} -> ${imdbId}`);
        videoInfo.imdbId = imdbId;
        return { source: 'live', resolved: true, result: { imdbId }, videoInfo };
      }
      logger.warn(() => `[${logContext}] Could not find IMDB mapping for Kitsu ${videoInfo.animeId}, subtitles may be limited`);
      return { source: 'live', resolved: false, result: null, videoInfo };
    }

    if (videoInfo.animeIdType === 'mal' && malService?.getImdbId) {
      const imdbId = await malService.getImdbId(videoInfo.animeId);
      if (imdbId) {
        logger.info(() => `[${logContext}] Live-mapped MAL ${videoInfo.animeId} -> ${imdbId}`);
        videoInfo.imdbId = imdbId;
        return { source: 'live', resolved: true, result: { imdbId }, videoInfo };
      }
      logger.warn(() => `[${logContext}] Could not find IMDB mapping for MAL ${videoInfo.animeId}, subtitles may be limited`);
      return { source: 'live', resolved: false, result: null, videoInfo };
    }

    if (videoInfo.animeIdType === 'anilist' && anilistService?.getImdbId) {
      const imdbId = await anilistService.getImdbId(videoInfo.animeId, malService);
      if (imdbId) {
        logger.info(() => `[${logContext}] Live-mapped AniList ${videoInfo.animeId} -> ${imdbId}`);
        videoInfo.imdbId = imdbId;
        return { source: 'live', resolved: true, result: { imdbId }, videoInfo };
      }
      logger.warn(() => `[${logContext}] Could not find IMDB mapping for AniList ${videoInfo.animeId}, subtitles may be limited`);
      return { source: 'live', resolved: false, result: null, videoInfo };
    }

    logger.debug(() => `[${logContext}] Unknown anime ID type: ${videoInfo.animeIdType}, will search by anime metadata`);
    return { source: 'none', resolved: false, result: null, videoInfo };
  } catch (error) {
    logger.error(() => [`[${logContext}] Error mapping ${videoInfo.animeIdType} to IMDB: ${error.message}`, error]);
    return { source: 'error', resolved: false, result: null, videoInfo, error };
  }
}

module.exports = {
  applyExplicitFilenameSeasonHint,
  applyAnimeResolverMetadata,
  buildResolvedSummary,
  getExplicitSeasonEpisodeMatches,
  getPreferredSeasonHint,
  getSeasonHintCandidates,
  hasExplicitSeasonEpisodeMismatch,
  isAnimeSeasonHintEnabled,
  parseExplicitSeasonEpisode,
  resolveAnimeVideoInfo
};
