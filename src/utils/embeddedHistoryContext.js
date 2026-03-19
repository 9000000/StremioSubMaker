function normalizeEmbeddedHistoryValue(value, fallback = '', max = 200) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const base = raw || (fallback === undefined || fallback === null ? '' : String(fallback).trim());
  if (!base) return '';
  if (Number.isFinite(max) && max > 0) {
    return base.slice(0, max);
  }
  return base;
}

function pickEmbeddedHistoryValue(values = [], fallback = '', max = 200) {
  for (const value of values) {
    const normalized = normalizeEmbeddedHistoryValue(value, '', max);
    if (normalized) return normalized;
  }
  return normalizeEmbeddedHistoryValue(fallback, '', max);
}

function buildEmbeddedHistoryContext({
  videoHash = '',
  trackId = '',
  requestVideoId = '',
  requestFilename = '',
  metadata = {}
} = {}) {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  const normalizedTrackId = normalizeEmbeddedHistoryValue(trackId, 'track', 120) || 'track';
  const trackLabel = pickEmbeddedHistoryValue(
    [
      safeMetadata.trackLabel,
      safeMetadata.label,
      safeMetadata.originalLabel,
      safeMetadata.name
    ],
    `Track ${normalizedTrackId}`
  );
  const linkedVideoId = pickEmbeddedHistoryValue(
    [
      requestVideoId,
      safeMetadata.videoId,
      safeMetadata.linkedVideoId
    ],
    '',
    200
  );
  const linkedFilename = pickEmbeddedHistoryValue(
    [
      requestFilename,
      safeMetadata.filename,
      safeMetadata.linkedFilename,
      safeMetadata.streamFilename
    ],
    '',
    200
  );
  const displaySeed = linkedFilename || trackLabel;

  return {
    title: displaySeed || `Track ${normalizedTrackId}`,
    filename: displaySeed || `Track ${normalizedTrackId}`,
    trackLabel,
    videoId: linkedVideoId || 'unknown',
    videoHash: normalizeEmbeddedHistoryValue(videoHash, 'unknown', 64) || 'unknown'
  };
}

module.exports = {
  buildEmbeddedHistoryContext,
  normalizeEmbeddedHistoryValue
};
