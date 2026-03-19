const axios = require('axios');
const { parseSRT, toSRT } = require('../../utils/subtitle');
const { findISO6391ByName, toISO6391 } = require('../../utils/languages');
const { httpAgent, httpsAgent } = require('../../utils/httpAgents');
const log = require('../../utils/logger');

// Maximum characters per Google Translate request.
// The free endpoint returns HTTP 400 when the URL-encoded payload exceeds ~15-20K chars.
// Even with POST, Google recommends ≤5K chars per request for reliability.
// We use ~6K as a generous-but-safe limit per the project owner's preference.
const MAX_CHARS_PER_REQUEST = 6000;

// Exponential backoff base delay (ms) and cap for retries
const BACKOFF_BASE_MS = 4000;
const BACKOFF_MAX_MS = 8000;
const GOOGLE_LANGUAGE_ALIASES = {
  pob: 'pt-BR',
  ptbr: 'pt-BR',
  ptpt: 'pt-PT',
  spn: 'es-419',
  es419: 'es-419',
  enus: 'en-US',
  engb: 'en-GB',
  zhs: 'zh-CN',
  zht: 'zh-TW',
  zhcn: 'zh-CN',
  zhtw: 'zh-TW',
  zhhans: 'zh-CN',
  zhhant: 'zh-TW'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatGoogleLanguageTag(base, subtag = '') {
  const normalizedBase = String(base || '').trim().toLowerCase();
  const normalizedSubtag = String(subtag || '').trim();
  if (!normalizedBase) return '';
  if (!normalizedSubtag) return normalizedBase;
  if (/^\d{3}$/.test(normalizedSubtag)) return `${normalizedBase}-${normalizedSubtag}`;
  if (/^[a-z]{2}$/i.test(normalizedSubtag)) return `${normalizedBase}-${normalizedSubtag.toUpperCase()}`;
  if (/^[a-z]{4}$/i.test(normalizedSubtag)) {
    return `${normalizedBase}-${normalizedSubtag.charAt(0).toUpperCase()}${normalizedSubtag.slice(1).toLowerCase()}`;
  }
  return `${normalizedBase}-${normalizedSubtag}`;
}

function normalizeGoogleLanguageCode(value) {
  if (!value) return null;

  let normalized = String(value || '').trim();
  if (!normalized) return null;

  normalized = normalized.replace(/_/g, '-');
  if (normalized.toLowerCase().endsWith('-tr')) {
    normalized = normalized.slice(0, -3);
  }

  let lower = normalized.toLowerCase();
  if (lower === 'iw') lower = 'he';

  const fromName = findISO6391ByName(normalized) || findISO6391ByName(lower);
  if (fromName) {
    lower = String(fromName).trim().toLowerCase().replace(/_/g, '-');
  }

  const compact = lower.replace(/-/g, '');
  if (GOOGLE_LANGUAGE_ALIASES[compact]) {
    return GOOGLE_LANGUAGE_ALIASES[compact];
  }

  const parts = lower.split('-').filter(Boolean);
  let base = parts[0] || '';
  const subtag = parts[1] || '';

  if (/^[a-z]{3}$/.test(base)) {
    const iso1 = toISO6391(base);
    if (iso1) {
      base = String(iso1).trim().toLowerCase();
    }
  }

  if (base === 'zh') {
    const subtags = parts.slice(1);
    if (subtags.some((tag) => tag === 'hant' || tag === 'tw' || tag === 'hk' || tag === 'mo')) {
      return 'zh-TW';
    }
    if (subtags.some((tag) => tag === 'hans' || tag === 'cn' || tag === 'sg')) {
      return 'zh-CN';
    }
  }

  if (parts.length >= 2) {
    return formatGoogleLanguageTag(base, subtag);
  }

  if (/^[a-z]{3}$/.test(lower)) {
    const iso1 = toISO6391(lower);
    if (iso1) {
      return formatGoogleLanguageTag(iso1);
    }
  }

  if (/^[a-z]{2}$/i.test(lower)) {
    return lower;
  }

  return lower;
}

/**
 * Calculate exponential backoff delay with jitter.
 * @param {number} attempt - Zero-based attempt number (0 = first retry)
 * @returns {number} - Delay in milliseconds
 */
function backoffDelay(attempt) {
  const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_MAX_MS);
  // Add ±25% jitter to prevent thundering herd
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

// Unofficial, keyless Google Translate provider using the public web endpoint.
// This mirrors the "google-translate-api-browser" behavior (join with a delimiter,
// single request, then split back into entries). Because it relies on the free
// web endpoint, it may be rate-limited or change without notice.
class GoogleTranslateProvider {
  constructor(options = {}) {
    this.providerName = options.providerName || 'googletranslate';
    this.translationTimeout = Math.max(5000, parseInt(options.translationTimeout * 1000, 10) || 60000);
    this.maxRetries = Number.isFinite(parseInt(options.maxRetries, 10))
      ? Math.max(0, parseInt(options.maxRetries, 10))
      : 2;
    this.baseUrl = process.env.GOOGLE_TRANSLATE_ENDPOINT
      || 'https://translate.googleapis.com/translate_a/single';
    this.delimiter = '|||'; // Separator to preserve entry boundaries
  }

  normalizeLanguage(targetLanguage) {
    return normalizeGoogleLanguageCode(targetLanguage);
  }

  stripContext(subtitleContent) {
    if (!subtitleContent) return '';
    const marker = '=== ENTRIES TO TRANSLATE';
    const idx = subtitleContent.indexOf(marker);
    if (idx >= 0) {
      return subtitleContent.slice(idx + marker.length).replace(/^\s*\n+/, '');
    }
    return subtitleContent;
  }

  extractEntries(subtitleContent) {
    const content = this.stripContext(String(subtitleContent || '')).replace(/\r\n/g, '\n').trim();
    if (!content) return { type: 'raw', entries: [] };

    // SRT-style payload
    if (content.includes('-->')) {
      const parsed = parseSRT(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          type: 'srt',
          entries: parsed.map((entry, idx) => ({
            index: idx,
            text: entry.text || '',
            timecode: entry.timecode || '',
            id: entry.id
          }))
        };
      }
    }

    // Numbered list format (1. text)
    const entries = [];
    const pattern = /(\d+)[.):-]+\s+([\s\S]*?)(?=\n+\d+[.):-]+\s+|$)/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const text = (match[2] || '').trim();
      if (!text) continue;
      entries.push({ index: entries.length, text });
    }

    if (entries.length > 0) {
      return { type: 'numbered', entries };
    }

    // Fallback: single block
    return { type: 'raw', entries: [{ index: 0, text: content }] };
  }

  /**
   * Sanitize text before sending to the Google Translate API.
   * Strips characters that can cause HTTP 400 errors even with proper
   * URL encoding — null bytes, BOM markers, and C0/C1 control characters
   * that sometimes appear in subtitle files from various encodings.
   * @param {string} text
   * @returns {string}
   */
  sanitizeText(text) {
    if (!text) return '';
    return String(text)
      // Strip BOM (UTF-8, UTF-16 LE/BE)
      .replace(/^\uFEFF/, '')
      .replace(/\uFFFE/g, '')
      // Strip null bytes
      .replace(/\0/g, '')
      // Strip C0 control characters (except \n \r \t which are meaningful)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // Strip C1 control characters (U+0080–U+009F)
      .replace(/[\u0080-\u009F]/g, '')
      // Normalize whitespace — collapse runs of spaces/tabs but preserve newlines
      .replace(/[ \t]+/g, ' ');
  }

  /**
   * Call the Google Translate API using POST to avoid URL length limits.
   * The free endpoint accepts application/x-www-form-urlencoded POST bodies,
   * which removes the ~15K char query-string ceiling that caused HTTP 400
   * errors on larger subtitle batches (Issue #93).
   * @param {string} text - Text to translate
   * @returns {Promise<string>} - Translated text
   */
  async callTranslate(text) {
    const sanitized = this.sanitizeText(text);
    const params = new URLSearchParams();
    params.append('client', 'gtx');
    params.append('sl', 'auto');
    params.append('tl', this.targetCode);
    params.append('dt', 't');
    params.append('q', sanitized);

    const response = await axios.post(this.baseUrl, params.toString(), {
      headers: {
        'User-Agent': 'SubMaker/1.0',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: this.translationTimeout,
      httpAgent,
      httpsAgent
    });

    if (!response.data || !Array.isArray(response.data)) {
      throw new Error('Unexpected Google Translate response');
    }

    // response.data[0] is an array of segments: [[translated, original, ...], ...]
    const segments = Array.isArray(response.data[0]) ? response.data[0] : [];
    const translated = segments.map(seg => (Array.isArray(seg) ? seg[0] : '')).join('');
    if (!translated) {
      throw new Error('Empty translation from Google Translate');
    }
    return translated;
  }

  splitResult(translatedJoined, expected) {
    let parts = translatedJoined.split(this.delimiter);
    if (parts.length !== expected && parts.length > 0) {
      // Try to heal small mismatches (e.g., delimiter spacing removal)
      const diff = expected - parts.length;
      if (diff > 0 && parts.length === 1) {
        // Split on spaces if all merged
        const words = parts[0].split(' ');
        if (words.length >= expected) {
          parts = words.slice(0, expected);
        }
      }
    }
    // Pad or trim to expected length
    if (parts.length < expected) {
      while (parts.length < expected) parts.push(parts[parts.length - 1] || '');
    } else if (parts.length > expected) {
      parts = parts.slice(0, expected);
    }
    return parts.map(p => String(p || '').trim());
  }

  rebuildOutput(type, originalEntries, translatedParts) {
    if (type === 'srt') {
      const rebuilt = originalEntries.map((entry, idx) => ({
        id: entry.id || idx + 1,
        timecode: entry.timecode || '00:00:00,000 --> 00:00:05,000',
        text: translatedParts[idx] || entry.text || ''
      }));
      return toSRT(rebuilt).trim();
    }

    // Numbered/Raw formats -> numbered list
    return translatedParts
      .map((text, idx) => `${idx + 1}. ${text || originalEntries[idx]?.text || ''}`)
      .join('\n\n');
  }

  /**
   * Split entry texts into chunks that respect MAX_CHARS_PER_REQUEST.
   * Each chunk is an array of { originalIndex, text } so we can reassemble in order.
   * Splitting is done on entry boundaries — entries are never split mid-text.
   * @param {string[]} texts - Array of entry texts
   * @returns {Array<Array<{originalIndex: number, text: string}>>} - Array of chunks
   */
  chunkTexts(texts) {
    const delimLen = ` ${this.delimiter} `.length;
    const chunks = [];
    let currentChunk = [];
    let currentLen = 0;

    for (let i = 0; i < texts.length; i++) {
      const textLen = texts[i].length;
      const addedLen = currentChunk.length > 0 ? delimLen + textLen : textLen;

      if (currentLen + addedLen > MAX_CHARS_PER_REQUEST && currentChunk.length > 0) {
        // Current chunk is full, start a new one
        chunks.push(currentChunk);
        currentChunk = [];
        currentLen = 0;
      }

      currentChunk.push({ originalIndex: i, text: texts[i] });
      currentLen += currentChunk.length === 1 ? textLen : delimLen + textLen;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Translate a single chunk of texts (joined with delimiter).
   * @param {Array<{originalIndex: number, text: string}>} chunk
   * @returns {Promise<string[]>} - Array of translated texts in chunk order
   */
  async translateChunk(chunk) {
    const texts = chunk.map(c => c.text);
    const joined = texts.join(` ${this.delimiter} `);

    const translatedJoined = await this.callTranslate(joined);
    const parts = this.splitResult(translatedJoined, texts.length);
    return parts.map(p => this.cleanTranslatedText(p));
  }

  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage) {
    const targetCode = this.normalizeLanguage(targetLanguage);
    if (!targetCode) {
      throw new Error('Target language is required for Google Translate');
    }
    this.targetCode = targetCode;

    const { type, entries } = this.extractEntries(subtitleContent);
    if (!entries || entries.length === 0) {
      throw new Error('No subtitle entries to translate');
    }

    const texts = entries.map(e => e.text);
    const joined = texts.join(` ${this.delimiter} `);

    // Decide whether we need to chunk: if the joined text fits in a single
    // request, send it as-is (fast path). Otherwise split into chunks.
    const needsChunking = joined.length > MAX_CHARS_PER_REQUEST;

    if (needsChunking) {
      return this._translateChunked(texts, type, entries);
    }

    // Fast path: single request for the joined text
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const translatedJoined = await this.callTranslate(joined);
        const parts = this.splitResult(translatedJoined, texts.length);
        const cleaned = parts.map(p => this.cleanTranslatedText(p));
        return this.rebuildOutput(type, entries, cleaned);
      } catch (error) {
        lastError = error;

        // If we get a payload-too-large error on what we thought was a small
        // payload, fall through to chunked mode instead of retrying
        if (this._isPayloadTooLargeError(error)) {
          log.warn(() => [`[${this.providerName}] Payload too large for single request, falling back to chunked mode`]);
          return this._translateChunked(texts, type, entries);
        }

        if (attempt < this.maxRetries) {
          const delay = backoffDelay(attempt);
          log.warn(() => [`[${this.providerName}] Retry ${attempt + 1}/${this.maxRetries} after error (backoff ${delay}ms):`, error.message]);
          await sleep(delay);
          continue;
        }
        error.translationErrorType = 'PROVIDER_ERROR';
        throw error;
      }
    }
    if (lastError) throw lastError;
    throw new Error('Google Translate failed');
  }

  /**
   * Translate entries in chunks when the total payload exceeds MAX_CHARS_PER_REQUEST.
   * Each chunk is translated in a separate API call; results are merged in order.
   * @param {string[]} texts - All entry texts
   * @param {string} type - Entry type ('srt', 'numbered', 'raw')
   * @param {Array} entries - Original entries for rebuild
   * @returns {Promise<string>} - Translated output
   */
  async _translateChunked(texts, type, entries) {
    const chunks = this.chunkTexts(texts);
    log.info(() => `[${this.providerName}] Translating ${texts.length} entries in ${chunks.length} chunks (payload was ${texts.join(` ${this.delimiter} `).length} chars, limit ${MAX_CHARS_PER_REQUEST})`);

    // Translate each chunk sequentially to avoid rate limiting
    const allTranslated = new Array(texts.length);

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      let lastError;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const translated = await this.translateChunk(chunk);
          // Place results at their original indices
          for (let j = 0; j < chunk.length; j++) {
            allTranslated[chunk[j].originalIndex] = translated[j];
          }
          break; // Success, move to next chunk
        } catch (error) {
          lastError = error;
          if (attempt < this.maxRetries) {
            const delay = backoffDelay(attempt);
            log.warn(() => [`[${this.providerName}] Chunk ${ci + 1}/${chunks.length} retry ${attempt + 1}/${this.maxRetries} (backoff ${delay}ms):`, error.message]);
            await sleep(delay);
            continue;
          }
          error.translationErrorType = 'PROVIDER_ERROR';
          throw error;
        }
      }
    }

    // Fill any gaps (shouldn't happen but be safe)
    for (let i = 0; i < allTranslated.length; i++) {
      if (allTranslated[i] === undefined) {
        allTranslated[i] = entries[i]?.text || '';
      }
    }

    return this.rebuildOutput(type, entries, allTranslated);
  }

  /**
   * Check if an error indicates the request payload was too large.
   * Google returns 400 (Bad Request) or 413 (Payload Too Large) when the
   * query string or body exceeds server-side limits.
   * @param {Error} error
   * @returns {boolean}
   */
  _isPayloadTooLargeError(error) {
    if (!error) return false;
    const status = error.response?.status || 0;
    return status === 400 || status === 413 || status === 414;
  }

  async streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, onPartial = null) {
    // Streaming is not supported; fall back to full translation
    const full = await this.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt);
    if (typeof onPartial === 'function') {
      try { await onPartial(full); } catch (_) {}
    }
    return full;
  }

  async countTokensForTranslation() {
    return null; // Not supported
  }

  estimateTokenCount(text) {
    if (!text) return 0;
    // Google Translate doesn't use tokens — this is just a size proxy for the engine.
    return Math.max(1, Math.ceil(String(text).length / 4));
  }

  buildUserPrompt(subtitleContent, targetLanguage) {
    // Provided for API compatibility; Google Translate ignores prompts
    return {
      userPrompt: subtitleContent,
      systemPrompt: '',
      normalizedTarget: this.normalizeLanguage(targetLanguage) || ''
    };
  }

  cleanTranslatedText(text) {
    let cleaned = String(text || '').trim();
    cleaned = cleaned.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return cleaned.trim();
  }
}

module.exports = GoogleTranslateProvider;
