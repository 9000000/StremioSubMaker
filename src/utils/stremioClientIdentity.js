'use strict';

const COMMUNITY_V5_BLOCKED_HOSTS = Object.freeze([
  'stremio.zarg.me',
  'zaarrg.github.io'
]);

const COMMUNITY_V5_PATH_HINTS = Object.freeze([
  'stremio-web-shell-fixes'
]);

const STREMIO_KAI_HEADER = 'x-stremio-kai';
const STREMIO_KAI_CLIENT_HEADER_NAMES = Object.freeze([
  STREMIO_KAI_HEADER,
  'x-submaker-client',
  'x-stremio-client'
]);

function getHeader(req, name) {
  if (!req || !name) return '';
  if (typeof req.get === 'function') {
    return req.get(name) || '';
  }

  const headers = req.headers || {};
  const lowerName = name.toLowerCase();
  return headers[lowerName] || headers[name] || '';
}

function normalizeOrigin(origin) {
  if (!origin) return '';
  const trimmed = String(origin).trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1).toLowerCase() : trimmed.toLowerCase();
}

function extractHostnameFromOrigin(origin) {
  if (!origin) return '';
  const normalized = normalizeOrigin(origin);
  try {
    return (new URL(normalized).hostname || '').toLowerCase();
  } catch (_) {
    const withoutScheme = normalized.replace(/^[a-z]+:\/\//i, '');
    const hostPort = withoutScheme.split('/')[0] || '';
    return hostPort.split(':')[0].toLowerCase();
  }
}

function hostMatches(host, blockedHost) {
  return host === blockedHost || host.endsWith(`.${blockedHost}`);
}

function valueIdentifiesStremioKai(value, dedicatedHeader = false) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  if (['0', 'false', 'no', 'off', 'none', 'null', 'undefined'].includes(lower)) {
    return false;
  }

  // The dedicated header is only sent by a client that deliberately opts into
  // the Kai allow path. Its concrete value may be a version such as "4.6.2".
  if (dedicatedHeader) return true;

  return /\bstremio[\s._-]*kai\b/.test(lower) || /\bstremiokai\b/.test(lower);
}

function accessControlRequestIncludesHeader(req, headerName) {
  const requested = getHeader(req, 'access-control-request-headers');
  if (!requested) return false;
  const normalizedHeaderName = headerName.toLowerCase();
  return requested
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .some((item) => item === normalizedHeaderName);
}

function hasExplicitStremioKaiHeader(req) {
  for (const headerName of STREMIO_KAI_CLIENT_HEADER_NAMES) {
    const value = getHeader(req, headerName);
    if (valueIdentifiesStremioKai(value, headerName === STREMIO_KAI_HEADER)) {
      return true;
    }
  }

  // Browser preflights do not include the future header value, only the list
  // of requested custom headers. Accept only the dedicated Kai marker here.
  return accessControlRequestIncludesHeader(req, STREMIO_KAI_HEADER);
}

function hasStremioKaiUserAgent(req) {
  const userAgent = getHeader(req, 'user-agent');
  const brands = getHeader(req, 'sec-ch-ua');
  return valueIdentifiesStremioKai(userAgent) || valueIdentifiesStremioKai(brands);
}

function isStremioKaiRequest(req) {
  return hasExplicitStremioKaiHeader(req) || hasStremioKaiUserAgent(req);
}

function isBlockedCommunityV5Request(req) {
  if (!req) return false;

  // Kai is built on the same Community v5 shell and can share its origin and
  // StremioShell UA. Require a positive Kai marker before bypassing this deny.
  if (isStremioKaiRequest(req)) return false;

  const origin = getHeader(req, 'origin');
  const referer = getHeader(req, 'referer');
  const originHost = extractHostnameFromOrigin(origin);
  const refererHost = extractHostnameFromOrigin(referer);
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedReferer = normalizeOrigin(referer);

  const hostBlocked = COMMUNITY_V5_BLOCKED_HOSTS.some((host) =>
    hostMatches(originHost, host) || hostMatches(refererHost, host)
  );

  const knownPathHint = COMMUNITY_V5_PATH_HINTS.some((hint) =>
    normalizedOrigin.includes(hint) || normalizedReferer.includes(hint)
  );

  return hostBlocked || knownPathHint;
}

module.exports = {
  COMMUNITY_V5_BLOCKED_HOSTS,
  STREMIO_KAI_HEADER,
  extractHostnameFromOrigin,
  hasExplicitStremioKaiHeader,
  isBlockedCommunityV5Request,
  isStremioKaiRequest,
  normalizeOrigin
};
