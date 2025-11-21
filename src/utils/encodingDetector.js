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
 * Detect and convert subtitle content to UTF-8
 * @param {Buffer|string} content - Subtitle content (Buffer or string)
 * @param {string} source - Source name for logging (e.g., 'SubSource', 'SubDL')
 * @returns {string} - UTF-8 encoded string
 */
function detectAndConvertEncoding(content, source = 'Unknown') {
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
      log.debug(() => `[${source}] Detected encoding: ${detected}`);

      // Map detected encoding to iconv-lite compatible name
      const encodingMap = {
        'UTF-8': 'utf-8',
        'UTF-16LE': 'utf-16le',
        'UTF-16BE': 'utf-16be',
        'ISO-8859-1': 'iso-8859-1',
        'ISO-8859-2': 'iso-8859-2',
        'ISO-8859-15': 'iso-8859-15',
        'windows-1252': 'windows-1252',
        'windows-1250': 'windows-1250',
        'windows-1251': 'windows-1251',
        'windows-1256': 'windows-1256',
        'GB2312': 'gb2312',
        'Big5': 'big5',
        'EUC-KR': 'euc-kr',
        'Shift_JIS': 'shift_jis',
        'EUC-JP': 'euc-jp'
      };

      const encoding = encodingMap[detected] || detected.toLowerCase();

      // Check if iconv-lite supports this encoding
      if (iconv.encodingExists(encoding)) {
        const decoded = iconv.decode(buffer, encoding);

        // Validate the decoded content doesn't have too many replacement characters
        const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
        const replacementRatio = replacementCount / decoded.length;

        if (replacementRatio > 0.1) {
          log.warn(() => `[${source}] High replacement character ratio (${(replacementRatio * 100).toFixed(1)}%) after decoding as ${encoding}, trying fallback`);
          return tryFallbackEncodings(buffer, source);
        }

        return decoded;
      } else {
        log.warn(() => `[${source}] Detected encoding ${detected} not supported by iconv-lite, trying fallbacks`);
        return tryFallbackEncodings(buffer, source);
      }
    } else {
      log.warn(() => `[${source}] Could not detect encoding, trying fallback encodings`);
      return tryFallbackEncodings(buffer, source);
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
 * @returns {string} - Decoded string
 */
function tryFallbackEncodings(buffer, source) {
  // Common encodings to try, in order of likelihood
  const fallbackEncodings = [
    'utf-8',           // Most common modern encoding
    'windows-1252',    // Very common for Western European languages (Portuguese, Spanish, etc.)
    'iso-8859-1',      // Latin-1, common for older Western European content
    'iso-8859-15',     // Latin-9, includes Euro sign
    'windows-1250',    // Central European
    'windows-1251',    // Cyrillic
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
