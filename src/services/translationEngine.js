/**
 * Translation Engine - Unified Subtitle Translation
 *
 * Clean, simple, predictable translation workflow:
 * 1. Parse SRT into entries
 * 2. Translate in batches (real-time progress after each batch)
 * 3. Auto-chunk large batches transparently when needed
 * 4. Stream results entry-by-entry as they complete
 * 5. No time-based checkpoints - everything is event-driven
 *
 * Benefits:
 * - Single code path for all files (small/large)
 * - Perfect timing preservation
 * - Real-time progressive delivery
 * - Simple, predictable behavior
 * - Automatic optimization
 */

const { parseSRT, toSRT } = require('../utils/subtitle');
const GeminiService = require('./gemini');
const crypto = require('crypto');
const log = require('../utils/logger');

// Entry-level cache for translated subtitle entries
const entryCache = new Map();
const MAX_ENTRY_CACHE_SIZE = parseInt(process.env.ENTRY_CACHE_SIZE) || 100000;

// Configuration constants
const BATCH_SIZE = parseInt(process.env.TRANSLATION_BATCH_SIZE) || 150; // Entries per batch
const MAX_TOKENS_PER_BATCH = parseInt(process.env.MAX_TOKENS_PER_BATCH) || 25000; // Max tokens before auto-chunking
// Entry cache disabled by default - causes stale data on cache resets and not HA-aware
// Only useful for repeated translations with identical config (rare)
const CACHE_TRANSLATIONS = process.env.CACHE_TRANSLATIONS === 'true'; // Enable/disable entry caching

class TranslationEngine {
  constructor(geminiService) {
    this.gemini = geminiService;
    this.batchSize = BATCH_SIZE;
    this.maxTokensPerBatch = MAX_TOKENS_PER_BATCH;
  }

  /**
   * Main translation method - unified approach for all files
   * @param {string} srtContent - Original SRT content
   * @param {string} targetLanguage - Target language name
   * @param {string} customPrompt - Optional custom prompt
   * @param {Function} onProgress - Callback for real-time progress (entry-by-entry)
   * @returns {Promise<string>} - Translated SRT content
   */
  async translateSubtitle(srtContent, targetLanguage, customPrompt = null, onProgress = null) {
    // Step 1: Parse SRT into structured entries
    const entries = parseSRT(srtContent);
    if (!entries || entries.length === 0) {
      throw new Error('Invalid SRT content: no valid entries found');
    }

    log.info(() => `[TranslationEngine] Starting translation: ${entries.length} entries, ${Math.ceil(entries.length / this.batchSize)} batches`);

    // Step 2: Create batches
    const batches = this.createBatches(entries, this.batchSize);

    // Step 3: Translate each batch with smart progress tracking
    const translatedEntries = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      try {
        // Translate batch (with auto-chunking if needed)
        const translatedBatch = await this.translateBatch(
          batch,
          targetLanguage,
          customPrompt,
          batchIndex,
          batches.length
        );

        // Merge translated text with original structure
        for (let i = 0; i < batch.length; i++) {
          const original = batch[i];
          const translated = translatedBatch[i];

          // Clean translated text
          const cleanedText = this.cleanTranslatedText(translated.text);

          // Create entry with original timing and cleaned translated text
          translatedEntries.push({
            id: original.id,
            timecode: original.timecode, // PRESERVE ORIGINAL TIMING
            text: cleanedText
          });
        }

        // Progress callback after each batch
        if (typeof onProgress === 'function') {
          try {
            await onProgress({
              totalEntries: entries.length,
              completedEntries: translatedEntries.length,
              currentBatch: batchIndex + 1,
              totalBatches: batches.length,
              partialSRT: toSRT(translatedEntries)
            });
          } catch (err) {
            log.warn(() => ['[TranslationEngine] Progress callback error:', err.message]);
          }
        }

        // Log progress only at milestones
        const progress = Math.floor((translatedEntries.length / entries.length) * 100);
        if (batchIndex === 0 || batchIndex === batches.length - 1 || progress % 25 === 0) {
          log.info(() => `[TranslationEngine] Progress: ${progress}% (${translatedEntries.length}/${entries.length} entries, batch ${batchIndex + 1}/${batches.length})`);
        }

      } catch (error) {
        log.error(() => [`[TranslationEngine] Error in batch ${batchIndex + 1}:`, error.message]);
        // Wrap error but preserve original error properties (translationErrorType, statusCode, etc.)
        const wrappedError = new Error(`Translation failed at batch ${batchIndex + 1}: ${error.message}`);
        // Copy all properties from original error to preserved type information
        if (error.translationErrorType) wrappedError.translationErrorType = error.translationErrorType;
        if (error.statusCode) wrappedError.statusCode = error.statusCode;
        if (error.type) wrappedError.type = error.type;
        if (error.isRetryable !== undefined) wrappedError.isRetryable = error.isRetryable;
        if (error.originalError) wrappedError.originalError = error.originalError;
        throw wrappedError;
      }
    }

