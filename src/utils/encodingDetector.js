/**
 * Encoding Detection and Conversion Utility
 *
 * Handles character encoding detection and conversion for subtitle files.
 * Many subtitle sources use encodings like ISO-8859-1 (Latin-1), Windows-1252,
 * or other regional encodings instead of UTF-8.
 *
 * This utility ensures all subtitles are properly decoded and converted to UTF-8.
 */

const chardet = require('chardet');
const iconv = require('iconv-lite');
const log = require('./logger');

/**
 * Map of language codes/names to their preferred encodings.
 * When a language hint is provided, these encodings are tried first before
 * falling back to chardet detection, solving misdetection for Arabic/Hebrew/etc.
 * where chardet often confuses regional codepages with Latin-1 or Windows-1252.
 */
const LANGUAGE_ENCODING_HINTS = {
  // Arabic
  ar: ['windows-1256', 'iso-8859-6'],
  ara: ['windows-1256', 'iso-8859-6'],
  arabic: ['windows-1256', 'iso-8859-6'],
  // Hebrew
  he: ['windows-1255', 'iso-8859-8'],
  heb: ['windows-1255', 'iso-8859-8'],
  hebrew: ['windows-1255', 'iso-8859-8'],
  // Persian/Farsi
  fa: ['windows-1256', 'iso-8859-6'],
  fas: ['windows-1256', 'iso-8859-6'],
  per: ['windows-1256', 'iso-8859-6'],
  persian: ['windows-1256', 'iso-8859-6'],
  farsi: ['windows-1256', 'iso-8859-6'],
  // Urdu
  ur: ['windows-1256'],
  urd: ['windows-1256'],
  urdu: ['windows-1256'],
  // Greek
  el: ['windows-1253', 'iso-8859-7'],
  ell: ['windows-1253', 'iso-8859-7'],
  gre: ['windows-1253', 'iso-8859-7'],
  greek: ['windows-1253', 'iso-8859-7'],
  // Turkish
  tr: ['windows-1254', 'iso-8859-9'],
  tur: ['windows-1254', 'iso-8859-9'],
  turkish: ['windows-1254', 'iso-8859-9'],
  // Russian
  ru: ['windows-1251', 'koi8-r'],
  rus: ['windows-1251', 'koi8-r'],
  russian: ['windows-1251', 'koi8-r'],
  // Ukrainian
  uk: ['windows-1251', 'koi8-u'],
  ukr: ['windows-1251', 'koi8-u'],
  ukrainian: ['windows-1251', 'koi8-u'],
  // Bulgarian
  bg: ['windows-1251'],
  bul: ['windows-1251'],
  bulgarian: ['windows-1251'],
  // Serbian (Cyrillic)
  sr: ['windows-1251'],
  srp: ['windows-1251'],
  serbian: ['windows-1251'],
  // Polish
  pl: ['windows-1250', 'iso-8859-2'],
  pol: ['windows-1250', 'iso-8859-2'],
  polish: ['windows-1250', 'iso-8859-2'],
  // Czech
  cs: ['windows-1250', 'iso-8859-2'],
  ces: ['windows-1250', 'iso-8859-2'],
  cze: ['windows-1250', 'iso-8859-2'],
  czech: ['windows-1250', 'iso-8859-2'],
  // Hungarian
  hu: ['windows-1250', 'iso-8859-2'],
  hun: ['windows-1250', 'iso-8859-2'],
  hungarian: ['windows-1250', 'iso-8859-2'],
  // Romanian
  ro: ['windows-1250', 'iso-8859-2'],
  ron: ['windows-1250', 'iso-8859-2'],
  rum: ['windows-1250', 'iso-8859-2'],
  romanian: ['windows-1250', 'iso-8859-2'],
  // Thai
  th: ['windows-874', 'tis-620'],
  tha: ['windows-874', 'tis-620'],
  thai: ['windows-874', 'tis-620'],
  // Vietnamese
  vi: ['windows-1258'],
  vie: ['windows-1258'],
  vietnamese: ['windows-1258'],
  // Chinese (Simplified)
  zh: ['gb18030', 'gbk', 'gb2312'],
  zho: ['gb18030', 'gbk', 'gb2312'],
  chi: ['gb18030', 'gbk', 'gb2312'],
  chinese: ['gb18030', 'gbk', 'gb2312'],
  // Chinese (Traditional)
  'zh-tw': ['big5'],
  'zh-hant': ['big5'],
  // Japanese
  ja: ['shift_jis', 'euc-jp'],
  jpn: ['shift_jis', 'euc-jp'],
  japanese: ['shift_jis', 'euc-jp'],
  // Korean
  ko: ['euc-kr'],
  kor: ['euc-kr'],
  korean: ['euc-kr'],
  // Baltic
  lt: ['windows-1257'],
  lit: ['windows-1257'],
  lithuanian: ['windows-1257'],
  lv: ['windows-1257'],
  lav: ['windows-1257'],
  latvian: ['windows-1257'],
};

