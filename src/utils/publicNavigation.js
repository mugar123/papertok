import { isValidHandle, normalizeHandle } from './userHandle.js';

const VITE_BASE_URL = import.meta.env?.BASE_URL || '/';

export const DEFAULT_PUBLIC_ORIGIN = 'https://mugar123.github.io';
export const DEFAULT_SHARE_IMAGE_PATH = '/og/papertok-share.png';
export const PUBLIC_ROUTE_PREFIX = '/public';
export const PUBLIC_ENTITY_TYPES = Object.freeze([
  'author',
  'institution',
  'project',
  'topic',
  'concept',
  'source',
]);

const PUBLIC_ENTITY_TYPE_SET = new Set(PUBLIC_ENTITY_TYPES);

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  const hasControlCharacter = [...text].some(character => {
    const codePoint = character.charCodeAt(0);
    return codePoint < 32 || codePoint === 127;
  });
  return hasControlCharacter ? '' : text;
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function normalizeRouterPath(path) {
  const value = cleanText(path).replace(/^#/, '');
  if (!value) return '/';
  if (value === '/') return '/';

  const queryIndex = value.indexOf('?');
  const pathname = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  const query = queryIndex >= 0 ? value.slice(queryIndex) : '';
  const normalizedPathname = `/${pathname.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`;
  return `${normalizedPathname}${query}`;
}

export function getViteBasePath(base = VITE_BASE_URL) {
  const rawBase = cleanText(base);
  if (!rawBase || rawBase === '.' || rawBase === './') return '/';

  let pathname = rawBase;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(rawBase)) {
    try {
      pathname = new URL(rawBase).pathname;
    } catch {
      pathname = '/';
    }
  }

  pathname = pathname.split(/[?#]/, 1)[0] || '/';
  pathname = `/${pathname.replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`;
  if (!pathname.endsWith('/')) pathname += '/';
  return pathname;
}

function getRuntimeOrigin() {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  if (typeof globalThis !== 'undefined' && globalThis.location?.origin) return globalThis.location.origin;
  return DEFAULT_PUBLIC_ORIGIN;
}

function normalizeOrigin(origin) {
  try {
    const url = new URL(cleanText(origin) || DEFAULT_PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol)) return DEFAULT_PUBLIC_ORIGIN;
    return url.origin;
  } catch {
    return DEFAULT_PUBLIC_ORIGIN;
  }
}

export function getSiteRootUrl({ origin = getRuntimeOrigin(), base = VITE_BASE_URL } = {}) {
  return new URL(getViteBasePath(base), `${normalizeOrigin(origin)}/`).href;
}

export function getHashRoute(path) {
  return `#${normalizeRouterPath(path)}`;
}

export function getAbsoluteShareUrl(path, options = {}) {
  const value = cleanText(path);
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).href;
    } catch {
      return null;
    }
  }

  const rootUrl = getSiteRootUrl(options);
  return `${rootUrl}${getHashRoute(value)}`;
}

function normalizeEntityType(type) {
  const normalized = cleanText(type).toLowerCase();
  return PUBLIC_ENTITY_TYPE_SET.has(normalized) ? normalized : '';
}

function resolveEntityInput(typeOrEntity, id, options) {
  if (typeOrEntity && typeof typeOrEntity === 'object') {
    return {
      type: typeOrEntity.type,
      id: typeOrEntity.id
        || typeOrEntity.canonicalId
        || typeOrEntity.code
        || typeOrEntity.externalId,
      options: id && typeof id === 'object' ? id : options,
    };
  }

  return { type: typeOrEntity, id, options };
}

export function getPublicEntityPath(typeOrEntity, id, options = {}) {
  const input = resolveEntityInput(typeOrEntity, id, options);
  const type = normalizeEntityType(input.type);
  const identifier = cleanText(input.id);
  if (!type || !identifier) return null;

  const path = `${PUBLIC_ROUTE_PREFIX}/entity/${encodePathSegment(type)}/${encodePathSegment(identifier)}`;
  const includeName = input.options?.includeName === true;
  const name = cleanText(input.options?.name || typeOrEntity?.displayName);
  return includeName && name ? `${path}?name=${encodeURIComponent(name)}` : path;
}

export function getPublicEntityUrl(typeOrEntity, id, options = {}) {
  const input = resolveEntityInput(typeOrEntity, id, options);
  const path = getPublicEntityPath(typeOrEntity, id, input.options || options);
  return path ? getAbsoluteShareUrl(path, input.options || options) : null;
}

function normalizeDoi(value) {
  let doi = cleanText(value)
    .replace(/^doi:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '');
  if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) return '';
  return doi.toLowerCase();
}

function normalizeArxivId(value) {
  let arxivId = cleanText(value)
    .replace(/^arxiv:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  if (!/^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)?\/\d{7})(?:v\d+)?$/i.test(arxivId)) {
    return '';
  }
  return arxivId.toLowerCase();
}

