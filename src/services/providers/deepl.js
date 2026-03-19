const axios = require('axios');
const { DEFAULT_TRANSLATION_PROMPT } = require('../gemini');
const { normalizeTargetLanguageForPrompt } = require('../utils/normalizeTargetLanguageForPrompt');
const { handleTranslationError, logApiError } = require('../../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../../utils/httpAgents');
const { findISO6391ByName, toISO6391 } = require('../../utils/languages');
const log = require('../../utils/logger');
const { sanitizeApiKeyForHeader } = require('../../utils/security');

const SUPPORTED_SOURCE_LANGS = new Set([
  'AR', 'BG', 'CS', 'DA', 'DE', 'EL', 'EN', 'ES', 'ET', 'FI', 'FR', 'HE', 'HU',
  'ID', 'IT', 'JA', 'KO', 'LT', 'LV', 'NB', 'NL', 'PL', 'PT', 'PT-BR', 'PT-PT',
  'RO', 'RU', 'SK', 'SL', 'SV', 'TH', 'TR', 'UK', 'VI', 'ZH'
]);

const SUPPORTED_TARGET_LANGS = new Set([
  'AR', 'BG', 'CS', 'DA', 'DE', 'EL', 'EN', 'EN-GB', 'EN-US', 'ES', 'ES-419', 'ET',
  'FI', 'FR', 'HE', 'HU', 'ID', 'IT', 'JA', 'KO', 'LT', 'LV', 'NB', 'NL', 'PL',
  'PT', 'PT-BR', 'PT-PT', 'RO', 'RU', 'SK', 'SL', 'SV', 'TH', 'TR', 'UK', 'VI',
  'ZH', 'ZH-HANS', 'ZH-HANT'
]);

const BETA_LANGUAGES = new Set([
  'AB', 'ACE', 'AF', 'AK', 'AN', 'AS', 'AY', 'AZ', 'BA', 'BE', 'BHO', 'BM', 'BN', 'BR', 'BS',
  'CA', 'CEB', 'CKB', 'CV', 'CY', 'DV', 'DZ', 'EE', 'EO', 'EU', 'FA', 'FF', 'FIL', 'FJ', 'FO',
  'GA', 'GL', 'GN', 'GOM', 'GU', 'HA', 'HI', 'HR', 'HT', 'HY', 'IG', 'IS', 'JV', 'KA', 'KK',
  'KMR', 'KY', 'LA', 'LB', 'LG', 'LI', 'LMO', 'LN', 'MAI', 'MG', 'MI', 'MK', 'ML', 'MN', 'MR',
  'MS', 'MT', 'MY', 'NE', 'NR', 'NSO', 'OC', 'OM', 'OS', 'PA', 'PAG', 'PAM', 'PRS', 'PS', 'QU',
  'RN', 'RW', 'SA', 'SCN', 'SG', 'SI', 'SM', 'SN', 'SQ', 'SR', 'SS', 'ST', 'SU', 'SW', 'TA',
  'TE', 'TG', 'TI', 'TK', 'TL', 'TN', 'TS', 'TT', 'UR', 'UZ', 'VE', 'WO', 'XH', 'YI', 'YO',
  'YUE', 'ZU'
]);

const LANGUAGE_VARIANTS = {
  enus: 'EN-US',
  engb: 'EN-GB',
  ptbr: 'PT-BR',
  ptpt: 'PT-PT',
  es419: 'ES-419',
  zhhant: 'ZH-HANT',
  zhhans: 'ZH-HANS',
  zht: 'ZH-HANT',
  zhs: 'ZH-HANS',
  zhtw: 'ZH-HANT',
  zhcn: 'ZH-HANS'
};

function toDeepLApiCode(normalizedCode, { forTarget = false } = {}) {
  if (!normalizedCode) return null;
  // DeepL source languages accept generic PT; keep variant for config/validation but send PT to the API
  if (!forTarget && (normalizedCode === 'PT-BR' || normalizedCode === 'PT-PT')) return 'PT';
  return normalizedCode;
}

