const { deriveVideoHash } = require('./videoHash');

/**
 * Select the best filename evidence exposed by a stream URL.
 *
 * Stremio's local streaming server uses opaque torrent routes such as
 * /<info-hash>/<file-index>. A trailing index like "0" is not a filename and
 * must not replace the filename already linked from Stremio, otherwise every
 * toolbox hash check reports a false mismatch.
 *
 * This function is deliberately self-contained because its source is also
 * embedded in the browser runtimes generated for the toolbox pages.
 */
function selectStreamFilename(streamUrl, fallbackFilename = '') {
  const fallback = (fallbackFilename && String(fallbackFilename).trim()) || '';
  if (!streamUrl) return fallback;

  const decodePart = (value) => {
    const raw = (value && String(value).trim()) || '';
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch (_) {
      return raw;
    }
  };
  const tailPart = (value) => {
    const normalized = decodePart(value).replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() || '';
  };
  const isOpaqueLocator = (value) => {
    const candidate = (value || '').trim();
    return !candidate
      || /^\d+$/.test(candidate)
      || /^[a-f0-9]{16,}$/i.test(candidate)
      || /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(candidate)
      || /^(?:download|file|play|stream|video)$/i.test(candidate);
  };

  try {
    const url = new URL(streamUrl);

    // Explicit filename parameters are strongest, but ignore values that are
    // plainly IDs, booleans, or file indexes (for example ?file=0).
    for (const key of ['filename', 'file', 'download', 'dn']) {
      const candidate = tailPart(url.searchParams.get(key));
      if (candidate && !isOpaqueLocator(candidate)) return candidate;
    }

    const parts = (url.pathname || '').split('/').filter(Boolean);
    const pathnameTail = parts.length ? tailPart(parts[parts.length - 1]) : '';
    if (/\.[a-z0-9]{2,8}$/i.test(pathnameTail)) return pathnameTail;

    // `name` and extensionless path segments are only hints. Prefer the linked
    // filename when available because resolver URLs commonly use a short title
    // in `name`, and Stremio torrent URLs end in a numeric file index.
    const nameHint = tailPart(url.searchParams.get('name'));
    if (fallback) return fallback;
    if (nameHint && !isOpaqueLocator(nameHint)) return nameHint;
    if (pathnameTail && !isOpaqueLocator(pathnameTail)) return pathnameTail;
  } catch (_) {
    // Invalid URLs are handled by the caller's normal URL validation. Keeping
    // the linked filename here avoids manufacturing a second, misleading hash.
  }

  return fallback;
}

function extractStreamVideoId(streamUrl, fallbackVideoId = '') {
  let streamVideoId = (fallbackVideoId && String(fallbackVideoId).trim()) || '';
  if (!streamUrl) return streamVideoId;

  try {
    const url = new URL(streamUrl);
    const idKeys = [
      'videoId', 'video', 'id', 'mediaid', 'imdb', 'tmdb', 'kitsu', 'anidb',
      'mal', 'myanimelist', 'anilist', 'tvdb', 'simkl', 'livechart', 'anisearch'
    ];
    for (const key of idKeys) {
      const value = url.searchParams.get(key);
      if (value && value.trim()) {
        streamVideoId = value.trim();
        break;
      }
    }
    if (!streamVideoId) {
      const parts = (url.pathname || '').split('/').filter(Boolean);
      const directId = parts.find((part) => /^tt\d+/i.test(part) || part.includes(':'));
      if (directId) streamVideoId = directId.trim();
    }
  } catch (_) {
    // Keep the linked video ID.
  }

  return streamVideoId;
}

function deriveStreamHashFromUrl(streamUrl, fallback = {}) {
  const fallbackFilename = fallback.filename || fallback.streamFilename || '';
  const filename = selectStreamFilename(streamUrl, fallbackFilename);
  const videoId = extractStreamVideoId(streamUrl, fallback.videoId || '');
  return {
    hash: deriveVideoHash(filename, videoId),
    filename,
    videoId,
    source: 'stream-url'
  };
}

function streamFilenameSelectorClientScript() {
  return `const selectStreamFilename = ${selectStreamFilename.toString()};`;
}

module.exports = {
  selectStreamFilename,
  extractStreamVideoId,
  deriveStreamHashFromUrl,
  streamFilenameSelectorClientScript
};