/**
 * Resolve a language hint string to preferred encodings.
 * Handles compound codes like "pt-br", "zh-tw", etc.
 * @param {string} langHint - Language code or name
 * @returns {string[]|null} - Preferred encodings or null
 */
function resolveLanguageEncodings(langHint) {
  if (!langHint || typeof langHint !== 'string') return null;
  const normalized = langHint.trim().toLowerCase();
  if (!normalized) return null;

  // Try exact match first (handles "zh-tw", "pt-br", etc.)
  if (LANGUAGE_ENCODING_HINTS[normalized]) {
    return LANGUAGE_ENCODING_HINTS[normalized];
  }

  // Try base language code (e.g., "ar" from "ar-sa")
  const base = normalized.split(/[-_]/)[0];
  if (base && LANGUAGE_ENCODING_HINTS[base]) {
    return LANGUAGE_ENCODING_HINTS[base];
  }

  return null;
}

/**
 * Validate decoded content for a specific script by checking if it contains
 * characters from the expected Unicode range. This catches cases where
 * chardet picks a wrong encoding that produces valid-but-wrong characters.
 * @param {string} decoded - Decoded text
 * @param {string} langHint - Language hint
 * @returns {boolean} - True if content looks valid for the language
 */
function validateDecodedForLanguage(decoded, langHint) {
  if (!decoded || !langHint) return true; // No validation possible

  const normalized = langHint.trim().toLowerCase();
  const base = normalized.split(/[-_]/)[0];

  // Only validate for scripts where chardet commonly misdetects
  // Check if decoded text contains characters from the expected Unicode block
  const scriptChecks = {
    // Arabic script: U+0600–U+06FF
    ar: /[\u0600-\u06FF]/,
    ara: /[\u0600-\u06FF]/,
    arabic: /[\u0600-\u06FF]/,
    fa: /[\u0600-\u06FF]/,
    fas: /[\u0600-\u06FF]/,
    per: /[\u0600-\u06FF]/,
    persian: /[\u0600-\u06FF]/,
    farsi: /[\u0600-\u06FF]/,
    ur: /[\u0600-\u06FF]/,
    urd: /[\u0600-\u06FF]/,
    urdu: /[\u0600-\u06FF]/,
    // Hebrew script: U+0590–U+05FF
    he: /[\u0590-\u05FF]/,
    heb: /[\u0590-\u05FF]/,
    hebrew: /[\u0590-\u05FF]/,
    // Greek script: U+0370–U+03FF
    el: /[\u0370-\u03FF]/,
    ell: /[\u0370-\u03FF]/,
    gre: /[\u0370-\u03FF]/,
    greek: /[\u0370-\u03FF]/,
    // Cyrillic script: U+0400–U+04FF
    ru: /[\u0400-\u04FF]/,
    rus: /[\u0400-\u04FF]/,
    russian: /[\u0400-\u04FF]/,
    uk: /[\u0400-\u04FF]/,
    ukr: /[\u0400-\u04FF]/,
    ukrainian: /[\u0400-\u04FF]/,
    bg: /[\u0400-\u04FF]/,
    bul: /[\u0400-\u04FF]/,
    bulgarian: /[\u0400-\u04FF]/,
    sr: /[\u0400-\u04FF]/,
    srp: /[\u0400-\u04FF]/,
    serbian: /[\u0400-\u04FF]/,
    // Thai script: U+0E00–U+0E7F
    th: /[\u0E00-\u0E7F]/,
    tha: /[\u0E00-\u0E7F]/,
    thai: /[\u0E00-\u0E7F]/,
  };

  const expectedPattern = scriptChecks[normalized] || scriptChecks[base];
  if (!expectedPattern) return true; // No script check for this language

  // Strip SRT formatting (timecodes, numbers, blank lines) to check only text content
  const textOnly = decoded
    .replace(/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/g, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/[a-zA-Z0-9\s\r\n.,!?;:'"()\-–—…\[\]{}/<>\\|@#$%^&*+=~`_]/g, '')
    .trim();

  // If there's meaningful non-ASCII text, check if it contains expected script characters
  if (textOnly.length > 5) {
    return expectedPattern.test(textOnly);
  }

  return true; // Not enough non-ASCII text to validate
}

/**
 * Detect and convert subtitle content to UTF-8
 * @param {Buffer|string} content - Subtitle content (Buffer or string)
 * @param {string} source - Source name for logging (e.g., 'SubSource', 'SubDL')
 * @param {string} [languageHint] - Optional language code hint (e.g., 'ar', 'he', 'heb') to bias encoding detection
 * @returns {string} - UTF-8 encoded string
 */
function detectAndConvertEncoding(content, source = 'Unknown', languageHint = null) {
  try {
    // If content is already a string, assume it's been decoded somehow
    // We'll try to detect if it has encoding issues
    if (typeof content === 'string') {
      // Check for common encoding corruption patterns
      // If we see replacement characters or other issues, try to re-encode
      if (content.includes('\uFFFD') || content.includes('�')) {
        log.warn(() => `[${source}] Detected replacement characters in string, may indicate encoding issues`);
      }
      return content;
    }

    // Convert to Buffer if needed
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);

    // Check for UTF-8 BOM (EF BB BF)
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      log.debug(() => `[${source}] Detected UTF-8 BOM, decoding as UTF-8`);
      return buffer.slice(3).toString('utf-8');
    }

    // Check for UTF-16 BOMs
    if (buffer.length >= 2) {
      // UTF-16 LE BOM (FF FE)
      if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        log.debug(() => `[${source}] Detected UTF-16LE BOM, decoding as UTF-16LE`);
        return iconv.decode(buffer.slice(2), 'utf-16le');
      }
      // UTF-16 BE BOM (FE FF)
      if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
        log.debug(() => `[${source}] Detected UTF-16BE BOM, decoding as UTF-16BE`);
        return iconv.decode(buffer.slice(2), 'utf-16be');
      }
    }

    // Use chardet to detect encoding
    // Sample first 4KB for detection (faster and usually accurate enough)
    const sampleSize = Math.min(buffer.length, 4096);
    const sample = buffer.slice(0, sampleSize);

    const detected = chardet.detect(sample);

    if (detected) {
      log.debug(() => `[${source}] Detected encoding: ${detected}${languageHint ? ` (language hint: ${languageHint})` : ''}`);

      // Map detected encoding to iconv-lite compatible name
      const encodingMap = {
        'UTF-8': 'utf-8',
        'UTF-16LE': 'utf-16le',
        'UTF-16BE': 'utf-16be',
        'ISO-8859-1': 'iso-8859-1',
        'ISO-8859-2': 'iso-8859-2',
        'ISO-8859-6': 'iso-8859-6',      // Arabic
        'ISO-8859-7': 'iso-8859-7',      // Greek
        'ISO-8859-8': 'iso-8859-8',      // Hebrew
        'ISO-8859-9': 'iso-8859-9',      // Turkish
        'ISO-8859-15': 'iso-8859-15',
        'windows-1250': 'windows-1250',  // Central European
        'windows-1251': 'windows-1251',  // Cyrillic
        'windows-1252': 'windows-1252',  // Western European
        'windows-1253': 'windows-1253',  // Greek
        'windows-1254': 'windows-1254',  // Turkish
        'windows-1255': 'windows-1255',  // Hebrew
        'windows-1256': 'windows-1256',  // Arabic
        'windows-1257': 'windows-1257',  // Baltic
        'windows-1258': 'windows-1258',  // Vietnamese
        'windows-874': 'windows-874',    // Thai
        'TIS-620': 'tis-620',            // Thai (ISO)
        'GB2312': 'gb2312',
        'GBK': 'gbk',
        'GB18030': 'gb18030',
        'Big5': 'big5',
        'EUC-KR': 'euc-kr',
        'Shift_JIS': 'shift_jis',
        'EUC-JP': 'euc-jp',
        'KOI8-R': 'koi8-r',              // Russian (alternative)
        'KOI8-U': 'koi8-u'               // Ukrainian (alternative)
      };

      const encoding = encodingMap[detected] || detected.toLowerCase();

      // If we have a language hint, check if chardet's detection makes sense for that language.
      // Chardet often misidentifies Arabic/Hebrew as ISO-8859-1 or Windows-1252 because the
      // byte ranges overlap. When we know the language, we can override bad detections.
      const hintEncodings = resolveLanguageEncodings(languageHint);
      if (hintEncodings && encoding !== 'utf-8') {
        // chardet detected a non-UTF-8 encoding — check if it's plausible for the language
        const isDetectedPlausible = hintEncodings.includes(encoding);

        if (!isDetectedPlausible) {
          // chardet picked an encoding that doesn't match the language hint
          // Try the language-hinted encodings first, then validate
          log.debug(() => `[${source}] chardet detected ${encoding} but language hint is ${languageHint}, trying hinted encodings first`);

          for (const hintEncoding of hintEncodings) {
            if (!iconv.encodingExists(hintEncoding)) continue;
            try {
              const hintDecoded = iconv.decode(buffer, hintEncoding);
              const replacementCount = (hintDecoded.match(/\uFFFD/g) || []).length;
              const replacementRatio = hintDecoded.length > 0 ? replacementCount / hintDecoded.length : 1.0;

              if (replacementRatio < 0.05 && validateDecodedForLanguage(hintDecoded, languageHint)) {
                log.debug(() => `[${source}] Language-hinted encoding ${hintEncoding} produced valid ${languageHint} content (overriding chardet's ${detected})`);
                return hintDecoded;
              }
            } catch (_) {
              continue;
            }
          }
          // None of the hinted encodings worked well — fall through to chardet's detection
          log.debug(() => `[${source}] Language-hinted encodings didn't produce valid content, using chardet's ${detected}`);
        }
      }

      // Check if iconv-lite supports this encoding
      if (iconv.encodingExists(encoding)) {
        const decoded = iconv.decode(buffer, encoding);

        // Validate the decoded content doesn't have too many replacement characters
        const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
        const replacementRatio = replacementCount / decoded.length;

        if (replacementRatio > 0.1) {
          log.warn(() => `[${source}] High replacement character ratio (${(replacementRatio * 100).toFixed(1)}%) after decoding as ${encoding}, trying fallback`);
          return tryFallbackEncodings(buffer, source, languageHint);
        }

        // If we have a language hint, validate the decoded content contains expected script
        if (hintEncodings && !validateDecodedForLanguage(decoded, languageHint)) {
          log.warn(() => `[${source}] Decoded as ${encoding} but content doesn't contain expected ${languageHint} script characters, trying language-hinted fallback`);
          return tryFallbackEncodings(buffer, source, languageHint);
        }

        return decoded;
      } else {
        log.warn(() => `[${source}] Detected encoding ${detected} not supported by iconv-lite, trying fallbacks`);
        return tryFallbackEncodings(buffer, source, languageHint);
      }
    } else {
      log.warn(() => `[${source}] Could not detect encoding, trying fallback encodings`);
      return tryFallbackEncodings(buffer, source, languageHint);
    }
  } catch (error) {
    log.error(() => `[${source}] Error detecting/converting encoding: ${error.message}`);
    // Last resort: try UTF-8
    try {
      return Buffer.from(content).toString('utf-8');
    } catch (e) {
      return String(content);
    }
  }
}