function normalizeCompoundLanguageCode(code) {
  if (!code || !code.includes('-')) return code;

  const parts = code.split('-').filter(Boolean);
  if (parts.length > 1 && /^[a-z]{3}$/.test(parts[0])) {
    const iso1 = toISO6391(parts[0]);
    if (iso1) {
      parts[0] = String(iso1).toLowerCase();
    }
  }

  const subtags = parts.slice(1);
  if (parts[0] === 'zh') {
    if (subtags.some((tag) => tag === 'hant' || tag === 'tw' || tag === 'hk' || tag === 'mo')) {
      return 'zh-hant';
    }
    if (subtags.some((tag) => tag === 'hans' || tag === 'cn' || tag === 'sg')) {
      return 'zh-hans';
    }
  }

  return parts.join('-');
}

function buildCandidateSequence(normalized) {
  const candidates = [];
  const pushCandidate = (value) => {
    const lowered = String(value || '').trim().toLowerCase();
    if (lowered && !candidates.includes(lowered)) {
      candidates.push(lowered);
    }
  };

  pushCandidate(normalized);

  if (!normalized || !normalized.includes('-')) {
    return candidates;
  }

  const parts = normalized.split('-').filter(Boolean);
  const base = parts[0];
  const subtags = parts.slice(1);

  if (base === 'zh') {
    if (subtags.some((tag) => tag === 'hant' || tag === 'tw' || tag === 'hk' || tag === 'mo')) {
      pushCandidate('zh-hant');
    } else if (subtags.some((tag) => tag === 'hans' || tag === 'cn' || tag === 'sg')) {
      pushCandidate('zh-hans');
    }
  }

  if (base === 'en') {
    if (subtags.includes('gb') || subtags.includes('uk')) {
      pushCandidate('en-gb');
    }
    if (subtags.includes('us')) {
      pushCandidate('en-us');
    }
  }

  if (base === 'pt') {
    if (subtags.includes('br')) {
      pushCandidate('pt-br');
    }
    if (subtags.includes('pt')) {
      pushCandidate('pt-pt');
    }
  }

  if (base === 'es' && subtags.includes('419')) {
    pushCandidate('es-419');
  }

  const baseCandidate = /^[a-z]{3}$/.test(base) ? (toISO6391(base) || base) : base;
  pushCandidate(baseCandidate);

  return candidates;
}

function toDeepLCodeCandidate(candidate, { forTarget = false } = {}) {
  if (!candidate) return null;

  let normalized = String(candidate).trim().toLowerCase();
  const compact = normalized.replace(/-/g, '');
  if (LANGUAGE_VARIANTS[compact]) {
    normalized = LANGUAGE_VARIANTS[compact];
  }

  switch (normalized) {
    case 'en':
      normalized = forTarget ? 'EN-US' : 'EN';
      break;
    case 'pt':
      normalized = forTarget ? 'PT-PT' : 'PT';
      break;
    case 'zh':
      normalized = forTarget ? 'ZH-HANS' : 'ZH';
      break;
    case 'no':
      normalized = 'NB';
      break;
    default:
      normalized = normalized.toUpperCase();
  }

  if (!forTarget) {
    if (normalized === 'EN-US' || normalized === 'EN-GB') normalized = 'EN';
    if (normalized === 'ES-419') normalized = 'ES';
    if (normalized === 'ZH-HANS' || normalized === 'ZH-HANT') normalized = 'ZH';
  }

  return normalized;
}

function validateDeepLCodeCandidate(normalizedCode, { forTarget = false } = {}) {
  if (!normalizedCode) return null;

  const betaKey = normalizedCode.replace(/-/g, '').toUpperCase();
  const isBeta = BETA_LANGUAGES.has(betaKey);
  const allowedSet = forTarget ? SUPPORTED_TARGET_LANGS : SUPPORTED_SOURCE_LANGS;

  if (!allowedSet.has(normalizedCode) && !isBeta) {
    return null;
  }

  return { code: normalizedCode, isBeta };
}

