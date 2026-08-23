'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');

const { detectAndConvertEncoding } = require('./encodingDetector');

function makeSubtitle(text, encoding) {
  return iconv.encode(`1\r\n00:00:01,000 --> 00:00:03,000\r\n${text}\r\n`, encoding);
}

function assertDecodes({ name, hint, encoding, text }) {
  const encoded = makeSubtitle(text, encoding);
  assert.equal(
    iconv.decode(encoded, encoding).includes(text),
    true,
    `${name} fixture must be representable as ${encoding}`
  );
  const decoded = detectAndConvertEncoding(encoded, `Encoding test: ${name}`, hint);
  assert.equal(decoded.includes(text), true, `${name} was corrupted while decoding ${encoding}`);
  assert.equal(decoded.includes('\uFFFD'), false, `${name} contains replacement characters`);
}

test('valid UTF-8 is never reinterpreted as a language-specific legacy codepage', () => {
  const cases = [
    { name: 'Serbian Latin', hint: 'srp', text: 'Zašto ćutiš? Čovek kaže: Đak živi u Nišu.' },
    { name: 'Serbian Cyrillic', hint: 'srp', text: 'Зашто ћутиш? Ђак живи у Нишу.' },
    { name: 'Arabic', hint: 'ara', text: 'مرحبا بالعالم' },
    { name: 'Japanese', hint: 'jpn', text: '日本語の字幕です。' },
    { name: 'emoji and supplementary Unicode', hint: 'eng', text: 'Unicode stays intact: 😀 𐍈' }
  ];

  for (const entry of cases) {
    assertDecodes({ ...entry, encoding: 'utf-8' });
  }
});

test('generic Serbian hints preserve both Latin and Cyrillic legacy subtitles', () => {
  const latin = 'Zašto ćutiš? Čovek kaže: Đak živi u Nišu.';
  const cyrillic = 'Зашто ћутиш? Ђак живи у Нишу.';

  for (const hint of ['sr', 'srp', 'serbian']) {
    assertDecodes({ name: `${hint} Windows Latin`, hint, encoding: 'windows-1250', text: latin });
    assertDecodes({ name: `${hint} ISO Latin`, hint, encoding: 'iso-8859-2', text: latin });
    assertDecodes({ name: `${hint} Windows Cyrillic`, hint, encoding: 'windows-1251', text: cyrillic });
    assertDecodes({ name: `${hint} ISO Cyrillic`, hint, encoding: 'iso-8859-5', text: cyrillic });
  }

  assertDecodes({ name: 'explicit Serbian Latin script', hint: 'sr-Latn', encoding: 'windows-1250', text: latin });
  assertDecodes({ name: 'explicit Serbian Cyrillic script', hint: 'sr-Cyrl', encoding: 'windows-1251', text: cyrillic });
});

