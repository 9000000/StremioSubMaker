const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function runHelperScript(script) {
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: repoRoot,
        env: {
            ...process.env,
            LOG_LEVEL: 'warn',
            LOG_TO_FILE: 'false'
        },
        encoding: 'utf8'
    });

    assert.equal(result.status, 0, `helper subprocess failed: ${result.stderr || 'unknown error'}`);
    assert.ok(result.stdout, 'helper subprocess produced no output');
    return JSON.parse(result.stdout);
}

test('ASS helper preserves override tags, drawing payloads, and AI-adjusted timings', () => {
    const assInput = [
        '[Script Info]',
        'Title: Test',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Hello\\N{\\i1}world',
        'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 0 10 10 0 10{\\p0}'
    ].join('\n');
    const translatedSrt = '1\n00:00:01,500 --> 00:00:03,700\nHola\nmundo\n';
    const script = `
const { extractTags, reinsertTags, parseASSForTranslation, buildSRTFromASSDialogue, reassembleASS } = require('./src/utils/assTranslationHelper');
const extracted = extractTags(${JSON.stringify('{\\an8}Hello\\N{\\i1}world')});
const parsed = parseASSForTranslation(${JSON.stringify(assInput)});
const tempSrt = buildSRTFromASSDialogue(parsed.dialogueEntries);
const reassembled = reassembleASS(parsed, ${JSON.stringify(translatedSrt)});
process.stdout.write(JSON.stringify({
  cleanText: extracted.cleanText,
  preservedSegments: extracted.preservedSegments,
  reinserted: reinsertTags('Hola\\nmundo', extracted.preservedSegments, extracted.cleanText.length),
  tempSrt,
  reassembled
}));
process.exit(0);
`;

    const result = runHelperScript(script);

    assert.equal(result.cleanText, 'Hello\nworld');
    assert.deepEqual(result.preservedSegments, [
        { position: 0, raw: '{\\an8}' },
        { position: 6, raw: '{\\i1}' }
    ]);
    assert.equal(result.reinserted, '{\\an8}Hola\\N{\\i1}mundo');
    assert.equal(result.tempSrt, '1\n00:00:01,000 --> 00:00:03,000\nHello\nworld\n');
    assert.match(result.reassembled, /Dialogue: 0,0:00:01\.50,0:00:03\.70,Default,,0,0,0,,\{\\an8\}Hola\\N\{\\i1\}mundo/);
    assert.match(result.reassembled, /Dialogue: 0,0:00:04\.00,0:00:05\.00,Default,,0,0,0,,\{\\p1\}m 0 0 l 10 0 10 10 0 10\{\\p0\}/);
});

test('ASS helper produces no temp SRT for draw-only dialogue and reassembles original content on empty translation', () => {
    const assInput = [
        '[Script Info]',
        'Title: Draw Only',
        '[V4+ Styles]',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 0 10 10 0 10{\\p0}'
    ].join('\n');
    const script = `
const { parseASSForTranslation, buildSRTFromASSDialogue, reassembleASS } = require('./src/utils/assTranslationHelper');
const parsed = parseASSForTranslation(${JSON.stringify(assInput)});
const tempSrt = buildSRTFromASSDialogue(parsed.dialogueEntries);
const rebuilt = reassembleASS(parsed, '');
process.stdout.write(JSON.stringify({ tempSrt, rebuilt }));
process.exit(0);
`;

    const result = runHelperScript(script);

    assert.equal(result.tempSrt, '');
    assert.equal(result.rebuilt, assInput);
});
