import { canonicalArxivIdOf, canonicalDoiOf } from './paperCanonicalKey.js';

/**
 * A reader's marks — the like, the read mark, the list a paper sits in —
 * live under the id the feed gave the paper the day they made them:
 * `openalex:W…` from the OpenAlex source, `arxiv:…` from arXiv, a hash from
 * Semantic Scholar, a bare `W…` from a DOI lookup. The same paper reaches
 * the reader again under another of those ids — a shared link hydrated by
 * DOI, the feed served from another source the next day — and the mark
 * does not apply: the paper they read yesterday comes up unread.
 *
 * The stored copies the library already loads carry the paper's DOI and
 * arXiv id beside the id the mark lives under. That is the alias table:
 * every identity a copy answers to, mapped to its interaction id.
 */

const OPENALEX_ID = /^(?:openalex:|https?:\/\/openalex\.org\/)?(W\d+)$/i;
const PUBMED_ID = /^pmid:(\d+)$/i;

/** One shape for the provider ids that arrive in several: `openalex:W…`, `pmid:…`. */
export function normalizedProviderId(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const openAlex = value.match(OPENALEX_ID);
  if (openAlex) return `openalex:${openAlex[1].toUpperCase()}`;
  const pubmed = value.match(PUBMED_ID);
  if (pubmed) return `pmid:${pubmed[1]}`;
  return value;
}

/**
 * Every identity a paper object answers to: its own id in normalized form,
 * `doi:` + its DOI, `arxiv:` + its arXiv id. An id that is itself a DOI or
 * an arXiv id (older copies were keyed that way) yields both forms.
 */
export function paperIdentities(paper) {
  if (!paper || typeof paper !== 'object') return [];
  const identities = new Set();
  const own = normalizedProviderId(paper.id);
  if (own) identities.add(own);
  const doi = canonicalDoiOf(paper) || canonicalDoiOf({ doi: paper.id });
  if (doi) identities.add(`doi:${doi}`);
  const arxivId = canonicalArxivIdOf(paper) || canonicalArxivIdOf({ arxivId: paper.id });
  if (arxivId) identities.add(`arxiv:${arxivId}`);
  return [...identities];
}

/**
 * The alias table from `[interactionId, storedCopy]` pairs. The first copy
 * to claim an identity keeps it, and an interaction id always maps to itself.
 */
export function buildInteractionAliasIndex(entries) {
  const index = new Map();
  for (const [id, copy] of entries || []) {
    if (!id) continue;
    const own = normalizedProviderId(id);
    if (own && !index.has(own)) index.set(own, id);
    const source = copy && typeof copy === 'object' ? { ...copy, id: copy.id || id } : { id };
    for (const identity of paperIdentities(source)) {
      if (!index.has(identity)) index.set(identity, id);
    }
  }
  return index;
}

/**
 * The id this reader's marks for the paper live under: the paper's own id
 * when a mark is already known under it, otherwise the interaction id any of
 * its identities is an alias of, otherwise the paper's own id — a paper the
 * reader has never touched keeps the id it arrived with.
 */
export function resolveInteractionId(paper, index, isKnown = () => false) {
  const raw = paper?.id;
  if (!raw) return raw;
  if (isKnown(raw)) return raw;
  for (const identity of paperIdentities(paper)) {
    const hit = index?.get(identity);
    if (hit) return hit;
  }
  return raw;
}
