const test = require('node:test');
const assert = require('node:assert/strict');

const {
  subtitleMatchesRequestedLanguage,
  buildStremioSubtitleVariantLabel,
  createTranslationErrorSubtitle
} = require('./subtitles');

function makeSubtitle(id, languageCode, provider = 'test') {
  return {
    id,
    fileId: id,
    languageCode,
    name: `${id}.srt`,
    provider
  };
}

test('translation sources accept configured language equivalents', () => {
  assert.equal(subtitleMatchesRequestedLanguage(makeSubtitle('latam', 'spn'), 'spa'), true);
  assert.equal(subtitleMatchesRequestedLanguage(makeSubtitle('simplified', 'zhs'), 'chi'), true);
  assert.equal(subtitleMatchesRequestedLanguage(makeSubtitle('bokmal', 'nob'), 'nor'), true);
  assert.equal(subtitleMatchesRequestedLanguage(makeSubtitle('english', 'eng'), 'pob'), false);
});

test('modern Stremio variant labels identify the source instead of repeating only its language', () => {
  const label = buildStremioSubtitleVariantLabel({
    originalFilename: 'Example.Show.S01E02.WEB-DL.srt',
    provider: 'opensubtitles'
  });

  assert.equal(label, 'Example.Show.S01E02.WEB-DL.srt • opensubtitles');
});

test('Gemini location failures use a concise title-only visible cue', () => {
  const subtitle = createTranslationErrorSubtitle(
    'GEMINI_UNSUPPORTED_LOCATION',
    'ignored provider detail',
    'en',
    'gemini'
  );
  const visibleCue = subtitle.split(/\r?\n\r?\n/, 1)[0];

  assert.equal(
    visibleCue,
    '1\n00:00:00,000 --> 04:00:00,000\nTranslation Failed: Gemini Rejected Server Location'
  );
});