function normalizeLanguage(code, { forTarget = false } = {}) {
  if (!code) return { code: null, isBeta: false };

  const raw = String(code || '').trim();
  const lower = raw.toLowerCase();
  if (!lower || lower === 'detected' || lower === 'auto') {
    return { code: null, isBeta: false };
  }

  let normalized = lower;

  // Try to resolve human-friendly names (e.g., "English", "Portuguese (Brazilian)")
  const fromName = findISO6391ByName(raw) || findISO6391ByName(lower);
  if (fromName) {
    normalized = fromName.toLowerCase();
  }

  normalized = normalized.replace(/_/g, '-');
  if (normalized.endsWith('-tr')) {
    normalized = normalized.replace(/-tr$/, '');
  }
  if (normalized === 'iw') normalized = 'he';
  if (normalized === 'pob' || normalized === 'ptbr') normalized = 'pt-br';
  if (normalized === 'spn') normalized = 'es-419';

  normalized = normalizeCompoundLanguageCode(normalized);

  // Convert ISO-639-2 to ISO-639-1 when possible
  if (/^[a-z]{3}$/.test(normalized)) {
    const iso1 = toISO6391(normalized);
    if (iso1) normalized = iso1;
  }

  for (const candidate of buildCandidateSequence(normalized)) {
    const resolved = toDeepLCodeCandidate(candidate, { forTarget });
    const validated = validateDeepLCodeCandidate(resolved, { forTarget });
    if (validated) {
      return validated;
    }
  }

  throw new Error(`Language '${code}' is not supported by DeepL for ${forTarget ? 'target' : 'source'} translations`);
}

