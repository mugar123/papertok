import type { Paper } from '../models/paper.ts';
export interface ShareOptions { origin?: string; base?: string; includeName?: boolean; name?: string | null; paperKey?: string; }
interface EntityInput { type?: string; id?: string; canonicalId?: string; code?: string; externalId?: string; displayName?: string; }
type PaperInput = string | (Partial<Pick<Paper, 'id' | 'doi' | 'arxivId' | 'pmid'>> & { paperId?: string; paperKey?: string; key?: string; externalIds?: { DOI?: string | null; ArXiv?: string | null } }) | null | undefined;
type ListInput = string | { shareId?: string; id?: string; token?: string } | null | undefined;

import { encodeBase64Url, decodeBase64Url } from './base64-url.ts';

const VITE_BASE_URL = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL || '/';

export const DEFAULT_PUBLIC_ORIGIN = 'https://papertok.app';
// The preview image a shared link shows, with alt text that reads what it
// says. Each kind of public page has its own; everything else has the site's.
// A changed image takes a new file name, since link previews are cached by URL.
export interface ShareImage { path: string; alt: string; }
export const DEFAULT_SHARE_IMAGE: ShareImage = {
  path: '/og/papertok-share-0.3.png',
  alt: 'PaperTok: Scientific papers, in one feed. Like TikTok, but you come out smarter. Etchings of a microscope, a magnifying glass, test tubes and old scrolls.',
};
const TOPIC_SHARE_IMAGE: ShareImage = {
  path: '/og/papertok-share-topic-0.3.png',
  alt: 'PaperTok, research topic: One research topic, in one feed. Follow it to see new papers as they come out. Etching of test tubes and a magnifying glass.',
};
const SHARE_IMAGES: Readonly<Record<string, ShareImage>> = Object.freeze({
  author: {
    path: '/og/papertok-share-author-0.3.png',
    alt: 'PaperTok, author: A researcher’s papers, in one feed. Follow them to see new work as it comes out. Etching of a microscope.',
  },
  institution: {
    path: '/og/papertok-share-institution-0.3.png',
    alt: 'PaperTok, institution: A whole institution, in one feed. Follow it to see its new papers as they come out. Etchings of old scrolls, test tubes and a magnifying glass.',
  },
  project: {
    path: '/og/papertok-share-project-0.3.png',
    alt: 'PaperTok, research project: A research project, in one feed. The papers a grant or project produced, together. Etchings of a microscope, test tubes and a magnifying glass.',
  },
  source: {
    path: '/og/papertok-share-source-0.3.png',
    alt: 'PaperTok, scientific journal: A journal’s papers, in one feed. Browse what it publishes, most cited first. Etching of old scrolls.',
  },
  topic: TOPIC_SHARE_IMAGE,
  concept: TOPIC_SHARE_IMAGE,
  list: {
    path: '/og/papertok-share-list-0.3.png',
    alt: 'PaperTok, reading list: A reading list, shared with you. Papers someone picked, ready to read on PaperTok. Etchings of old scrolls and a microscope.',
  },
});

/** The preview for an entity type or `list`; the site's own for anything else. */
export function getShareImage(kind: string): ShareImage {
  return Object.hasOwn(SHARE_IMAGES, kind) ? SHARE_IMAGES[kind] : DEFAULT_SHARE_IMAGE;
}
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

function cleanText(value: unknown) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  const hasControlCharacter = [...text].some(character => {
    const codePoint = character.charCodeAt(0);
    return codePoint < 32 || codePoint === 127;
  });
  return hasControlCharacter ? '' : text;
}

function encodePathSegment(value: string|number|boolean) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function normalizeRouterPath(path: string) {
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
  // The Worker imports this module too, and its global scope may have no location.
  const { location } = globalThis as { location?: { origin?: string } };
  return location?.origin || DEFAULT_PUBLIC_ORIGIN;
}

