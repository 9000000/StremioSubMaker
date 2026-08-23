'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');

const SubDLService = require('./subdl');
const { handleSubtitleDownload } = require('../handlers/subtitles');

test('SubDL accepts and converts a plain legacy-encoded MicroDVD response', async () => {
  const originalGet = SubDLService.downloadClient.get;
  const source = '{25}{50}Zašto ćutiš?|Čovek kaže: Đak živi u Nišu.\r\n';
  let requestedUrl;
  let requestConfig;

  SubDLService.downloadClient.get = async (url, config) => {
    requestedUrl = url;
    requestConfig = config;
    return {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      data: iconv.encode(source, 'windows-1250')
    };
  };

  try {
    const result = await new SubDLService('  test-key  ').downloadSubtitle('subdl_1_2', {
      timeout: 12000,
      languageHint: 'srp'
    });

    assert.equal(requestedUrl, 'https://dl.subdl.com/subtitle/1-2.zip');
    assert.equal(requestConfig.headers['x-api-key'], 'test-key');
    assert.doesNotMatch(requestedUrl, /api_key|test-key/i);
    assert.match(result, /^WEBVTT/m);
    assert.match(result, /Zašto ćutiš\?/);
    assert.match(result, /Čovek kaže: Đak živi u Nišu\./);
    assert.doesNotMatch(result, /Zaљto|Иovek|�/);
  } finally {
    SubDLService.downloadClient.get = originalGet;
  }
});

test('SubDL identifies supported plain subtitle structures and rejects error documents', () => {
  const { detectPlainSubtitleFormat } = SubDLService.__testing;
  assert.equal(detectPlainSubtitleFormat(Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHello')), 'vtt');
  assert.equal(detectPlainSubtitleFormat(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello')), 'srt');
  assert.equal(detectPlainSubtitleFormat(Buffer.from('[Script Info]\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello')), 'ass');
  assert.equal(detectPlainSubtitleFormat(Buffer.from('{25}{50}Hello')), 'sub');
  assert.equal(detectPlainSubtitleFormat(Buffer.from('{"error":"Not authorized"}')), null);
  assert.equal(detectPlainSubtitleFormat(Buffer.from('<html><body>blocked</body></html>')), null);
});

test('SubDL never falls back to an anonymous archive download without an API key', async (t) => {
  const originalGet = SubDLService.downloadClient.get;
  let downloadCalls = 0;
  t.after(() => {
    SubDLService.downloadClient.get = originalGet;
  });

  SubDLService.downloadClient.get = async () => {
    downloadCalls += 1;
    throw new Error('anonymous download should not be attempted');
  };

  await assert.rejects(
    new SubDLService('').downloadSubtitle('subdl_1_2'),
    error => error.statusCode === 401 && error.type === 'authentication'
  );
  assert.equal(downloadCalls, 0);
});

test('SubDL download-time 429 renders accurate key-quota guidance for Stremio', async (t) => {
  const originalDownload = SubDLService.prototype.downloadSubtitle;
  t.after(() => {
    SubDLService.prototype.downloadSubtitle = originalDownload;
  });

  SubDLService.prototype.downloadSubtitle = async function () {
    const error = new Error('Request failed with status code 429');
    error.response = { status: 429, data: { message: 'Too many requests' }, headers: {} };
    throw error;
  };

  const subtitle = await handleSubtitleDownload('subdl_1_2', 'eng', {
    __configHash: 'subdl-quota-guidance-test',
    uiLanguage: 'en',
    convertAssToVtt: true,
    forceSRTOutput: false,
    subtitleProviders: {
      subdl: { enabled: true, apiKey: 'test-key' }
    }
  });

  assert.match(subtitle, /SubDL download quota reached \(429\)/);
  assert.match(subtitle, /This SubDL API key cannot download more files right now\./);
  assert.match(subtitle, /wait for the quota reset/);
  assert.doesNotMatch(subtitle, /wait a few minutes/i);
});