class DeepLProvider {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || '').trim();
    this.providerName = options.providerName || 'deepl';
    this.modelType = options.model || options.modelType || 'quality_optimized';
    this.formality = options.formality || 'default';
    this.preserveFormatting = options.preserveFormatting !== false;
    const timeoutSeconds = options.translationTimeout !== undefined ? options.translationTimeout : 60;
    this.translationTimeout = Math.max(5000, parseInt(timeoutSeconds * 1000, 10) || 60000);
    this.maxRetries = Number.isFinite(parseInt(options.maxRetries, 10))
      ? Math.max(0, parseInt(options.maxRetries, 10))
      : 2;

    const envBase = process.env.DEEPL_API_BASE;
    if (envBase) {
      this.baseUrl = envBase.replace(/\/+$/, '');
    } else if (this.apiKey.toLowerCase().includes(':fx')) {
      this.baseUrl = 'https://api-free.deepl.com';
    } else {
      this.baseUrl = 'https://api.deepl.com';
    }
  }

  normalizeLanguage(code, { forTarget = false } = {}) {
    return normalizeLanguage(code, { forTarget }).code;
  }

  normalizeLanguageDetails(code, { forTarget = false } = {}) {
    return normalizeLanguage(code, { forTarget });
  }

  buildUserPrompt(subtitleContent, targetLanguage, customPrompt = null) {
    const normalizedTarget = normalizeTargetLanguageForPrompt(targetLanguage);
    const systemPrompt = (customPrompt || DEFAULT_TRANSLATION_PROMPT).replace('{target_language}', normalizedTarget);
    const userPrompt = `${systemPrompt}\n\nContent to translate:\n\n${subtitleContent}`;
    return { userPrompt, systemPrompt, normalizedTarget };
  }

  estimateTokenCount(text) {
    if (!text) return 0;
    // DeepL doesn't use tokens — this is just a size proxy for the engine's batch sizing.
    const approx = Math.ceil(String(text).length / 3);
    return Math.ceil(approx * 1.1);
  }

  cleanTranslatedSubtitle(text) {
    let cleaned = String(text || '');
    cleaned = cleaned.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return cleaned.trim();
  }

  extractEntries(subtitleContent) {
    if (!subtitleContent) return [];
    const stripContext = (text) => {
      const marker = '=== ENTRIES TO TRANSLATE';
      const idx = text.indexOf(marker);
      if (idx >= 0) {
        return text.slice(idx + marker.length).replace(/^\s*\n+/, '');
      }
      return text;
    };

    const normalized = stripContext(String(subtitleContent)).replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];

    // Handle SRT-style batches with timestamps
    if (normalized.includes('-->')) {
      const results = [];
      const regex = /(?:^|\n)\d+\s*\n[^\n]*-->\s*[^\n]*\n([\s\S]*?)(?=\n{2,}\d+\s*\n|$)/g;
      let match;
      while ((match = regex.exec(normalized)) !== null) {
        const text = match[1]?.trim();
        if (text) {
          results.push({ index: results.length, text });
        }
      }
      if (results.length > 0) return results;
    }

    // Default: numbered list format
    const entries = [];
    const pattern = /(\d+)[.):-]+\s+([\s\S]*?)(?=\n+\d+[.):-]+\s+|$)/g;
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const text = match[2]?.trim();
      if (text) {
        entries.push({ index: entries.length, text });
      }
    }
    return entries;
  }

  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage) {
    if (!this.apiKey) {
      throw new Error('DeepL API key is required');
    }

    const entries = this.extractEntries(subtitleContent);
    const texts = entries.length > 0 ? entries.map(e => e.text) : [subtitleContent];

    const { code: targetCode, isBeta: targetIsBeta } = normalizeLanguage(targetLanguage, { forTarget: true });
    if (!targetCode) {
      throw new Error('Target language is required for DeepL translation');
    }
    const { code: sourceCode, isBeta: sourceIsBeta } = normalizeLanguage(sourceLanguage, { forTarget: false });
    const enableBeta = targetIsBeta || sourceIsBeta;

    const payload = {
      text: texts,
      target_lang: targetCode,
      preserve_formatting: this.preserveFormatting === true,
      split_sentences: 'nonewlines'
    };

    if (sourceCode) payload.source_lang = toDeepLApiCode(sourceCode, { forTarget: false });

    const effectiveModelType = this.modelType || 'quality_optimized';
    if (!(enableBeta && effectiveModelType === 'latency_optimized')) {
      payload.model_type = effectiveModelType;
    } else {
      log.warn(() => '[DeepL] Beta languages require quality_optimized model; overriding latency_optimized');
      payload.model_type = 'quality_optimized';
    }

    if (this.formality && this.formality !== 'default') {
      payload.formality = this.formality;
    }

    if (enableBeta) {
      payload.enable_beta_languages = true;
    }

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.post(
          `${this.baseUrl}/v2/translate`,
          payload,
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `DeepL-Auth-Key ${sanitizeApiKeyForHeader(this.apiKey) || ''}`
            },
            timeout: this.translationTimeout,
            httpAgent,
            httpsAgent
          }
        );

        const translations = Array.isArray(response.data?.translations) ? response.data.translations : [];
        if (!translations.length) {
          throw new Error('No translation returned from DeepL');
        }

        const cleaned = translations.map(t => this.cleanTranslatedSubtitle(t.text || ''));
        const numbered = cleaned.map((text, idx) => `${idx + 1}. ${text}`);
        return numbered.join('\n\n');
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          log.warn(() => [`[${this.providerName}] Retry ${attempt + 1}/${this.maxRetries} after error:`, error.message]);
          continue;
        }
        logApiError(error, this.providerName, 'Translate', { logResponseData: true, truncateResponseData: 300 });
        handleTranslationError(error, this.providerName, { skipResponseData: true });
      }
    }

    if (lastError) throw lastError;
    throw new Error('DeepL translation failed');
  }

  async streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, onPartial = null) {
    const full = await this.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt);
    if (typeof onPartial === 'function') {
      try {
        await onPartial(full);
      } catch (_) { }
    }
    return full;
  }

  async countTokensForTranslation() {
    return null; // Not supported by DeepL
  }

  async getAvailableModels() {
    return [
      {
        name: 'quality_optimized',
        displayName: 'Quality optimized (default)',
        description: 'Best translation quality (default DeepL model)'
      },
      {
        name: 'latency_optimized',
        displayName: 'Latency optimized',
        description: 'Faster responses with slightly lower quality'
      }
    ];
  }
}

DeepLProvider.normalizeLanguage = function normalizeLanguageStatic(code, options = {}) {
  return normalizeLanguage(code, options).code;
};

DeepLProvider.normalizeLanguageDetails = normalizeLanguage;
DeepLProvider.toDeepLApiCode = toDeepLApiCode;

module.exports = DeepLProvider;
