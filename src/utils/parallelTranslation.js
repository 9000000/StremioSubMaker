const log = require('./logger');

/**
 * Parallel Translation Utility
 *
 * Translates large subtitle files by splitting them into chunks with context overlap
 * and processing them in parallel with concurrency control.
 *
 * Features:
 * - Context preservation: Each chunk includes surrounding entries for coherence
 * - Concurrency control: Limits parallel API calls to avoid rate limits
 * - Progress tracking: Optional callbacks for UI updates
 * - Error handling: Retries failed chunks without failing entire translation
 * - Reusable: Works with any translation service that implements translateSubtitle()
 */

/**
 * Parse SRT content into structured entries
 * @param {string} srtContent - Raw SRT subtitle content
 * @returns {Array<{index: number, timing: string, text: string, raw: string}>}
 */
function parseSubtitleEntries(srtContent) {
  const entries = [];

  // Normalize line endings
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split by double newlines (entry separator)
  const rawEntries = normalized.split(/\n\n+/).filter(e => e.trim());

  for (const rawEntry of rawEntries) {
    const lines = rawEntry.trim().split('\n');
    if (lines.length < 3) continue; // Invalid entry

    const index = parseInt(lines[0], 10);
    if (isNaN(index)) continue;

    const timing = lines[1];
    const text = lines.slice(2).join('\n');

    entries.push({
      index,
      timing,
      text,
      raw: rawEntry.trim()
    });
  }

  return entries;
}

/**
 * Estimate token count for text (conservative estimation)
 * @param {string} text - Text to estimate
 * @returns {number} - Estimated token count
 */
function estimateTokenCount(text) {
  if (!text) return 0;
  // Provider-agnostic chunking heuristic — actual token counts come from the provider.
  const approx = Math.ceil(text.length / 3);
  return Math.ceil(approx * 1.1);
}

/**
 * Create chunks with context overlap
 * @param {Array<Object>} entries - Parsed subtitle entries
 * @param {Object} options - Chunking options
 * @param {number} options.targetChunkTokens - Target tokens per chunk (default: 12000)
 * @param {number} options.contextSize - Number of entries for context before/after (default: 3)
 * @param {number} options.minChunkSize - Minimum entries per chunk (default: 10)
 * @returns {Array<{entries: Array, startIdx: number, endIdx: number, hasContext: boolean}>}
 */
function createChunksWithContext(entries, options = {}) {
  const {
    targetChunkTokens = 12000,
    contextSize = 3,
    minChunkSize = 10
  } = options;

  if (entries.length === 0) return [];

  // Calculate total tokens
  const totalTokens = entries.reduce((sum, e) => sum + estimateTokenCount(e.raw), 0);

  // If total is small enough, return single chunk
  if (totalTokens <= targetChunkTokens * 1.5 || entries.length <= minChunkSize * 2) {
    log.debug(() => `[ParallelTranslation] Small file (${totalTokens} tokens, ${entries.length} entries), using single chunk`);
    return [{
      entries: entries,
      startIdx: 0,
      endIdx: entries.length - 1,
      hasContext: false
    }];
  }

  const chunks = [];
  let currentIdx = 0;

  while (currentIdx < entries.length) {
    let chunkTokens = 0;
    let chunkEndIdx = currentIdx;

    // Build chunk until we reach target tokens or min size
    while (chunkEndIdx < entries.length) {
      const entryTokens = estimateTokenCount(entries[chunkEndIdx].raw);

      // If we've reached min size and adding this would exceed target, stop
      if (chunkEndIdx - currentIdx >= minChunkSize && chunkTokens + entryTokens > targetChunkTokens) {
        break;
      }

      chunkTokens += entryTokens;
      chunkEndIdx++;

      // Don't make chunks too large
      if (chunkTokens >= targetChunkTokens * 1.5) {
        break;
      }
    }

    // Ensure we make progress
    if (chunkEndIdx === currentIdx) {
      chunkEndIdx = Math.min(currentIdx + minChunkSize, entries.length);
    }

    // Add context
    const contextStartIdx = Math.max(0, currentIdx - contextSize);
    const contextEndIdx = Math.min(entries.length - 1, chunkEndIdx + contextSize - 1);

    // Build chunk with context
    const chunkEntries = [];
    for (let i = contextStartIdx; i <= contextEndIdx; i++) {
      const entry = { ...entries[i] };
      // Mark context entries
      if (i < currentIdx || i >= chunkEndIdx) {
        entry.isContext = true;
      }
      chunkEntries.push(entry);
    }

    chunks.push({
      entries: chunkEntries,
      startIdx: currentIdx,
      endIdx: chunkEndIdx - 1,
      hasContext: contextStartIdx < currentIdx || contextEndIdx >= chunkEndIdx
    });

    currentIdx = chunkEndIdx;
  }

  log.debug(() => `[ParallelTranslation] Created ${chunks.length} chunks from ${entries.length} entries (${totalTokens} tokens)`);

  return chunks;
}

