const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_TO_FILE = 'false';
process.env.LOG_LEVEL = 'error';
process.env.STORAGE_TYPE = 'filesystem';

const animeIdResolver = require('../src/services/animeIdResolver');
const { parseStremioId } = require('../src/utils/subtitle');
const { getAllTranslationLanguages, normalizeLanguageCode } = require('../src/utils/languages');
const {
  applyExplicitFilenameSeasonHint,
  getSeasonHintCandidates,
  hasExplicitSeasonEpisodeMismatch,
  resolveAnimeVideoInfo
} = require('../src/utils/animeSearchResolver');
const {
  createSubtitleHandler,
  createTranslationErrorSubtitle,
  filterSubtitlesByRequestedLanguages
} = require('../src/handlers/subtitles');
const { parseApiError } = require('../src/utils/apiErrorHandler');
const StremioCommunitySubtitlesService = require('../src/services/stremioCommunitySubtitles');
const WyzieSubsService = require('../src/services/wyzieSubs');
const SubsRoService = require('../src/services/subsRo');
const SubSourceService = require('../src/services/subsource');
const OpenSubtitlesService = require('../src/services/opensubtitles');
const OpenSubtitlesV3Service = require('../src/services/opensubtitles-v3');

const {
  tryAcquireDistributedRateLimitSlot,
  resetRateLimiterState
} = OpenSubtitlesService.__testing;

const silentLogger = {
  debug() { },
  info() { },
  warn() { },
  error() { }
};