function normalizeOrigin(origin: string) {
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

/**
 * The absolute address of an in-app path, for a share sheet, a clipboard, an
 * `og:url` or an email.
 *
 * This used to mint `https://papertok.app/#/public/paper/<key>`, because the
 * fragment WAS the route: the app was a HashRouter, `/` was the only path the
 * server knew, and everything after the `#` never left the browser. Neither
 * half holds any more — `src/main.tsx` mounts a BrowserRouter, and vercel.json
 * rewrites every non-file path to the app — so the route goes where a route
 * goes. A `#/…` link still reaches the same page (index.html's gate forwards
 * it and `utils/legacy-hash-route.ts` translates it), but it pays a hop through
 * the marketing page to get there, and it is not what this app should be
 * minting for anyone from here on.
 *
 * `rootUrl` always ends in a slash (`getViteBasePath`) and the normalized route
 * always starts with one, so exactly one of the two is dropped — which is also
 * what keeps a project-path deployment (`base: '/papertok/'`) building
 * `/papertok/public/...` rather than a path off its own root.
 */
export function getAbsoluteShareUrl(path: string, options = {}) {
  const value = cleanText(path);
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).href;
    } catch {
      return null;
    }
  }

  const rootUrl = getSiteRootUrl(options);
  return `${rootUrl}${normalizeRouterPath(value).slice(1)}`;
}

function normalizeEntityType(type: unknown) {
  const normalized = cleanText(type).toLowerCase();
  return PUBLIC_ENTITY_TYPE_SET.has(normalized) ? normalized : '';
}

function resolveEntityInput(typeOrEntity: EntityInput | string | undefined, id: string | ShareOptions | undefined, options: ShareOptions) {
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

export function getPublicEntityPath(typeOrEntity: EntityInput | string | undefined, id?: string | ShareOptions, options: ShareOptions = {}) {
  const input = resolveEntityInput(typeOrEntity, id, options);
  const type = normalizeEntityType(input.type);
  const identifier = cleanText(input.id);
  if (!type || !identifier) return null;

  const path = `${PUBLIC_ROUTE_PREFIX}/entity/${encodePathSegment(type)}/${encodePathSegment(identifier)}`;
  const includeName = input.options?.includeName === true;
  const name = cleanText(input.options?.name || (typeOrEntity as EntityInput)?.displayName);
  return includeName && name ? `${path}?name=${encodeURIComponent(name)}` : path;
}

export function getPublicEntityUrl(typeOrEntity: EntityInput | string | undefined, id?: string | ShareOptions, options: ShareOptions = {}) {
  const input = resolveEntityInput(typeOrEntity, id, options);
  const path = getPublicEntityPath(typeOrEntity, id, input.options || options);
  return path ? getAbsoluteShareUrl(path, input.options || options) : null;
}

export function normalizeDoi(value: unknown) {
  const doi = cleanText(value)
    .replace(/^doi:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '');
  if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) return '';
  return doi.toLowerCase();
}

export function normalizeArxivId(value: unknown) {
  const arxivId = cleanText(value)
    .replace(/^arxiv:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  if (!/^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)?\/\d{7})(?:v\d+)?$/i.test(arxivId)) {
    return '';
  }
  return arxivId.toLowerCase();
}

/**
 * An OpenAlex work id (`W2741809807`), with the `openalex:` prefix the feed
 * adapter puts on paper ids and the `https://openalex.org/` form the API
 * returns both stripped. Uppercased, so one work has one key.
 */
function normalizeOpenAlexWorkId(value: unknown) {
  const workId = cleanText(value)
    .replace(/^openalex:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:api\.)?openalex\.org\/(?:works\/)?/i, '');
  if (!/^W\d+$/i.test(workId)) return '';
  return workId.toUpperCase();
}

/**
 * A PubMed id, only when it says so: the `pmid:` prefix the PubMed adapter
 * mints or a pubmed.ncbi.nlm.nih.gov URL. A bare run of digits is not taken
 * for one — too many things are a run of digits.
 */