/**
 * Reconstruct SRT from entries
 * @param {Array<Object>} entries - Subtitle entries
 * @returns {string} - SRT content
 */
function reconstructSRT(entries) {
  return entries.map(e => `${e.index}\n${e.timing}\n${e.text}`).join('\n\n') + '\n\n';
}

// Defensive cleaner: strip time ranges/timestamps that may leak into text
function _stripTimecodes(text) {
  let cleaned = String(text || '').trim();
  const rangeLine = /^(?:\s*)\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*(?:-->|–>|—>|->|→|to)\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?(?:\s*)$/gm;
  cleaned = cleaned.replace(rangeLine, '');
  const rangeInline = /\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*(?:-->|–>|—>|->|→|to)\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?/g;
  cleaned = cleaned.replace(rangeInline, '');
  const tsLine = /^(?:\s*)\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?(?:\s*)$/gm;
  cleaned = cleaned.replace(tsLine, '');
  const bracketedTs = /[\[(]\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*[\])]/g;
  cleaned = cleaned.replace(bracketedTs, '');
  return cleaned;
}

/**
 * Translate a single chunk
 * @param {Object} chunk - Chunk to translate
 * @param {Object} translationService - Service with translateSubtitle() method
 * @param {string} targetLanguage - Target language name
 * @param {string} customPrompt - Custom translation prompt
 * @param {number} chunkNumber - Chunk number for logging
 * @param {number} totalChunks - Total number of chunks
 * @returns {Promise<Array<Object>>} - Translated entries (without context entries)
 */
async function translateChunk(chunk, translationService, sourceLanguage, targetLanguage, customPrompt, chunkNumber, totalChunks) {
  const { entries, startIdx, endIdx } = chunk;

  // Build SRT content for this chunk
  const chunkSRT = reconstructSRT(entries);

  log.debug(() => `[ParallelTranslation] Translating chunk ${chunkNumber}/${totalChunks} (entries ${startIdx}-${endIdx}, ${entries.length} total with context)`);

  try {
    // Translate using the service
    const translatedSRT = await translationService.translateSubtitle(
      chunkSRT,
      sourceLanguage || 'detected source language',
      targetLanguage,
      customPrompt
    );

    // Parse translated result
    const translatedEntries = parseSubtitleEntries(translatedSRT);

    // Filter out context entries based on original indices
    const mainEntries = [];
    for (let i = 0; i < entries.length; i++) {
      const originalEntry = entries[i];
      if (!originalEntry.isContext && translatedEntries[i]) {
        // Preserve original index and timing
        mainEntries.push({
          index: originalEntry.index,
          timing: originalEntry.timing,
          text: translatedEntries[i].text
        });
      }
    }

    log.debug(() => `[ParallelTranslation] Chunk ${chunkNumber}/${totalChunks} completed (${mainEntries.length} entries translated)`);

    return mainEntries;

  } catch (error) {
    log.error(() => [`[ParallelTranslation] Chunk ${chunkNumber}/${totalChunks} failed: ${error.message}`, error]);
    throw error;
  }
}

/**
 * Translate with controlled concurrency
 * @param {Array<Function>} tasks - Array of async functions to execute
 * @param {number} maxConcurrency - Maximum concurrent tasks
 * @param {Function} onProgress - Optional progress callback (current, total)
 * @returns {Promise<Array>} - Results in order
 */