/**
 * Try common fallback encodings when detection fails or produces poor results
 * @param {Buffer} buffer - Content buffer
 * @param {string} source - Source name for logging
 * @param {string} [languageHint] - Optional language hint to prioritize relevant encodings
 * @returns {string} - Decoded string
 */
function tryFallbackEncodings(buffer, source, languageHint = null) {
  // If we have a language hint, try those encodings first (highest priority)
  const hintEncodings = resolveLanguageEncodings(languageHint);
  if (hintEncodings) {
    for (const hintEncoding of hintEncodings) {
      if (!iconv.encodingExists(hintEncoding)) continue;
      try {
        const decoded = iconv.decode(buffer, hintEncoding);
        const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
        const replacementRatio = decoded.length > 0 ? replacementCount / decoded.length : 1.0;

        if (replacementRatio < 0.05 && validateDecodedForLanguage(decoded, languageHint)) {
          log.debug(() => `[${source}] Language-hinted fallback ${hintEncoding} succeeded for ${languageHint} (replacement ratio: ${(replacementRatio * 100).toFixed(2)}%)`);
          return decoded;
        }
      } catch (_) {
        continue;
      }
    }
    log.debug(() => `[${source}] Language-hinted fallback encodings didn't produce valid content, trying general fallbacks`);
  }

  // Common encodings to try, in order of likelihood
  // UTF-8 first as most modern content uses it
  // Then regional Windows codepages grouped by script family
  const fallbackEncodings = [
    'utf-8',           // Most common modern encoding
    'windows-1252',    // Very common for Western European languages (Portuguese, Spanish, etc.)
    'iso-8859-1',      // Latin-1, common for older Western European content
    'iso-8859-15',     // Latin-9, includes Euro sign
    'windows-1250',    // Central European (Polish, Czech, Hungarian, etc.)
    'windows-1251',    // Cyrillic (Russian, Ukrainian, Bulgarian, etc.)
    'koi8-r',          // Russian (alternative Cyrillic)
    'windows-1256',    // Arabic
    'iso-8859-6',      // Arabic (ISO standard)
    'windows-1255',    // Hebrew
    'iso-8859-8',      // Hebrew (ISO standard)
    'windows-1253',    // Greek
    'iso-8859-7',      // Greek (ISO standard)
    'windows-1254',    // Turkish
    'iso-8859-9',      // Turkish (ISO standard)
    'windows-1258',    // Vietnamese
    'windows-874',     // Thai
    'windows-1257',    // Baltic (Lithuanian, Latvian, Estonian)
  ];

  let bestResult = null;
  let lowestReplacementRatio = 1.0;

  for (const encoding of fallbackEncodings) {
    try {
      const decoded = iconv.decode(buffer, encoding);

      // Count replacement characters to find the best encoding
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
      const replacementRatio = decoded.length > 0 ? replacementCount / decoded.length : 1.0;

      if (replacementRatio < lowestReplacementRatio) {
        lowestReplacementRatio = replacementRatio;
        bestResult = decoded;

        // If we found a nearly perfect match, use it
        if (replacementRatio < 0.01) {
          log.debug(() => `[${source}] Successfully decoded as ${encoding} (replacement ratio: ${(replacementRatio * 100).toFixed(2)}%)`);
          return decoded;
        }
      }
    } catch (e) {
      // Skip this encoding if it fails
      continue;
    }
  }

  if (bestResult) {
    log.debug(() => `[${source}] Best fallback encoding had ${(lowestReplacementRatio * 100).toFixed(2)}% replacement characters`);
    return bestResult;
  }

  // Ultimate fallback
  log.warn(() => `[${source}] All encoding attempts failed, using UTF-8 as last resort`);
  return buffer.toString('utf-8');
}

/**
 * Detect encoding from a buffer without converting
 * @param {Buffer} buffer - Content buffer
 * @returns {string|null} - Detected encoding name or null
 */
function detectEncoding(buffer) {
  try {
    if (!Buffer.isBuffer(buffer)) {
      return null;
    }

    // Check for BOMs first
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      return 'UTF-8';
    }
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
      return 'UTF-16LE';
    }
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
      return 'UTF-16BE';
    }

    // Use chardet
    const sampleSize = Math.min(buffer.length, 4096);
    const sample = buffer.slice(0, sampleSize);
    return chardet.detect(sample);
  } catch (error) {
    return null;
  }
}

module.exports = {
  detectAndConvertEncoding,
  detectEncoding,
  tryFallbackEncodings
};