export function normalizePmid(value: unknown) {
  const text = cleanText(value);
  const match = text.match(/^pmid:\s*(\d+)$/i)
    || text.match(/^(?:https?:\/\/)?(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/(\d+)\/?$/i);
  return match ? match[1] : '';
}

/**
 * The identity a public paper URL carries, in order of preference: DOI, arXiv
 * id, OpenAlex work id, PubMed id. Every one of them is loadable — a URL
 * nobody can open is worse than no URL — which is why a Semantic Scholar hash
 * or a Scopus id still yields nothing here.
 *
 * The last two exist for the papers the feed keys by provider id: an OpenAlex
 * or PubMed paper liked from the feed is remembered under `openalex:W…` or
 * `pmid:…`, and the Liked tab has nothing else to go on for it. Without an
 * identity for those ids, every such row was a label instead of a link.
 */
function getPaperIdentity(typeOrPaper: PaperInput, identifier: unknown): string {
  if (typeOrPaper && typeof typeOrPaper === 'object') {
    const doi = normalizeDoi(typeOrPaper.doi || typeOrPaper.externalIds?.DOI);
    if (doi) return `doi:${doi}`;

    const arxivId = normalizeArxivId(typeOrPaper.arxivId || typeOrPaper.externalIds?.ArXiv);
    if (arxivId) return `arxiv:${arxivId}`;

    const fromId = getPaperIdentity(typeOrPaper.id || typeOrPaper.paperId, undefined);
    if (fromId) return fromId;

    const pmid = normalizePmid(typeOrPaper.pmid ? `pmid:${typeOrPaper.pmid}` : '');
    return pmid ? `pmid:${pmid}` : '';
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
    if (type === 'openalex') {
      const workId = normalizeOpenAlexWorkId(identifier);
      return workId ? `openalex:${workId}` : '';
    }
    if (type === 'pmid') {
      const pmid = normalizePmid(`pmid:${cleanText(identifier)}`);
      return pmid ? `pmid:${pmid}` : '';
    }
    return '';
  }

  const value = cleanText(typeOrPaper);
  if (!value) return '';
  // Provider ids that carry the DOI inside them: bioRxiv (`biorxiv:<encoded
  // doi>:v2`), Crossref (`crossref:<doi>`) and Scopus without an eid
  // (`scopus:doi:<doi>`). A like made from one of those cards was remembered
  // under the provider id alone, and the DOI in it is the paper's address.
  const embeddedDoi = value.match(/^biorxiv:(.+?)(?::v\d+)?$/i)
    || value.match(/^(?:crossref|scopus:doi):(.+)$/i);
  if (embeddedDoi) {
    let candidate = embeddedDoi[1];
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Not percent-encoded; the DOI grammar below decides.
    }
    const doi = normalizeDoi(candidate);
    return doi ? `doi:${doi}` : '';
  }
  if (/^(?:doi:|(?:https?:\/\/)?(?:dx\.)?doi\.org\/|10\.)/i.test(value)) {
    const doi = normalizeDoi(value);
    return doi ? `doi:${doi}` : '';
  }
  if (/^(?:arxiv:|(?:https?:\/\/)?(?:export\.)?arxiv\.org\/|\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)?\/\d{7})/i.test(value)) {
    const arxivId = normalizeArxivId(value);
    return arxivId ? `arxiv:${arxivId}` : '';
  }
  if (/^(?:openalex:|(?:https?:\/\/)?(?:api\.)?openalex\.org\/|W\d+$)/i.test(value)) {
    const workId = normalizeOpenAlexWorkId(value);
    return workId ? `openalex:${workId}` : '';
  }
  if (/^(?:pmid:|(?:https?:\/\/)?(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/)/i.test(value)) {
    const pmid = normalizePmid(value);
    return pmid ? `pmid:${pmid}` : '';
  }
  return '';
}

export function encodePaperKey(typeOrPaper: PaperInput, identifier?: unknown) {
  const identity = getPaperIdentity(typeOrPaper, identifier);
  return identity ? encodeBase64Url(identity) : null;
}

export function decodePaperKey(key: string) {
  const decoded = decodeBase64Url(cleanText(key));
  if (!decoded) return null;

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex <= 0) return null;
  const type = decoded.slice(0, separatorIndex).toLowerCase();
  const identifier = decoded.slice(separatorIndex + 1);
  const identity = getPaperIdentity(type, identifier);
  return identity === `${type}:${identifier}` ? identity : null;
}

