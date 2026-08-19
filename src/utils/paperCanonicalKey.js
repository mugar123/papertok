/**
 * The canonical identity of a paper, for the stub collection (F3).
 *
 * Two users reach the same paper through different providers — arXiv, DOI,
 * OpenAlex — and their comments must land on the same document. This module is
 * the single place that decides what "the same paper" means:
 *
 *   1. `doi:` + the DOI, lowercased, prefix and resolver stripped
 *   2. `arxiv:` + the arXiv id, lowercased, WITHOUT its version suffix
 *   3. the raw `paper.id` as the providers minted it (`pmid:…`, `ads:…`)
 *
 * DOI outranks arXiv because enrichment usually adds the DOI to an arXiv
 * object, so both routes converge on the DOI key. The version is stripped
 * because a comment belongs to the paper, not to v2 of its PDF.
 *
 * This is deliberately NOT `encodePaperKey` from `publicNavigation.js`. That
 * one addresses share URLs: it keeps the arXiv version (a shared link points
 * at what the sharer saw) and has no raw-id fallback (a URL nobody can load is
 * worse than no URL). Different contracts, so the two stay separate on
 * purpose; unifying them would force one meaning of identity onto both.
 *
 * The document id is base64url(identity): valid as a Firestore id (DOIs carry
 * `/`, which would nest paths — the exact bug family that bit `interactions`),
 * reversible, and the same alphabet the public paper URLs already use.
 *
 * Pure module: no imports, no environment. The exhaustive tests are the gate
 * for this phase — the key is the hardest decision to walk back.
 */

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;
const ARXIV_PATTERN = /^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)?\/\d{7})(?:v\d+)?$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Longest identity the stub rules accept; DOIs in the wild stay under 300. */
export const CANONICAL_IDENTITY_MAX_LENGTH = 600;

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  const hasControlCharacter = [...text].some(character => {
    const codePoint = character.charCodeAt(0);
    return codePoint < 32 || codePoint === 127;
  });
  return hasControlCharacter ? '' : text;
}

function normalizeDoi(value) {
  const doi = cleanText(value)
    .replace(/^doi:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '');
  if (!DOI_PATTERN.test(doi)) return '';
  return doi.toLowerCase();
}

/** Lowercased and versionless: `2401.12345v3` and `2401.12345` are one paper. */
function normalizeArxivId(value) {
  const arxivId = cleanText(value)
    .replace(/^arxiv:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  if (!ARXIV_PATTERN.test(arxivId)) return '';
  return arxivId.toLowerCase().replace(/v\d+$/, '');
}

function rawIdentity(value) {
  const id = cleanText(value);
  if (!id || id.length > CANONICAL_IDENTITY_MAX_LENGTH) return '';
  // A raw id that is really a DOI or an arXiv id in disguise must still fold
  // into the canonical form, or `doi:10.1/x` and a bare `10.1/x` would open
  // two threads for one paper.
  const doi = normalizeDoi(id);
  if (doi) return `doi:${doi}`;
  const arxivId = normalizeArxivId(id);
  if (arxivId) return `arxiv:${arxivId}`;
  // An id that CLAIMS one of the canonical prefixes but failed its grammar is
  // refused outright: passed through raw it would wear a `doi:` identity the
  // rules (rightly) refuse to pair with a missing doi field, a permanent dead
  // end. Same for a bare URL, which is a location, not an identity.
  if (/^(?:doi:|arxiv:|10\.)/i.test(id)) return '';
  if (/^(?:https?:)?\/\//i.test(id)) return '';
  return id;
}

function doiOf(paper) {
  return normalizeDoi(paper?.doi || paper?.externalIds?.DOI);
}

function arxivIdOf(paper) {
  return normalizeArxivId(paper?.arxivId || paper?.externalIds?.ArXiv);
}

/**
 * The identifiers in canonical spelling, for storing alongside the key: the
 * rules require the stub's `doi`/`arxivId` fields to agree with its
 * `canonicalKey`, so both must come from the same normalizer.
 */
export function canonicalDoiOf(paper) {
  return (paper && typeof paper === 'object' ? doiOf(paper) : normalizeDoi(paper)) || null;
}

export function canonicalArxivIdOf(paper) {
  return (paper && typeof paper === 'object' ? arxivIdOf(paper) : normalizeArxivId(paper)) || null;
}

/**
 * The canonical identity string, or null when the object identifies nothing.
 * Accepts a paper object or a bare identifier string.
 */
export function canonicalPaperIdentity(paper) {
  if (paper && typeof paper === 'object') {
    const doi = doiOf(paper);
    if (doi) return `doi:${doi}`;
    const arxivId = arxivIdOf(paper);
    if (arxivId) return `arxiv:${arxivId}`;
    return rawIdentity(paper.id || paper.paperId) || null;
  }
  return rawIdentity(paper) || null;
}

/**
 * Every identity this paper object could have arrived under, most canonical
 * first. When an object carries both a DOI and an arXiv id, a user whose copy
 * lacked the DOI may have opened a thread under the arXiv key — the reader
 * checks the alternates so those comments are not invisible (the split-brain
 * mitigation in 00-ARCHITECTURE.md).
 */
export function candidateStubIdentities(paper) {
  const primary = canonicalPaperIdentity(paper);
  if (!primary) return [];
  const identities = [primary];
  if (paper && typeof paper === 'object') {
    const arxivId = arxivIdOf(paper);
    if (arxivId && primary !== `arxiv:${arxivId}`) identities.push(`arxiv:${arxivId}`);
  }
  return identities;
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
  if (!BASE64URL_PATTERN.test(value)) return '';
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

/** The Firestore document id for an identity already in canonical form. */
export function keyFromIdentity(identity) {
  const value = cleanText(identity);
  if (!value || value.length > CANONICAL_IDENTITY_MAX_LENGTH) return null;
  return encodeBase64Url(value);
}

/** The stub document id for a paper, or null when it identifies nothing. */
export function canonicalPaperKey(paper) {
  const identity = canonicalPaperIdentity(paper);
  return identity ? keyFromIdentity(identity) : null;
}

/**
 * The identity a key encodes, or null for a key that decodes to something the
 * encoder would never have produced — round-tripping is the integrity check.
 */
export function decodeCanonicalPaperKey(key) {
  const decoded = decodeBase64Url(cleanText(key));
  if (!decoded) return null;
  const identity = decoded.startsWith('doi:') || decoded.startsWith('arxiv:')
    ? canonicalPaperIdentity(decoded)
    : rawIdentity(decoded) || null;
  return identity === decoded ? identity : null;
}