async function translateWithConcurrency(tasks, maxConcurrency, onProgress = null) {
  const results = new Array(tasks.length);
  let currentIndex = 0;
  let completedCount = 0;

  async function executeNext() {
    const taskIndex = currentIndex++;
    if (taskIndex >= tasks.length) return;

    try {
      results[taskIndex] = await tasks[taskIndex]();
      completedCount++;
      if (onProgress) {
        onProgress(completedCount, tasks.length);
      }
    } catch (error) {
      // Retry once on failure
      log.warn(() => `[ParallelTranslation] Task ${taskIndex + 1} failed, retrying...`);
      try {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
        results[taskIndex] = await tasks[taskIndex]();
        completedCount++;
        if (onProgress) {
          onProgress(completedCount, tasks.length);
        }
      } catch (retryError) {
        log.error(() => [`[ParallelTranslation] Task ${taskIndex + 1} failed after retry: ${retryError.message}`, retryError]);
        throw retryError;
      }
    }

    // Execute next task
    return executeNext();
  }

  // Start initial batch of workers
  const workers = Array(Math.min(maxConcurrency, tasks.length))
    .fill(null)
    .map(() => executeNext());

  await Promise.all(workers);

  return results;
}

/**
 * Main parallel translation function
 *
 * @param {string} srtContent - SRT subtitle content to translate
 * @param {Object} translationService - Service with translateSubtitle() method (e.g., GeminiService)
 * @param {string} targetLanguage - Target language name
 * @param {Object} options - Translation options
 * @param {string} options.customPrompt - Custom translation prompt
 * @param {number} options.maxConcurrency - Max parallel requests (default: 3)
 * @param {number} options.targetChunkTokens - Target tokens per chunk (default: 12000)
 * @param {number} options.contextSize - Context entries before/after (default: 3)
 * @param {Function} options.onProgress - Progress callback (current, total)
 * @returns {Promise<string>} - Translated SRT content
 */
async function translateInParallel(srtContent, translationService, targetLanguage, options = {}) {
  const {
    sourceLanguage = 'detected source language',
    customPrompt = null,
    maxConcurrency = 3,
    targetChunkTokens = 12000,
    contextSize = 3,
    onProgress = null
  } = options;

  const startTime = Date.now();

  // Parse SRT into entries
  log.debug(() => '[ParallelTranslation] Parsing subtitle entries...');
  const entries = parseSubtitleEntries(srtContent);

  if (entries.length === 0) {
    throw new Error('No valid subtitle entries found in content');
  }

  log.debug(() => `[ParallelTranslation] Parsed ${entries.length} subtitle entries`);

  // Create chunks with context
  const chunks = createChunksWithContext(entries, {
    targetChunkTokens,
    contextSize,
    minChunkSize: 10
  });

  // If only one chunk, use simple translation
  if (chunks.length === 1) {
    log.debug(() => '[ParallelTranslation] Using single-chunk translation');
    if (onProgress) onProgress(0, 1);
    const result = await translationService.translateSubtitle(
      srtContent,
      sourceLanguage || 'detected source language',
      targetLanguage,
      customPrompt
    );
    if (onProgress) onProgress(1, 1);
    return result;
  }

  // Create translation tasks
  const tasks = chunks.map((chunk, index) => {
    return () => translateChunk(
      chunk,
      translationService,
      sourceLanguage,
      targetLanguage,
      customPrompt,
      index + 1,
      chunks.length
    );
  });

  log.debug(() => `[ParallelTranslation] Starting parallel translation: ${chunks.length} chunks, max ${maxConcurrency} concurrent`);

  // Execute with concurrency control
  const translatedChunks = await translateWithConcurrency(tasks, maxConcurrency, onProgress);

  // Merge results
  const allTranslatedEntries = translatedChunks.flat();

  // Sort by original index to ensure correct order
  allTranslatedEntries.sort((a, b) => a.index - b.index);

  // Reconstruct final SRT
  const finalSRT = reconstructSRT(allTranslatedEntries);

  // Final safety pass: strip any time-like artifacts in text
  try {
    const entries = parseSubtitleEntries(finalSRT);
    if (entries.length > 0) {
      for (const e of entries) {
        e.text = _stripTimecodes(e.text);
      }
      return reconstructSRT(entries);
    }
  } catch (_) { }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  log.debug(() => `[ParallelTranslation] Translation complete: ${allTranslatedEntries.length} entries in ${duration}s`);

  return finalSRT;
}

module.exports = {
  translateInParallel,
  parseSubtitleEntries,
  createChunksWithContext,
  estimateTokenCount
};