export function parsePaperKey(key: string) {
  const identity = decodePaperKey(key);
  if (!identity) return null;
  const separatorIndex = identity.indexOf(':');
  return {
    type: identity.slice(0, separatorIndex),
    value: identity.slice(separatorIndex + 1),
  };
}

export function getPaperKey(paper: PaperInput) {
  return encodePaperKey(paper);
}

function resolvePaperKey(typeOrPaper: PaperInput, identifier: unknown, options: ShareOptions = {}) {
  const suppliedKey = typeOrPaper && typeof typeOrPaper === 'object'
    ? typeOrPaper.paperKey || typeOrPaper.key
    : options.paperKey;
  if (suppliedKey && decodePaperKey(suppliedKey)) return cleanText(suppliedKey);

  if (identifier === undefined && typeof typeOrPaper === 'string' && decodePaperKey(typeOrPaper)) {
    return cleanText(typeOrPaper);
  }
  return encodePaperKey(typeOrPaper, identifier);
}

function resolvePaperArguments(typeOrPaper: PaperInput, identifier: string | ShareOptions | undefined, options: ShareOptions) {
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

/**
 * A paper's page is `/paper/<key>`, outside the `/public` prefix the list and
 * entity pages keep (ENG-44). Links minted as `/public/paper/<key>` before the
 * move are redirected permanently by vercel.json, and through `legacyPaperPath`
 * for the addresses that never reach the server.
 */
export function getPublicPaperPath(typeOrPaper: PaperInput, identifier?: string | ShareOptions, options: ShareOptions = {}) {
  const input = resolvePaperArguments(typeOrPaper, identifier, options);
  const key = resolvePaperKey(typeOrPaper, input.identifier, input.options);
  return key ? `/paper/${encodePathSegment(key)}` : null;
}

/**
 * Where an address from before ENG-44, `/public/paper/<key>`, lives now, or
 * null for any other path. The router decodes each segment before it matches
 * and ignores letter case, so `/Public/PAPER/…` and `/public/p%61per/…` are the
 * old address too; the first two segments are compared the same way, and the key
 * keeps its own spelling. A trailing slash is dropped. The query and fragment are
 * the caller's to carry.
 */
export function legacyPaperPath(pathname: string) {
  const [, root = '', section = '', key = '', ...rest] = pathname.split('/');
  if (!key || rest.some(Boolean)) return null;
  if (decodeSegment(root).toLowerCase() !== 'public' || decodeSegment(section).toLowerCase() !== 'paper') return null;
  return `/paper/${key}`;
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The pages a guest can open without a session. A sign-in from one of their
 * doors (like, save, follow) leaves the new account right there. Letter case
 * is ignored because the router ignores it.
 */
export function isPublicRoutePath(path: string) {
  const lower = path.toLowerCase();
  return ['/public/', '/explorer/', '/paper/'].some(prefix => lower.startsWith(prefix));
}

/**
 * The pages that keep the signed-in navbar: a paper, a shared list and an
 * entity page. Letter case is ignored because the router ignores it.
 */
export function keepsNavbarPath(path: string) {
  const lower = path.toLowerCase();
  return ['/paper/', '/public/list/', '/explorer/'].some(prefix => lower.startsWith(prefix));
}

export function getPublicPaperUrl(typeOrPaper: PaperInput, identifier?: string | ShareOptions, options: ShareOptions = {}) {
  const input = resolvePaperArguments(typeOrPaper, identifier, options);
  const path = getPublicPaperPath(typeOrPaper, input.identifier, input.options);
  return path ? getAbsoluteShareUrl(path, input.options) : null;
}

export function getPublicListPath(listOrId: ListInput, options?: ShareOptions): string | null;
export function getPublicListPath(listOrId: ListInput) {
  const listId = listOrId && typeof listOrId === 'object'
    ? listOrId.shareId || listOrId.id || listOrId.token
    : listOrId;
  const identifier = cleanText(listId);
  if (!identifier) return null;
  return `${PUBLIC_ROUTE_PREFIX}/list/${encodePathSegment(identifier)}`;
}

export function getPublicListUrl(listOrId: ListInput, options: ShareOptions = {}) {
  const path = getPublicListPath(listOrId, options);
  return path ? getAbsoluteShareUrl(path, options) : null;
}