function getPaperIdentity(typeOrPaper, identifier) {
  if (typeOrPaper && typeof typeOrPaper === 'object') {
    const doi = normalizeDoi(typeOrPaper.doi || typeOrPaper.externalIds?.DOI);
    if (doi) return `doi:${doi}`;

    const arxivId = normalizeArxivId(typeOrPaper.arxivId || typeOrPaper.externalIds?.ArXiv);
    if (arxivId) return `arxiv:${arxivId}`;

    return getPaperIdentity(typeOrPaper.id || typeOrPaper.paperId, undefined);
  }

  if (identifier !== undefined) {
    const type = cleanText(typeOrPaper).toLowerCase();
    if (type === 'doi') {
      const doi = normalizeDoi(identifier);
      return doi ? `doi:${doi}` : '';
    }
    if (type === 'arxiv' || type === 'arxivid') {
      const arxivId = normalizeArxivId(identifier);
      return arxivId ? `arxiv:${arxivId}` : '';
    }
    return '';
  }

  const value = cleanText(typeOrPaper);
  if (!value) return '';
  if (/^(?:doi:|(?:https?:\/\/)?(?:dx\.)?doi\.org\/|10\.)/i.test(value)) {
    const doi = normalizeDoi(value);
    return doi ? `doi:${doi}` : '';
  }
  if (/^(?:arxiv:|(?:https?:\/\/)?(?:export\.)?arxiv\.org\/|\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)?\/\d{7})/i.test(value)) {
    const arxivId = normalizeArxivId(value);
    return arxivId ? `arxiv:${arxivId}` : '';
  }
  return '';
}

function encodeUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  return String.fromCharCode(...bytes);
}

function decodeUtf8(value) {
  const bytes = Uint8Array.from(value, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Url(value) {
  const binary = encodeUtf8(value);
  const buffer = globalThis.Buffer;
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : buffer
      ? buffer.from(binary, 'binary').toString('base64')
      : '';
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return '';
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    const buffer = globalThis.Buffer;
    const binary = typeof atob === 'function'
      ? atob(padded)
      : buffer
        ? buffer.from(padded, 'base64').toString('binary')
        : '';
    return binary ? decodeUtf8(binary) : '';
  } catch {
    return '';
  }
}

export function encodePaperKey(typeOrPaper, identifier) {
  const identity = getPaperIdentity(typeOrPaper, identifier);
  return identity ? encodeBase64Url(identity) : null;
}

export function decodePaperKey(key) {
  const decoded = decodeBase64Url(cleanText(key));
  if (!decoded) return null;

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex <= 0) return null;
  const type = decoded.slice(0, separatorIndex).toLowerCase();
  const identifier = decoded.slice(separatorIndex + 1);
  const identity = getPaperIdentity(type, identifier);
  return identity === `${type}:${identifier}` ? identity : null;
}

export function parsePaperKey(key) {
  const identity = decodePaperKey(key);
  if (!identity) return null;
  const separatorIndex = identity.indexOf(':');
  return {
    type: identity.slice(0, separatorIndex),
    value: identity.slice(separatorIndex + 1),
  };
}

export function getPaperKey(paper) {
  return encodePaperKey(paper);
}

function resolvePaperKey(typeOrPaper, identifier, options = {}) {
  const suppliedKey = typeOrPaper && typeof typeOrPaper === 'object'
    ? typeOrPaper.paperKey || typeOrPaper.key
    : options.paperKey;
  if (suppliedKey && decodePaperKey(suppliedKey)) return cleanText(suppliedKey);

  if (identifier === undefined && typeof typeOrPaper === 'string' && decodePaperKey(typeOrPaper)) {
    return cleanText(typeOrPaper);
  }
  return encodePaperKey(typeOrPaper, identifier);
}

function resolvePaperArguments(typeOrPaper, identifier, options) {
  if (
    typeOrPaper
    && typeof typeOrPaper === 'object'
    && identifier
    && typeof identifier === 'object'
    && !Array.isArray(identifier)
  ) {
    return { identifier: undefined, options: identifier };
  }
  return { identifier, options };
}

export function getPublicPaperPath(typeOrPaper, identifier, options = {}) {
  const input = resolvePaperArguments(typeOrPaper, identifier, options);
  const key = resolvePaperKey(typeOrPaper, input.identifier, input.options);
  return key ? `${PUBLIC_ROUTE_PREFIX}/paper/${encodePathSegment(key)}` : null;
}

export function getPublicPaperUrl(typeOrPaper, identifier, options = {}) {
  const input = resolvePaperArguments(typeOrPaper, identifier, options);
  const path = getPublicPaperPath(typeOrPaper, input.identifier, input.options);
  return path ? getAbsoluteShareUrl(path, input.options) : null;
}

/**
 * A profile lives at /public/user/{handle}. The handle is normalized and
 * validated here so a link can never point at a handle the reservation rules
 * would have refused — including a reserved one that would shadow a route.
 */
export function getPublicProfilePath(handleOrProfile) {
  const raw = handleOrProfile && typeof handleOrProfile === 'object'
    ? handleOrProfile.handle
    : handleOrProfile;
  const handle = normalizeHandle(cleanText(raw));
  if (!handle || !isValidHandle(handle)) return null;
  return `${PUBLIC_ROUTE_PREFIX}/user/${encodePathSegment(handle)}`;
}

export function getPublicProfileUrl(handleOrProfile, options = {}) {
  const path = getPublicProfilePath(handleOrProfile);
  return path ? getAbsoluteShareUrl(path, options) : null;
}

export function getSharedListPath(listOrId) {
  const listId = listOrId && typeof listOrId === 'object'
    ? listOrId.shareId || listOrId.id || listOrId.token
    : listOrId;
  const identifier = cleanText(listId);
  if (!identifier) return null;
  return `${PUBLIC_ROUTE_PREFIX}/list/${encodePathSegment(identifier)}`;
}

export function getSharedListUrl(listOrId, options = {}) {
  const path = getSharedListPath(listOrId, options);
  return path ? getAbsoluteShareUrl(path, options) : null;
}

export const getPublicListPath = getSharedListPath;
export const getPublicListUrl = getSharedListUrl;
export const getEntityShareUrl = getPublicEntityUrl;
export const getPaperShareUrl = getPublicPaperUrl;
export const getListShareUrl = getSharedListUrl;