    // Step 4: Final validation
    if (translatedEntries.length !== entries.length) {
      log.warn(() => `[TranslationEngine] Entry count mismatch: expected ${entries.length}, got ${translatedEntries.length}`);
    }

    log.info(() => `[TranslationEngine] Translation completed: ${translatedEntries.length} entries`);

    // Step 5: Convert back to SRT format
    return toSRT(translatedEntries);
  }

  /**
   * Create batches from entries
   */
  createBatches(entries, batchSize) {
    const batches = [];
    for (let i = 0; i < entries.length; i += batchSize) {
      batches.push(entries.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Translate a batch of entries (with auto-chunking if needed)
   */
  async translateBatch(batch, targetLanguage, customPrompt, batchIndex, totalBatches) {
    // Check cache first
    const cacheResults = this.checkBatchCache(batch, targetLanguage, customPrompt);
    if (cacheResults.allCached) {
      return cacheResults.entries;
    }

    // Prepare batch text
    const batchText = this.prepareBatchText(batch);
    const prompt = this.createBatchPrompt(batchText, targetLanguage, customPrompt, batch.length);

    // Check if we need to split due to token limits
    const estimatedTokens = this.gemini.estimateTokenCount(batchText + prompt);

    if (estimatedTokens > this.maxTokensPerBatch && batch.length > 1) {
      // Auto-chunk: Split batch in half recursively (sequential for memory safety)
      log.debug(() => `[TranslationEngine] Batch too large (${estimatedTokens} tokens), auto-chunking into 2 parts`);

      const midpoint = Math.floor(batch.length / 2);
      const firstHalf = batch.slice(0, midpoint);
      const secondHalf = batch.slice(midpoint);

      // Translate sequentially to avoid memory spikes
      const firstTranslated = await this.translateBatch(firstHalf, targetLanguage, customPrompt, batchIndex, totalBatches);
      const secondTranslated = await this.translateBatch(secondHalf, targetLanguage, customPrompt, batchIndex, totalBatches);

      return [...firstTranslated, ...secondTranslated];
    }

    // Translate batch - with retry on PROHIBITED_CONTENT error
    let translatedText;
    let prohibitedRetryAttempted = false;

    try {
      translatedText = await this.gemini.translateSubtitle(
        batchText,
        'detected',
        targetLanguage,
        prompt
      );
    } catch (error) {
      // If PROHIBITED_CONTENT error and haven't retried yet, retry with modified prompt
      if (error.message && error.message.includes('PROHIBITED_CONTENT') && !prohibitedRetryAttempted) {
        prohibitedRetryAttempted = true;
        log.warn(() => `[TranslationEngine] PROHIBITED_CONTENT detected, retrying batch with modified prompt`);

        // Create modified prompt with disclaimer
        const modifiedPrompt = `YOU'RE TRANSLATING SUBTITLES - EVERYTHING WRITTEN BELOW IS FICTICIOUS\n\n${prompt}`;

        try {
          translatedText = await this.gemini.translateSubtitle(
            batchText,
            'detected',
            targetLanguage,
            modifiedPrompt
          );
          log.info(() => `[TranslationEngine] Retry with modified prompt succeeded for batch ${batchIndex + 1}`);
        } catch (retryError) {
          // Retry also failed, give up and throw the original error
          log.error(() => `[TranslationEngine] Retry with modified prompt also failed: ${retryError.message}`);
          throw error; // Throw original error, not retry error
        }
      } else {
        // Not a PROHIBITED_CONTENT error or already retried, throw as-is
        throw error;
      }
    }

    // Parse translated text back into entries
    const translatedEntries = this.parseBatchResponse(translatedText, batch.length);

    // Handle entry count mismatches gracefully
    if (translatedEntries.length !== batch.length) {
      log.warn(() => `[TranslationEngine] Entry count mismatch: expected ${batch.length}, got ${translatedEntries.length}`);
      this.fixEntryCountMismatch(translatedEntries, batch);
    }

    // Cache individual entries
    if (CACHE_TRANSLATIONS) {
      for (let i = 0; i < batch.length && i < translatedEntries.length; i++) {
        this.cacheEntry(batch[i].text, targetLanguage, translatedEntries[i].text, customPrompt);
      }
    }

    return translatedEntries;
  }

  /**
   * Prepare batch text for translation (numbered list format)
   */
  prepareBatchText(batch) {
    return batch.map((entry, index) => {
      const num = index + 1;
      const cleanText = entry.text.trim().replace(/\n+/g, '\n');
      return `${num}. ${cleanText}`;
    }).join('\n\n');
  }

  /**
   * Create translation prompt for a batch
   */
  createBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount) {
    if (customPrompt) {
      return customPrompt.replace('{target_language}', targetLanguage);
    }

    return `You are translating subtitle text to ${targetLanguage}.

CRITICAL RULES:
1. Translate ONLY the text content
2. PRESERVE the numbering exactly (1. 2. 3. etc.)
3. Return EXACTLY ${expectedCount} numbered entries
4. Keep line breaks within each entry
5. Maintain natural dialogue flow for ${targetLanguage}
6. Use appropriate colloquialisms for ${targetLanguage}

DO NOT:
- Add ANY explanations, notes, or commentary
- Add alternative translations
- Skip any entries
- Merge or split entries
- Change the numbering
- Add extra entries

YOUR RESPONSE MUST:
- Start immediately with "1." (the first entry)
- End with "${expectedCount}." (the last entry)
- Contain NOTHING else

INPUT (${expectedCount} entries):

${batchText}

OUTPUT (EXACTLY ${expectedCount} numbered entries, NO OTHER TEXT):`;
  }

  /**
   * Parse batch translation response
   */
  parseBatchResponse(translatedText, expectedCount) {
    let cleaned = translatedText.trim();

    // Remove markdown code blocks
    cleaned = cleaned.replace(/```[a-z]*(?:\r?\n)?/g, '');

    const entries = [];
    const blocks = cleaned.split(/(?:\r?\n){2,}/);

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      // Match numbered entry: "N. text" or "N) text"
      const match = trimmed.match(/^(\d+)[.):\s-]+(.+)$/s);

      if (match) {
        const num = parseInt(match[1]);
        const text = match[2].trim();

        entries.push({
          index: num - 1,
          text: text
        });
      }
    }

    // Sort by index
    entries.sort((a, b) => a.index - b.index);

    return entries;
  }

  /**
   * Fix entry count mismatches by filling missing entries with original text
   */
  fixEntryCountMismatch(translatedEntries, originalBatch) {
    if (translatedEntries.length === originalBatch.length) {
      return; // Already correct
    }

    if (translatedEntries.length < originalBatch.length) {
      // Missing entries - fill with original text
      const translatedMap = new Map();
      for (const entry of translatedEntries) {
        translatedMap.set(entry.index, entry.text);
      }

      translatedEntries.length = 0;
      for (let i = 0; i < originalBatch.length; i++) {
        if (translatedMap.has(i)) {
          translatedEntries.push({ index: i, text: translatedMap.get(i) });
        } else {
          translatedEntries.push({ index: i, text: originalBatch[i].text });
        }
      }
    } else {
      // Too many entries - keep only first N
      translatedEntries.length = originalBatch.length;
    }
  }

  /**
   * Clean translated text (remove timecodes, normalize line endings)
   */
  cleanTranslatedText(text) {
    let cleaned = text.trim();

    // Remove any embedded timecodes
    const timecodePattern = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*\n?/g;
    cleaned = cleaned.replace(timecodePattern, '').trim();

    // Normalize line endings (CRLF → LF)
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    return cleaned;
  }

  /**
   * Check if batch entries are cached
   */
  checkBatchCache(batch, targetLanguage, customPrompt) {
    if (!CACHE_TRANSLATIONS) {
      return { allCached: false, entries: [] };
    }

    const cachedEntries = [];
    let cacheHits = 0;

    for (const entry of batch) {
      const cached = this.getCachedEntry(entry.text, targetLanguage, customPrompt);
      if (cached) {
        cachedEntries.push({ index: entry.id - 1, text: cached });
        cacheHits++;
      } else {
        cachedEntries.push(null);
      }
    }

    const allCached = cacheHits === batch.length;
    return { allCached, entries: allCached ? cachedEntries : [] };
  }

  /**
   * Get cached entry translation
   */
  getCachedEntry(sourceText, targetLanguage, customPrompt) {
    if (!CACHE_TRANSLATIONS) return null;

    const key = this.createCacheKey(sourceText, targetLanguage, customPrompt);
    return entryCache.get(key) || null;
  }

  /**
   * Cache an entry translation
   */
  cacheEntry(sourceText, targetLanguage, translatedText, customPrompt) {
    if (!CACHE_TRANSLATIONS) return;

    // Enforce cache size limit (LRU eviction)
    if (entryCache.size >= MAX_ENTRY_CACHE_SIZE) {
      const evictionCount = Math.floor(MAX_ENTRY_CACHE_SIZE * 0.1);
      const keysToDelete = Array.from(entryCache.keys()).slice(0, evictionCount);
      for (const key of keysToDelete) {
        entryCache.delete(key);
      }
    }

    const key = this.createCacheKey(sourceText, targetLanguage, customPrompt);
    entryCache.set(key, translatedText);
  }

  /**
   * Create cache key for an entry
   */
  createCacheKey(sourceText, targetLanguage, customPrompt) {
    const normalized = sourceText.trim().toLowerCase();
    const promptHash = customPrompt
      ? crypto.createHash('md5').update(customPrompt).digest('hex').substring(0, 8)
      : 'default';
    const hash = crypto.createHash('md5')
      .update(`${normalized}:${targetLanguage}:${promptHash}`)
      .digest('hex');
    return hash;
  }

  /**
   * Clear entry cache
   */
  clearCache() {
    entryCache.clear();
    log.debug(() => '[TranslationEngine] Entry cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: entryCache.size,
      maxSize: MAX_ENTRY_CACHE_SIZE
    };
  }
}

module.exports = TranslationEngine;
