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
  filterSubtitlesByRequestedLanguages
} = require('../src/handlers/subtitles');
const StremioCommunitySubtitlesService = require('../src/services/stremioCommunitySubtitles');
const WyzieSubsService = require('../src/services/wyzieSubs');
const SubsRoService = require('../src/services/subsRo');
const SubSourceService = require('../src/services/subsource');
const OpenSubtitlesV3Service = require('../src/services/opensubtitles-v3');

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
  const scs = new StremioCommunitySubtitlesService();
  scs.client = {
    get: async () => ({
      data: {
        subtitles: [
          {
            id: 'comm_test',
            lang: 'eng',
            url: 'https://example.com/subtitle.vtt'
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