test('regional single-byte encodings use the subtitle language instead of a lookalike codepage', () => {
  const cases = [
    { name: 'French', hint: 'fra', encoding: 'windows-1252', text: 'Ça va ? L’élève préfère déjà Noël.' },
    { name: 'German', hint: 'deu', encoding: 'windows-1252', text: 'Falsches Üben von Xylophonmusik quält jeden größeren Zwerg.' },
    { name: 'Portuguese', hint: 'por', encoding: 'windows-1252', text: 'Luís argüia à Júlia que bênçãos vêm do céu.' },
    { name: 'Spanish', hint: 'spa', encoding: 'windows-1252', text: 'El pingüino Wenceslao hizo kilómetros bajo exhaustiva lluvia y frío.' },
    { name: 'Albanian', hint: 'sqi', encoding: 'windows-1250', text: 'Çdo gjë është në rregull.' },
    { name: 'Bosnian', hint: 'bos', encoding: 'windows-1250', text: 'Čovjek kaže: želim ići kući.' },
    { name: 'Croatian', hint: 'hrv', encoding: 'windows-1250', text: 'Čovjek šuti, želi ići kući. Đak ćuti.' },
    { name: 'Czech', hint: 'ces', encoding: 'windows-1250', text: 'Příliš žluťoučký kůň úpěl ďábelské ódy.' },
    { name: 'Hungarian', hint: 'hun', encoding: 'windows-1250', text: 'Árvíztűrő tükörfúrógép.' },
    { name: 'Polish', hint: 'pol', encoding: 'windows-1250', text: 'Zażółć gęślą jaźń.' },
    { name: 'Romanian legacy', hint: 'ron', encoding: 'windows-1250', text: 'Muzicologă în bej vând whisky şi tequila, preţ fix.' },
    { name: 'Slovak', hint: 'slk', encoding: 'windows-1250', text: 'Kŕdeľ ďatľov učí koňa žrať kôru.' },
    { name: 'Slovenian', hint: 'slv', encoding: 'windows-1250', text: 'Čmrlj šviga čez drn in strn.' },
    { name: 'Estonian', hint: 'est', encoding: 'windows-1257', text: 'Põdur tšellomängija külmetas kehvas garaažis.' },
    { name: 'Latvian', hint: 'lav', encoding: 'windows-1257', text: 'Muļķa hipiji mēģina nogaršot žņaudzējčūsku.' },
    { name: 'Lithuanian', hint: 'lit', encoding: 'windows-1257', text: 'Įlinkdama špaga pragręžė apvalų arbūzą.' },
    { name: 'Estonian ISO', hint: 'est', encoding: 'iso-8859-13', text: 'Põdur tšellomängija külmetas kehvas garaažis.' }
  ];

  for (const entry of cases) assertDecodes(entry);
});

test('existing non-Latin legacy codepage support remains intact', () => {
  const cases = [
    { name: 'Arabic', hint: 'ara', encoding: 'windows-1256', text: 'مرحبا بالعالم' },
    { name: 'Belarusian', hint: 'bel', encoding: 'windows-1251', text: 'Прывітанне, свет. Ўсё добра.' },
    { name: 'Bulgarian', hint: 'bul', encoding: 'windows-1251', text: 'Здравей, свят.' },
    { name: 'Hebrew', hint: 'heb', encoding: 'windows-1255', text: 'שלום עולם' },
    { name: 'Greek', hint: 'ell', encoding: 'windows-1253', text: 'Καλημέρα κόσμε.' },
    { name: 'Macedonian', hint: 'mkd', encoding: 'windows-1251', text: 'Здраво свету. Ѓорѓи и Љубица.' },
    { name: 'Russian', hint: 'rus', encoding: 'windows-1251', text: 'Съешь ещё этих мягких французских булок.' },
    { name: 'Thai', hint: 'tha', encoding: 'windows-874', text: 'สวัสดีชาวโลก' },
    { name: 'Turkish', hint: 'tur', encoding: 'windows-1254', text: 'Pijamalı hasta yağız şoföre çabucak güvendi.' },
    { name: 'Chinese', hint: 'zho', encoding: 'gb18030', text: '中文字幕测试。' },
    { name: 'Japanese', hint: 'jpn', encoding: 'shift_jis', text: '日本語の字幕です。' },
    { name: 'Korean', hint: 'kor', encoding: 'euc-kr', text: '한국어 자막입니다.' }
  ];

  for (const entry of cases) assertDecodes(entry);
});

test('UTF BOM handling remains intact', () => {
  const text = '1\r\n00:00:01,000 --> 00:00:03,000\r\nZašto? 日本語.\r\n';
  const utf8Bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
  const utf16LeBom = Buffer.concat([Buffer.from([0xFF, 0xFE]), iconv.encode(text, 'utf16-le')]);
  const utf16BeBom = Buffer.concat([Buffer.from([0xFE, 0xFF]), iconv.encode(text, 'utf16-be')]);

  assert.equal(detectAndConvertEncoding(utf8Bom, 'UTF-8 BOM', 'srp'), text);
  assert.equal(detectAndConvertEncoding(utf16LeBom, 'UTF-16LE BOM', 'srp'), text);
  assert.equal(detectAndConvertEncoding(utf16BeBom, 'UTF-16BE BOM', 'srp'), text);
});
