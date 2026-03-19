const { detectASSFormat, convertToSRT } = require('./subtitle');

function normalizeSubtitleFormatHint(...values) {
  for (const value of values) {
    const lower = String(value || '').trim().toLowerCase();
    if (!lower) continue;
    if (lower.includes('webvtt') || /\bvtt\b/.test(lower)) return 'vtt';
    if (lower.includes('s_text/ssa') || lower.includes('substation alpha') || /\bssa\b/.test(lower)) return 'ssa';
    if (lower.includes('s_text/ass') || lower.includes('advanced substation alpha') || /\bass\b/.test(lower)) return 'ass';
    if (lower.includes('subrip') || lower.includes('utf8') || lower.includes('mov_text') || lower.includes('tx3g') || /\bsrt\b/.test(lower)) return 'srt';
  }
  return null;
}

function detectEmbeddedSubtitleFormat(track = {}) {
  const content = typeof track.content === 'string' ? track.content : '';
  const trimmed = content.trimStart();
  if (trimmed) {
    if (/^\d+\s*[\r\n]/.test(trimmed)) return 'srt';
    if (trimmed.startsWith('WEBVTT')) return 'vtt';
    const detectedAss = detectASSFormat(trimmed);
    if (detectedAss.isASS) {
      return detectedAss.format === 'ssa' ? 'ssa' : 'ass';
    }
  }

  return (
    normalizeSubtitleFormatHint(
      track.sourceFormat,
      track.codec,
      track.mime,
      track.label,
      track.originalLabel,
      track.name,
      track.metadata?.sourceFormat,
      track.metadata?.codec,
      track.metadata?.mime,
      track.metadata?.label,
      track.metadata?.originalLabel,
      track.metadata?.name
    ) || 'srt'
  );
}

function getSubtitleMime(format) {
  switch (String(format || '').toLowerCase()) {
    case 'ass':
    case 'ssa':
      return 'text/x-ssa; charset=utf-8';
    case 'vtt':
      return 'text/vtt; charset=utf-8';
    default:
      return 'application/x-subrip; charset=utf-8';
  }
}

function getSubtitleExtension(format) {
  switch (String(format || '').toLowerCase()) {
    case 'ass':
      return 'ass';
    case 'ssa':
      return 'ssa';
    case 'vtt':
      return 'vtt';
    default:
      return 'srt';
  }
}

function shouldDeliverEmbeddedSubtitleAsSrt(track = {}, config = {}) {
  if (config?.forceSRTOutput === true) return true;
  if (config?.convertAssToVtt === false) return false;
  const sourceFormat = detectEmbeddedSubtitleFormat(track);
  return sourceFormat === 'ass' || sourceFormat === 'ssa';
}

function prepareEmbeddedSubtitleDelivery(track = {}, config = {}, options = {}) {
  const content = typeof track.content === 'string' ? track.content : '';
  const sourceFormat = detectEmbeddedSubtitleFormat(track);
  const conversionRequested = shouldDeliverEmbeddedSubtitleAsSrt(track, config);

  let deliveryContent = content;
  let deliveryFormat = sourceFormat;
  let converted = false;
  let conversionFailed = false;

  if (content && conversionRequested) {
    const convertedContent = convertToSRT(content, options.logPrefix || '[Embedded Delivery]');
    const convertedFormat = detectEmbeddedSubtitleFormat({ ...track, content: convertedContent });
    if (convertedFormat === 'srt') {
      deliveryContent = convertedContent;
      deliveryFormat = 'srt';
      converted = convertedContent !== content || sourceFormat !== 'srt';
    } else if (sourceFormat !== 'srt') {
      conversionFailed = true;
    }
  }

  return {
    sourceFormat,
    deliveryFormat,
    content: deliveryContent,
    mime: getSubtitleMime(deliveryFormat),
    ext: getSubtitleExtension(deliveryFormat),
    converted,
    conversionRequested,
    conversionFailed
  };
}

module.exports = {
  detectEmbeddedSubtitleFormat,
  getSubtitleExtension,
  getSubtitleMime,
  normalizeSubtitleFormatHint,
  prepareEmbeddedSubtitleDelivery,
  shouldDeliverEmbeddedSubtitleAsSrt
};