function createMainRouteConfig(overrides = {}) {
  return {
    __configHash: overrides.__configHash || `test-${Date.now()}-${Math.random()}`,
    sourceLanguages: ['eng'],
    subtitleProviderTimeout: 12,
    excludeHearingImpairedSubtitles: false,
    enableSeasonPacks: true,
    deduplicateSubtitles: true,
    subtitleProviders: {
      opensubtitles: { enabled: false, implementationType: 'v3' },
      subdl: { enabled: false, apiKey: '' },
      subsource: { enabled: false, apiKey: '' },
      scs: { enabled: false },
      wyzie: { enabled: true, sources: {} },
      subsro: { enabled: false, apiKey: '' }
    },
    targetLanguages: [],
    noTranslationLanguages: [],
    noTranslationMode: false,
    subToolboxEnabled: false,
    fileTranslationEnabled: false,
    syncSubtitlesEnabled: false,
    learnMode: false,
    ...overrides
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createFakeRateLimitAdapter() {
  const buckets = new Map();
  let now = 0;

  function readBucket(key) {
    const current = buckets.get(key);
    if (!current) {
      return null;
    }
    if (current.expiresAt <= now) {
      buckets.delete(key);
      return null;
    }
    return current;
  }

  return {
    adapter: {
      client: {
        async eval(_script, _numKeys, fullKey, limitArg, windowMsArg) {
          const limit = Number(limitArg);
          const windowMs = Number(windowMsArg);
          const bucket = readBucket(fullKey);
          const count = bucket ? bucket.count : 0;

          if (count >= limit) {
            const ttl = bucket ? Math.max(0, bucket.expiresAt - now) : windowMs;
            return [0, count, ttl];
          }

          const nextCount = count + 1;
          const expiresAt = bucket ? bucket.expiresAt : now + windowMs;
          buckets.set(fullKey, { count: nextCount, expiresAt });
          return [1, nextCount, Math.max(0, expiresAt - now)];
        }
      },
      _getKey(key) {
        return `test:${key}`;
      }
    },
    advance(ms) {
      now += ms;
    }
  };
}

test('offline anime resolver keeps separate TVDB and TMDB season hints', async () => {
  await animeIdResolver.initialize();
  const mapping = animeIdResolver.resolveImdbId('mal', 'mal:57658');

  assert.ok(mapping);
  assert.equal(mapping.imdbId, 'tt12343534');
  assert.equal(mapping.tmdbId, 95479);
  assert.equal(mapping.season, 3);
  assert.equal(mapping.seasonTvdb, 3);
  assert.equal(mapping.seasonTmdb, 1);
});

test('colliding TVDB anime IDs no longer inherit an arbitrary season hint', async () => {
  await animeIdResolver.initialize();
  const mapping = animeIdResolver.resolveImdbId('tvdb', '377543');

  assert.ok(mapping);
  assert.equal(mapping.imdbId, null);
  assert.equal(mapping.tmdbId, null);
  assert.equal(mapping.season, null);
  assert.equal(mapping.seasonTvdb, null);
  assert.equal(mapping.seasonTmdb, null);
});

test('explicit TVDB anime seasons disambiguate correctly despite shared show IDs', async () => {
  await animeIdResolver.initialize();
  const mapping = animeIdResolver.resolveImdbId('tvdb', '377543', { seasonHint: 3 });

  assert.ok(mapping);
  assert.equal(mapping.imdbId, 'tt12343534');
  assert.equal(mapping.tmdbId, 95479);
  assert.equal(mapping.season, 3);
  assert.equal(mapping.seasonTvdb, 3);
  assert.equal(mapping.seasonTmdb, 1);
});

test('seasonless MAL anime episode inherits Stremio-facing season hint by default', async () => {
  await animeIdResolver.initialize();
  const videoInfo = parseStremioId('mal:57658:10', 'series');

  await resolveAnimeVideoInfo(videoInfo, { logger: silentLogger, logContext: 'Test' });

  assert.equal(videoInfo.imdbId, 'tt12343534');
  assert.equal(videoInfo.tmdbId, '95479');
  assert.equal(videoInfo.season, 3);
  assert.equal(videoInfo.tvdbSeason, 3);
  assert.equal(videoInfo.tmdbSeason, 1);
});

test('season-specific anime entries inherit a unique shared TVDB IMDB mapping when their own row is missing it', async () => {
  await animeIdResolver.initialize();
  const videoInfo = parseStremioId('mal:52293:1', 'series');

  await resolveAnimeVideoInfo(videoInfo, { logger: silentLogger, logContext: 'Test' });

  assert.equal(videoInfo.imdbId, 'tt1727444');
  assert.equal(videoInfo.tmdbId, '246862');
  assert.equal(videoInfo.season, 2);
  assert.equal(videoInfo.tvdbSeason, 2);
  assert.equal(videoInfo.tmdbSeason, 1);
});

test('offline TMDB anime lookup uses TMDB season numbering and shared TVDB IMDB fallback', async () => {
  await animeIdResolver.initialize();
  const mapping = animeIdResolver.resolveImdbId('tmdb', '246862', { seasonHint: 1 });

  assert.ok(mapping);
  assert.equal(mapping.imdbId, 'tt1727444');
  assert.equal(mapping.tmdbId, 246862);
  assert.equal(mapping.tvdbId, 188551);
  assert.equal(mapping.season, 2);
  assert.equal(mapping.seasonTvdb, 2);
  assert.equal(mapping.seasonTmdb, 1);
});

test('anime season hints remain available even when explicit hinting is disabled', async (t) => {
  await animeIdResolver.initialize();
  const previous = process.env.ANIME_SEASON_HINT_ENABLED;
  process.env.ANIME_SEASON_HINT_ENABLED = 'false';
  t.after(() => {
    if (previous === undefined) {
      delete process.env.ANIME_SEASON_HINT_ENABLED;
    } else {
      process.env.ANIME_SEASON_HINT_ENABLED = previous;
    }
  });

  const videoInfo = parseStremioId('mal:57658:10', 'series');
  await resolveAnimeVideoInfo(videoInfo, { logger: silentLogger, logContext: 'Test' });

  assert.equal(videoInfo.season, undefined);
  assert.equal(videoInfo.tvdbSeason, 3);
  assert.equal(videoInfo.tmdbSeason, 1);
});

test('live MAL fallback still maps IMDB when offline resolver misses', async (t) => {
  const originalResolve = animeIdResolver.resolveImdbId;
  animeIdResolver.resolveImdbId = () => null;
  t.after(() => {
    animeIdResolver.resolveImdbId = originalResolve;
  });

  const videoInfo = parseStremioId('mal:999999:4', 'series');
  const seen = [];

  await resolveAnimeVideoInfo(videoInfo, {
    logger: silentLogger,
    logContext: 'Test',
    malService: {
      async getImdbId(id) {
        seen.push(id);
        return 'tt7654321';
      }
    }
  });

  assert.deepEqual(seen, ['mal:999999']);
  assert.equal(videoInfo.imdbId, 'tt7654321');
});

test('explicit season in filename disambiguates seasonless anime IDs before offline resolution', async () => {
  await animeIdResolver.initialize();
  const videoInfo = parseStremioId('tvdb:377543:10', 'series');

  applyExplicitFilenameSeasonHint(videoInfo, 'Jujutsu.Kaisen.S03E10.1080p.WEBRip.mkv');
  await resolveAnimeVideoInfo(videoInfo, { logger: silentLogger, logContext: 'Test' });

  assert.equal(videoInfo.season, 3);
  assert.equal(videoInfo.imdbId, 'tt12343534');
  assert.equal(videoInfo.tmdbId, '95479');
});

test('direct tmdb anime episode IDs let explicit filename season rescue the Stremio-facing season', async (t) => {
  let captured = null;
  const originalSearch = WyzieSubsService.prototype.searchSubtitles;
  WyzieSubsService.prototype.searchSubtitles = async (params) => {
    captured = { ...params };
    return [];
  };
  t.after(() => {
    WyzieSubsService.prototype.searchSubtitles = originalSearch;
  });

  const handler = createSubtitleHandler(createMainRouteConfig({
    __configHash: `tmdb-filename-rescue-${Date.now()}-${Math.random()}`
  }));

  await handler({
    type: 'series',
    id: 'tmdb:95479:1:10',
    extra: { filename: 'Jujutsu.Kaisen.S03E10.1080p.WEBRip.mkv' }
  });

  assert.ok(captured);
  assert.equal(captured.imdb_id, 'tt12343534');
  assert.equal(captured.tmdb_id, '95479');
  assert.equal(captured.season, 3);
  assert.equal(captured.episode, 10);
  assert.equal(captured.tmdbSeason, 1);
});

test('explicit anime season mismatch detection catches S3 - 03 style aliases without rejecting mixed correct aliases', () => {
  assert.deepEqual(
    getSeasonHintCandidates({ season: 3, tmdbSeason: 1 }),
    [3, 1]
  );

  assert.equal(
    hasExplicitSeasonEpisodeMismatch('Jujutsu Kaisen S3 - 03 [@AniWide] [translated]', 3, 10),
    true
  );

  assert.equal(
    hasExplicitSeasonEpisodeMismatch('[SubsPlease] Jujutsu Kaisen - S3E10 / JUJUTSU.KAISEN.S01E57.CR.WEB', 3, 10),
    false
  );
});

test('TMDB-native providers keep the Stremio season first and only fall back to TMDB season when needed', async () => {
  assert.deepEqual(
    getSeasonHintCandidates({ season: 2, tmdbSeason: 1 }),
    [2, 1]
  );

  const wyzie = new WyzieSubsService();
  const wyzieUrls = [];
  wyzie.client = {
    get: async (url) => {
      wyzieUrls.push(url);
      if (/season=2/.test(url)) {
        return { data: [] };
      }
      return {
        data: [{
          id: 'fallback',
          language: 'en',
          url: 'https://example.com/jjk-s01e01.srt',
          release: 'Fallback S01E01'
        }]
      };
    }
  };

  await wyzie.searchSubtitles({
    tmdb_id: '246862',
    type: 'anime-episode',
    season: 2,
    tmdbSeason: 1,
    episode: 1,
    languages: []
  });

  assert.deepEqual(wyzieUrls.map(url => url.match(/season=(\d+)/)?.[1]).filter(Boolean), ['2', '1']);
  assert.ok(wyzieUrls.every(url => /episode=1/.test(url)));

  const subsro = new SubsRoService('test-key');
  subsro.client = {
    get: async () => ({
      data: {
        status: 200,
        items: [
          {
            id: 10,
            language: 'en',
            description: 'New Panty and Stocking With Garterbelt S01E01',
            type: 'series'
          },
          {
            id: 11,
            language: 'en',
            description: 'New Panty and Stocking With Garterbelt S02E01',
            type: 'series'
          }
        ]
      }
    })
  };

  const results = await subsro.searchSubtitles({
    tmdb_id: '246862',
    type: 'anime-episode',
    season: 2,
    tmdbSeason: 1,
    episode: 1,
    languages: ['eng']
  });

  assert.deepEqual(results.map(result => result.name), [
    'New Panty and Stocking With Garterbelt S02E01'
  ]);

  subsro.client = {
    get: async () => ({
      data: {
        status: 200,
        items: [
          {
            id: 12,
            language: 'en',
            description: 'Fallback only S01E01',
            type: 'series'
          }
        ]
      }
    })
  };

  const fallbackResults = await subsro.searchSubtitles({
    tmdb_id: '246862',
    type: 'anime-episode',
    season: 2,
    tmdbSeason: 1,
    episode: 1,
    languages: ['eng']
  });

  assert.deepEqual(fallbackResults.map(result => result.name), [
    'Fallback only S01E01'
  ]);
});

test('SubSource rejects explicit wrong-season anime singles before season-pack heuristics', async () => {
  const subsource = new SubSourceService('test-key');
  subsource.getMovieId = async () => 123;
  subsource.client = {
    get: async () => ({
      data: [
        {
          subtitleId: 1,
          language: 'eng',
          releaseInfo: ['Jujutsu Kaisen S3 - 03 [@AniWide] [translated]']
        },
        {
          subtitleId: 2,
          language: 'eng',
          releaseInfo: ['Jujutsu Kaisen S3 - 10 [@AniWide] [translated]']
        },
        {
          subtitleId: 3,
          language: 'eng',
          releaseInfo: ['Jujutsu Kaisen 01-12 [Batch]']
        }
      ]
    })
  };

  const results = await subsource.searchSubtitles({
    imdb_id: 'tt12343534',
    type: 'anime-episode',
    season: 3,
    episode: 10,
    languages: ['eng']
  });

  assert.deepEqual(results.map(result => result.name), [
    'Jujutsu Kaisen S3 - 10 [@AniWide] [translated]',
    'Jujutsu Kaisen 01-12 [Batch]'
  ]);
  assert.equal(results[1].is_season_pack, true);
});

test('OpenSubtitles V3 also rejects explicit wrong-season anime singles before season-pack heuristics', async () => {
  const service = new OpenSubtitlesV3Service();
  service.client = {
    get: async () => ({
      data: {
        subtitles: [
          { id: 'wrong', lang: 'eng', url: 'https://example.com/wrong.srt', name: 'Jujutsu Kaisen S3 - 03 [@AniWide] [translated]' },
          { id: 'right', lang: 'eng', url: 'https://example.com/right.srt', name: 'Jujutsu Kaisen S3 - 10 [@AniWide] [translated]' },
          { id: 'pack', lang: 'eng', url: 'https://example.com/pack.zip', name: 'Jujutsu Kaisen 01-12 [Batch]' }
        ]
      }
    })
  };
  service.extractFilenames = async (subtitles) => subtitles;

  const results = await service.searchSubtitles({
    imdb_id: 'tt12343534',
    type: 'anime-episode',
    season: 3,
    episode: 10,
    languages: ['eng']
  });

  assert.deepEqual(results.map(result => result.name), [
    'Jujutsu Kaisen S3 - 10 [@AniWide] [translated]',
    'Jujutsu Kaisen 01-12 [Batch]'
  ]);
  assert.equal(results[1].is_season_pack, true);
});

test('SCS results expose numeric downloads and rating for source-subtitle metadata', async () => {
  const downloadToken = 'eyJjb250ZW50X3R5cGUiOiJzZXJpZXMiLCJjb250ZW50X2lkIjoidHQwOTQ0OTQ3OjE6MSIsImxhbmciOiJlbmcifQ';
  const scs = new StremioCommunitySubtitlesService();
  scs.client = {
    get: async () => ({
      data: {
        subtitles: [
          {
            id: 'Game.of.Thrones.S01E01.1080p.[Org.Jio DDP5.1]_eng',
            lang: 'eng',
            url: `https://stremio-community-subtitles.top/test-token/download/${downloadToken}.vtt`
          }
        ]
      }
    })
  };

  const results = await scs.searchSubtitles({
    animeId: 'kitsu:1',
    animeIdType: 'kitsu',
    type: 'anime-episode',
    season: 1,
    episode: 1,
    languages: ['eng']
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].downloads, 0);
  assert.equal(results[0].rating, 0);
  assert.equal(results[0].id, `scs_${downloadToken}`);
  assert.equal(results[0].fileId, `scs_${downloadToken}`);
  assert.match(results[0].fileId, /^scs_[A-Za-z0-9_-]+$/);
});

test('SCS search falls back to a future sanitized sub.id when the download URL shape changes', async () => {
  const scs = new StremioCommunitySubtitlesService();
  scs.client = {
    get: async () => ({
      data: {
        subtitles: [
          {
            id: 'comm_future_safe_id',
            lang: 'eng',
            url: 'https://stremio-community-subtitles.top/test-token/not-download-shaped'
          }
        ]
      }
    })
  };

  const results = await scs.searchSubtitles({
    animeId: 'kitsu:1',
    animeIdType: 'kitsu',
    type: 'anime-episode',
    season: 1,
    episode: 1,
    languages: ['eng']
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'scs_comm_future_safe_id');
  assert.equal(results[0].fileId, 'scs_comm_future_safe_id');
});

test('SCS search can route-encode a future unsafe sub.id when the download URL shape changes', async () => {
  const unsafeIdentifier = 'Cross S02E02 eng_eng_ass';
  const scs = new StremioCommunitySubtitlesService();
  scs.client = {
    get: async () => ({
      data: {
        subtitles: [
          {
            id: unsafeIdentifier,
            lang: 'eng',
            url: 'https://stremio-community-subtitles.top/test-token/not-download-shaped'
          }
        ]
      }
    })
  };

  const results = await scs.searchSubtitles({
    animeId: 'kitsu:1',
    animeIdType: 'kitsu',
    type: 'anime-episode',
    season: 1,
    episode: 1,
    languages: ['eng']
  });

  assert.equal(results.length, 1);
  assert.match(results[0].fileId, /^scs_idb64_[A-Za-z0-9_-]+$/);
});

test('SCS search base64url-encodes unsafe upstream identifiers into route-safe fileIds', async () => {
  const unsafeIdentifier = 'Cross S02E02 eng_eng_ass';
  const scs = new StremioCommunitySubtitlesService();
  scs.client = {
    get: async () => ({
      data: {
        subtitles: [
          {
            id: unsafeIdentifier,
            lang: 'eng',
            url: `https://stremio-community-subtitles.top/test-token/download/${encodeURIComponent(unsafeIdentifier)}.vtt`
          }
        ]
      }
    })
  };

  const results = await scs.searchSubtitles({
    animeId: 'kitsu:1',
    animeIdType: 'kitsu',
    type: 'anime-episode',
    season: 1,
    episode: 1,
    languages: ['eng']
  });

  assert.equal(results.length, 1);
  assert.match(results[0].fileId, /^scs_idb64_[A-Za-z0-9_-]+$/);
});

test('SCS download accepts live token identifiers and legacy comm_ identifiers', async () => {
  const scs = new StremioCommunitySubtitlesService();
  const requests = [];
  scs.client = {
    get: async (url, config) => {
      requests.push({ url, config });
      return {
        data: Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n')
      };
    }
  };

  const liveToken = 'eyJsaXZlX3Rva2VuIjoidHJ1ZSJ9';
  const legacyToken = 'comm_eyJsZWdhY3lfdG9rZW4iOiJ0cnVlIn0';
  const unsafeIdentifier = 'Cross S02E02 eng_eng_ass';
  const encodedUnsafeToken = `idb64_${Buffer.from(unsafeIdentifier, 'utf8').toString('base64url')}`;

  const liveContent = await scs.downloadSubtitle(liveToken, { timeout: 4321, languageHint: 'eng' });
  const legacyContent = await scs.downloadSubtitle(legacyToken, { timeout: 9876, languageHint: 'eng' });
  const encodedUnsafeContent = await scs.downloadSubtitle(encodedUnsafeToken, { timeout: 2468, languageHint: 'eng' });

  assert.match(liveContent, /^WEBVTT/);
  assert.match(legacyContent, /^WEBVTT/);
  assert.match(encodedUnsafeContent, /^WEBVTT/);
  assert.deepEqual(
    requests.map(({ url, config }) => ({
      url,
      timeout: config.timeout,
      responseType: config.responseType
    })),
    [
      {
        url: `/${scs.manifestToken}/download/${liveToken}.vtt`,
        timeout: 4321,
        responseType: 'arraybuffer'
      },
      {
        url: `/${scs.manifestToken}/download/eyJsZWdhY3lfdG9rZW4iOiJ0cnVlIn0.vtt`,
        timeout: 9876,
        responseType: 'arraybuffer'
      },
      {
        url: `/${scs.manifestToken}/download/${encodeURIComponent(unsafeIdentifier)}.vtt`,
        timeout: 2468,
        responseType: 'arraybuffer'
      }
    ]
  );
});

test('source-language filtering keeps requested equivalents and drops unrelated provider leaks', () => {
  const filtered = filterSubtitlesByRequestedLanguages([
    { languageCode: 'eng', name: 'English' },
    { languageCode: 'spa', name: 'Spanish' },
    { languageCode: 'spn', name: 'Spanish LatAm' },
    { languageCode: 'tur', name: 'Turkish' },
    { languageCode: 'pol', name: 'Polish' }
  ], ['eng', 'spa']);

  assert.deepEqual(filtered.map(sub => sub.languageCode), ['eng', 'spa', 'spn']);
});

test('source-language filtering preserves the normalized provider code for the full translation language surface', () => {
  const requestedLanguages = getAllTranslationLanguages();

  for (const { code } of requestedLanguages) {
    const normalized = normalizeLanguageCode(code);
    if (!normalized) {
      continue;
    }

    const filtered = filterSubtitlesByRequestedLanguages([
      { languageCode: normalized, name: normalized }
    ], [code]);

    assert.equal(
      filtered.length,
      1,
      `expected ${code} -> ${normalized} to survive requested-language filtering`
    );
  }
});

test('main subtitle route honors the season-pack config preference', async (t) => {
  const originalSearch = WyzieSubsService.prototype.searchSubtitles;
  WyzieSubsService.prototype.searchSubtitles = async () => [
    {
      fileId: 'episode-only',
      languageCode: 'eng',
      name: 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP',
      provider: 'WyzieSubs',
      format: 'srt'
    },
    {
      fileId: 'season-pack',
      languageCode: 'eng',
      name: 'Game.of.Thrones.Season.1.Pack.1080p',
      provider: 'WyzieSubs',
      format: 'srt',
      is_season_pack: true
    }
  ];
  t.after(() => {
    WyzieSubsService.prototype.searchSubtitles = originalSearch;
  });

  const handler = createSubtitleHandler(createMainRouteConfig({
    __configHash: 'main-season-pack-off',
    enableSeasonPacks: false
  }));
  const results = await handler({ type: 'series', id: 'tt0944947:1:1', extra: { filename: 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP.mkv' } });

  assert.deepEqual(results.subtitles.map(sub => sub.id), ['episode-only']);
});

test('main subtitle route deduplicates duplicate rows before returning', async (t) => {
  const originalSearch = WyzieSubsService.prototype.searchSubtitles;
  WyzieSubsService.prototype.searchSubtitles = async () => [
    {
      fileId: 'duplicate-a',
      languageCode: 'eng',
      name: 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP',
      provider: 'WyzieSubs',
      format: 'srt'
    },
    {
      fileId: 'duplicate-b',
      languageCode: 'eng',
      name: 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP',
      provider: 'WyzieSubs',
      format: 'srt'
    },
    {
      fileId: 'different-release',
      languageCode: 'eng',
      name: 'Game.of.Thrones.S01E01.720p.HDTV.x264-GRP',
      provider: 'WyzieSubs',
      format: 'srt'
    }
  ];
  t.after(() => {
    WyzieSubsService.prototype.searchSubtitles = originalSearch;
  });

  const handler = createSubtitleHandler(createMainRouteConfig({
    __configHash: 'main-dedup-on'
  }));
  const results = await handler({ type: 'series', id: 'tt0944947:1:1', extra: { filename: 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP.mkv' } });

  assert.deepEqual(results.subtitles.map(sub => sub.id), ['duplicate-a', 'different-release']);
});

test('main subtitle route applies the per-language cap after ranking', async (t) => {
  const originalSearch = WyzieSubsService.prototype.searchSubtitles;
  WyzieSubsService.prototype.searchSubtitles = async () => [
    {
      fileId: 'poor',
      languageCode: 'eng',
      name: 'Random.Show.S01E09.480p.HDTV.XviD-BAD',
      provider: 'WyzieSubs',
      format: 'srt'
    },
    {
      fileId: 'perfect',
      languageCode: 'eng',
      name: 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP',
      provider: 'WyzieSubs',
      format: 'srt'
    },
    {
      fileId: 'good',
      languageCode: 'eng',
      name: 'Game.of.Thrones.S01E01.720p.HDTV.x264-GRP',
      provider: 'WyzieSubs',
      format: 'srt'
    }
  ];
  t.after(() => {
    WyzieSubsService.prototype.searchSubtitles = originalSearch;
  });

  const handler = createSubtitleHandler(createMainRouteConfig({
    __configHash: `main-cap-${Date.now()}-${Math.random()}`,
    maxSubtitlesPerLanguage: 2
  }));
  const results = await handler({ type: 'series', id: 'tt0944947:1:1', extra: { filename: 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP.mkv' } });

  assert.deepEqual(results.subtitles.map(sub => sub.id), ['perfect', 'good']);
});

test('main subtitle route respects orchestration timeout behavior', async (t) => {
  const originalWyzieSearch = WyzieSubsService.prototype.searchSubtitles;
  const originalSubsRoSearch = SubsRoService.prototype.searchSubtitles;

  WyzieSubsService.prototype.searchSubtitles = async () => {
    await sleep(50);
    return [
      {
        fileId: 'fast',
        languageCode: 'eng',
        name: 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP',
        provider: 'WyzieSubs',
        format: 'srt'
      }
    ];
  };
  SubsRoService.prototype.searchSubtitles = async () => {
    await sleep(1500);
    return [
      {
        fileId: 'slow',
        languageCode: 'eng',
        name: 'Game.of.Thrones.S01E01.720p.HDTV.x264-GRP',
        provider: 'SubsRo',
        format: 'srt'
      }
    ];
  };

  t.after(() => {
    WyzieSubsService.prototype.searchSubtitles = originalWyzieSearch;
    SubsRoService.prototype.searchSubtitles = originalSubsRoSearch;
  });

  const handler = createSubtitleHandler(createMainRouteConfig({
    __configHash: `main-timeout-${Date.now()}-${Math.random()}`,
    subtitleProviderTimeout: 1,
    subtitleProviders: {
      opensubtitles: { enabled: false, implementationType: 'v3' },
      subdl: { enabled: false, apiKey: '' },
      subsource: { enabled: false, apiKey: '' },
      scs: { enabled: false },
      wyzie: { enabled: true, sources: {} },
      subsro: { enabled: true, apiKey: 'test-key' }
    }
  }));

  const startedAt = Date.now();
  const results = await handler({ type: 'series', id: 'tt0944947:1:1', extra: { filename: 'Game.of.Thrones.S01E01.1080p.WEB.h264-GRP.mkv' } });
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(results.subtitles.map(sub => sub.id), ['fast']);
  assert.ok(elapsedMs < 1400, `expected main route to return before slow provider finished, got ${elapsedMs}ms`);
});

test('OpenSubtitles auth limiter enforces the shared 4 req/sec budget across pods', async (t) => {
  resetRateLimiterState();
  t.after(() => resetRateLimiterState());

  const fake = createFakeRateLimitAdapter();

  for (let i = 0; i < 4; i++) {
    const attempt = await tryAcquireDistributedRateLimitSlot({ adapter: fake.adapter });
    assert.equal(attempt.acquired, true);
    assert.equal(attempt.count, i + 1);
  }

  const denied = await tryAcquireDistributedRateLimitSlot({ adapter: fake.adapter });
  assert.equal(denied.acquired, false);
  assert.equal(denied.count, 4);
  assert.ok(denied.retryAfterMs > 0);

  fake.advance(denied.retryAfterMs + 1);

  const nextWindow = await tryAcquireDistributedRateLimitSlot({ adapter: fake.adapter });
  assert.equal(nextWindow.acquired, true);
  assert.equal(nextWindow.count, 1);
});

test('OpenSubtitles auth limiter falls back cleanly when Redis is unavailable', async () => {
  resetRateLimiterState();

  const result = await tryAcquireDistributedRateLimitSlot({
    adapter: {
      client: null,
      _getKey(key) {
        return key;
      }
    }
  });

  assert.equal(result, null);
});

test('Gemini 429 parser points users to API key usage instead of waiting', () => {
  const parsed = parseApiError(
    {
      message: '429 Too Many Requests',
      response: { status: 429 }
    },
    'Gemini',
    { lang: 'en' }
  );

  assert.equal(parsed.type, 'rate_limit');
  assert.equal(parsed.statusCode, 429);
  assert.match(parsed.userMessage, /API key usage\/quota/i);
  assert.doesNotMatch(parsed.userMessage, /wait a few minutes/i);
});

test('Gemini 429 subtitle keeps the 0-4h cue and removes the retry-in-minutes guidance', () => {
  const srt = createTranslationErrorSubtitle('429', 'Gemini rate limit exceeded', 'pt-br', 'gemini');

  assert.match(srt, /00:00:00,000 --> 04:00:00,000/);
  assert.match(srt, /uso\/cota da sua chave de API do Gemini/i);
  assert.doesNotMatch(srt, /alguns minutos/i);
});
