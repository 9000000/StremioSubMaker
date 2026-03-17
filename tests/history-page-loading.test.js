const test = require('node:test');
const assert = require('node:assert/strict');

const { generateHistoryPage, renderHistoryContent } = require('../src/utils/historyPageGenerator');

test('generateHistoryPage can render a deferred history shell', () => {
  const html = generateHistoryPage(
    'session_token',
    [],
    {
      uiLanguage: 'en',
      targetLanguages: ['pt-BR'],
      sourceLanguages: ['en'],
      languageMaps: {}
    },
    'video-1',
    'Example.srt',
    {
      deferHistoryLoad: true,
      historyContentEndpoint: '/api/sub-history-content?config=session_token&videoId=video-1'
    }
  );

  assert.match(html, /Loading translation history/);
  assert.match(html, /data-history-deferred="true"/);
  assert.match(html, /data-history-endpoint="\/api\/sub-history-content\?config=session_token&amp;videoId=video-1"/);
});

test('renderHistoryContent shows the empty state when there are no entries', () => {
  const html = renderHistoryContent(
    'session_token',
    [],
    {
      uiLanguage: 'en'
    },
    '',
    ''
  );

  assert.match(html, /No history yet/);
  assert.match(html, /history-shell/);
});
