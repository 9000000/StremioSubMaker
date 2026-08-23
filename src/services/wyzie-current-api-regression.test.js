const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.STORAGE_TYPE = 'filesystem';
process.env.LOG_LEVEL = 'error';

const axios = require('axios');
const WyzieSubsService = require('./wyzieSubs');
const { getDefaultConfig, normalizeConfig } = require('../utils/config');
const StorageFactory = require('../storage/StorageFactory');

test.after(async () => {
    await StorageFactory.reset();
});

test('Wyzie searches all sources available to the key and ignores legacy source selections', async () => {
    const service = new WyzieSubsService('wyzie-regression-search-key');
    let requestedUrl = '';

    service.client.get = async (url) => {
        requestedUrl = url;
        return {
            data: [{
                id: 'result-1',
                language: 'en',
                release: 'Example.Release',
                source: 'charlie',
                format: 'srt',
                url: 'https://downloads.example.test/example.srt'
            }]
        };
    };

    const results = await service.searchSubtitles({
        imdb_id: 'tt0133093',
        type: 'movie',
        languages: ['eng'],
        sources: {
            opensubtitles: false,
            subf2m: true,
            yify: true
        }
    });

    const query = new URL(requestedUrl, 'https://sub.wyzie.io').searchParams;
    assert.equal(query.get('source'), 'all');
    assert.equal(query.get('language'), 'en');
    assert.equal(results.length, 1);
    assert.equal(results[0].provider, 'wyzie');
    assert.match(results[0].fileId, /^wyzie_/);
});

test('Wyzie validation uses the quota-free key-scoped sources endpoint', async () => {
    const service = new WyzieSubsService('wyzie-regression-validation-key');
    let request = null;

    service.client.get = async (url, options) => {
        request = { url, options };
        return {
            status: 200,
            data: {
                key: { valid: true, type: 'free' },
                available: ['charlie', 'lima'],
                restricted: ['bravo']
            }
        };
    };

    const result = await service.validateApiKey({ timeout: 4321 });

    assert.equal(request.url, '/sources');
    assert.equal(request.options.params.key, 'wyzie-regression-validation-key');
    assert.equal(request.options.timeout, 4321);
    assert.deepEqual(result, {
        valid: true,
        validationMode: 'sources',
        status: 200,
        keyType: 'free',
        availableSources: ['charlie', 'lima'],
        restrictedSources: ['bravo']
    });
});

test('legacy Wyzie source settings are removed during config normalization', () => {
    const config = getDefaultConfig();
    config.subtitleProviders.wyzie = {
        enabled: true,
        apiKey: 'wyzie-regression-config-key',
        sources: {
            opensubtitles: true,
            animetosho: true,
            yify: true
        }
    };

    const normalized = normalizeConfig(config);

    assert.equal(normalized.subtitleProviders.wyzie.enabled, true);
    assert.equal(normalized.subtitleProviders.wyzie.apiKey, 'wyzie-regression-config-key');
    assert.equal(Object.hasOwn(normalized.subtitleProviders.wyzie, 'sources'), false);
    assert.equal(normalized.__needsSessionPersist, true);
    assert.equal(normalized.__persistReason, 'wyzie-dynamic-sources-migration');
});

test('Configure and Quick Setup do not expose stale Wyzie source checkboxes', () => {
    const workspaceRoot = path.resolve(__dirname, '..', '..');
    const files = [
        'public/partials/main.html',
        'public/partials/quick-setup.html',
        'public/config.js',
        'public/js/quick-setup.js'
    ];
    const uiSource = files
        .map(file => fs.readFileSync(path.join(workspaceRoot, file), 'utf8'))
        .join('\n');

    assert.doesNotMatch(uiSource, /wyzieSource(?:Open|Sub|Pod|Gest|Anime|Kitsu|Jimaku|Yify)/i);
    assert.doesNotMatch(uiSource, /qsWyzie(?:Subf2m|Podnapisi|Gestdown|Animetosho|Opensubs|Subdl|Kitsunekko|Jimaku|Yify)/i);
    assert.match(uiSource, /store\.wyzie\.io\/redeem/);
    assert.match(uiSource, /qsWyzieConfig/);
});

test('Wyzie downloads current direct HTTPS provider URLs', async () => {
    const originalGet = axios.get;
    const directUrl = 'https://downloads.example.test/example.srt';
    const fileId = `wyzie_${Buffer.from(directUrl).toString('base64url')}`;
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';

    axios.get = async (url) => {
        assert.equal(url, directUrl);
        return { data: Buffer.from(srt) };
    };

    try {
        const service = new WyzieSubsService('wyzie-regression-download-key');
        const content = await service.downloadSubtitle(fileId, { maxRetries: 1 });
        assert.equal(content, srt);
    } finally {
        axios.get = originalGet;
    }
});

test('Wyzie rejects non-HTTPS download URLs', async () => {
    const directUrl = 'http://downloads.example.test/example.srt';
    const fileId = `wyzie_${Buffer.from(directUrl).toString('base64url')}`;
    const service = new WyzieSubsService('wyzie-regression-protocol-key');

    await assert.rejects(
        service.downloadSubtitle(fileId, { maxRetries: 1 }),
        /Unsafe Wyzie download URL protocol/
    );
});
