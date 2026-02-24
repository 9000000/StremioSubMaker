const log = require('./logger');
const { parseSRT, toSRT } = require('./subtitle');

/**
 * Executes a standalone parallel batch translation to maximize token throughput.
 * This is restricted to Dev Mode and non-ElfHosted environments.
 *
 * @param {Object} engine - The TranslationEngine instance
 * @param {Array} entries - Array of parsed SRT entries
 * @param {String} targetLanguage - Target language name
 * @param {String} customPrompt - Custom prompt (optional)
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Array>} - Translated entries
 */
async function executeParallelTranslation(engine, entries, targetLanguage, customPrompt, onProgress) {
    if (!entries || entries.length === 0) {
        throw new Error('Invalid SRT content: no valid entries found');
    }

    const CONCURRENCY_LIMIT = Math.max(1, Math.min(5, parseInt(engine.advancedSettings?.parallelBatchesCount) || 3));
    const PARALLEL_BATCH_SIZE = 150; // Hardcoded optimal batch size for parallelism

    log.info(() => `[ParallelTranslation] Initiating parallel translation mode. Entries: ${entries.length}, Concurrency: ${CONCURRENCY_LIMIT}`);

    // Create batches explicitly sized for parallel mode
    const batches = [];
    for (let i = 0; i < entries.length; i += PARALLEL_BATCH_SIZE) {
        batches.push(entries.slice(i, i + PARALLEL_BATCH_SIZE));
    }

    // Storage for results keyed by batch index (0-based)
    const batchResults = new Array(batches.length);
    // Stats: set batch count on engine for history tracking
    if (engine.translationStats) engine.translationStats.batchCount = batches.length;
    const translatedEntries = [];
    let completedSRT = '';
    let completedEntryCount = 0;
    let globalStreamSequence = 0;

    // Helper to fire standard progress events
    const fireProgress = async (batchIdx) => {
        if (typeof onProgress === 'function') {
            try {
                await onProgress({
                    totalEntries: entries.length,
                    completedEntries: translatedEntries.length,
                    currentBatch: batchIdx + 1,
                    totalBatches: batches.length,
                    partialSRT: completedSRT
                });
            } catch (err) {
                log.warn(() => ['[ParallelTranslation] Error in progress callback:', err.message]);
            }
        }
    };

    // -------------------------------------------------------------------------
    // Build one task per batch. Batch 0 uses streaming; the rest do not.
    // All tasks are kicked off concurrently subject to CONCURRENCY_LIMIT.
    // -------------------------------------------------------------------------
    const firstBatch = batches[0];
    const firstBatchStartId = firstBatch[0]?.id || 1;
    const streamingBatchEntries = new Map();

    // Task factory — returns an async thunk for the given batch index
    const makeTask = (batchIdx) => async () => {
        // NOTE: maybeRotateKeyForBatch(0) is a no-op by design.
        // For batch 0 we intentionally skip cloning the engine so streaming
        // callbacks are wired directly to the original engine instance.
        if (batchIdx === 0) {
            const firstContext = engine.enableBatchContext
                ? engine.prepareContextForBatch(firstBatch, entries, translatedEntries, 0)
                : null;

            return engine.translateBatch(
                firstBatch,
                targetLanguage,
                customPrompt,
                0,
                batches.length,
                firstContext,
                {
                    streaming: engine.enableStreaming,
                    onStreamProgress: async (payload) => {
                        if (typeof onProgress !== 'function' || !payload?.partialSRT) return;

                        const parsed = parseSRT(payload.partialSRT) || [];
                        const offset = (payload.batchStartId || firstBatchStartId) - 1;

                        for (const entry of parsed) {
                            const globalId = (entry.id || 0) + offset;
                            if (globalId <= 0) continue;
                            streamingBatchEntries.set(globalId, {
                                id: globalId,
                                timecode: entry.timecode,
                                text: engine.cleanTranslatedText(entry.text || '')
                            });
                        }

                        const streamEntriesCount = streamingBatchEntries.size;
                        // Throttle UI updates to milestones: 30, 60, 90… (or the end)
                        if (streamEntriesCount > 0 && (streamEntriesCount % 30 === 0 || streamEntriesCount === firstBatch.length)) {
                            const streamEntries = Array.from(streamingBatchEntries.values()).sort((a, b) => a.id - b.id);
                            const streamNormalized = streamEntries.map((entry, idx) => ({
                                id: idx + 1,
                                timecode: entry.timecode,
                                text: entry.text
                            }));

                            const streamSRT = toSRT(streamNormalized);
                            const seq = ++globalStreamSequence;
                            try {
                                await onProgress({
                                    totalEntries: entries.length,
                                    completedEntries: Math.min(entries.length, streamEntriesCount),
                                    currentBatch: payload.currentBatch || 1,
                                    totalBatches: batches.length,
                                    partialSRT: streamSRT,
                                    streaming: true,
                                    streamSequence: seq
                                });
                            } catch (err) {
                                log.warn(() => ['[ParallelTranslation] Streaming callback error:', err.message]);
                            }
                        }
                    }
                }
            );
        }

        // Batches 1-N: clone the engine to avoid key-rotation mutations on the
        // shared instance, then translate without streaming.
        const workerEngine = Object.assign(
            Object.create(Object.getPrototypeOf(engine)),
            engine
        );

        // Give each worker its own translationStats to avoid concurrent mutation
        // of the shared reference. Start with zeroed counters so merge-back is additive.
        if (engine.translationStats) {
            workerEngine.translationStats = {
                entryCount: 0,
                batchCount: 0,
                mismatchDetected: false,
                missingEntries: 0,
                recoveredEntries: 0,
                usedSecondaryProvider: false,
                secondaryProviderName: null,
                rateLimitErrors: 0,
                keyRotationRetries: 0,
                errorTypes: [],
                jsonXmlFallback: false,
            };
        }

        await workerEngine.maybeRotateKeyForBatch(batchIdx);

        const batch = batches[batchIdx];
        // Context resolved at dispatch time; parallel peers won't be in
        // translatedEntries yet — this is expected behaviour.
        const context = workerEngine.enableBatchContext
            ? workerEngine.prepareContextForBatch(batch, entries, translatedEntries, batchIdx)
            : null;

        let result;
        try {
            result = await workerEngine.translateBatch(
                batch,
                targetLanguage,
                customPrompt,
                batchIdx,
                batches.length,
                context,
                { streaming: false }
            );
        } finally {
            // Merge worker stats back into the original engine's stats.
            // Uses finally so stats from failed batches (rate limits, error types)
            // are preserved — these are the most valuable diagnostics.
            if (workerEngine.translationStats && engine.translationStats) {
                const ws = workerEngine.translationStats;
                const es = engine.translationStats;
                // Accumulate numeric counters
                es.rateLimitErrors += (ws.rateLimitErrors || 0);
                es.keyRotationRetries += (ws.keyRotationRetries || 0);
                es.missingEntries += (ws.missingEntries || 0);
                es.recoveredEntries += (ws.recoveredEntries || 0);
                // Merge boolean flags
                if (ws.usedSecondaryProvider) es.usedSecondaryProvider = true;
                if (ws.mismatchDetected) es.mismatchDetected = true;
                if (ws.jsonXmlFallback) es.jsonXmlFallback = true;
                if (ws.secondaryProviderName && !es.secondaryProviderName) es.secondaryProviderName = ws.secondaryProviderName;
                // Merge error types (deduplicated)
                if (Array.isArray(ws.errorTypes)) {
                    for (const et of ws.errorTypes) {
                        if (!es.errorTypes.includes(et)) es.errorTypes.push(et);
                    }
                }
            }
        }

        return result;
    };

    log.info(() => `[ParallelTranslation] Launching ${batches.length} batches with concurrency ${CONCURRENCY_LIMIT}.`);

    // -------------------------------------------------------------------------
    // Ordered queue: runs up to CONCURRENCY_LIMIT tasks at once.
    // Results are appended to translatedEntries in batch order as they resolve.
    // -------------------------------------------------------------------------
    let nextBatchToAppend = 0;

    async function runWithProgressiveSequentialResolution(tasks, limit) {
        const executing = new Set();

        for (let i = 0; i < tasks.length; i++) {
            const taskIdx = i; // capture for closure
            const p = Promise.resolve().then(() => tasks[taskIdx]());

            const wrapped = p.then(async (res) => {
                batchResults[taskIdx] = res;
                executing.delete(wrapped);

                // Drain completed batches in order so translatedEntries stays sequential
                while (nextBatchToAppend < tasks.length && batchResults[nextBatchToAppend] !== undefined) {
                    const currentToAppend = nextBatchToAppend;
                    nextBatchToAppend++;

                    const batchData = batches[currentToAppend];
                    const resolvedData = batchResults[currentToAppend];

                    for (let j = 0; j < batchData.length; j++) {
                        const original = batchData[j];
                        const translated = resolvedData[j] || {};
                        const cleanedText = engine.cleanTranslatedText(translated.text || original.text);
                        const timecode = (engine.sendTimestampsToAI && translated.timecode) ? translated.timecode : original.timecode;

                        translatedEntries.push({
                            id: original.id,
                            timecode,
                            text: cleanedText
                        });
                    }

                    completedEntryCount = translatedEntries.length;
                    completedSRT = toSRT(translatedEntries);
                    await fireProgress(currentToAppend);
                }
            });

            executing.add(wrapped);
            if (executing.size >= limit) {
                await Promise.race([...executing]);
            }
        }
        await Promise.all([...executing]);
    }

    // Build tasks for ALL batches (0 through N) and run them together
    const allTasks = batches.map((_, idx) => makeTask(idx));
    await runWithProgressiveSequentialResolution(allTasks, CONCURRENCY_LIMIT);

    log.info(() => `[ParallelTranslation] Translation completed: ${translatedEntries.length} entries`);
    return translatedEntries;
}

module.exports = {
    executeParallelTranslation
};
