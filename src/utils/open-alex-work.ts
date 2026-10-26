import type { Paper } from '../models/paper.ts';
import type { OpenAlexWork } from '../services/adapters/open-alex-types.ts';

import { usableOpenAlexAbstract } from './open-alex-abstract.ts';
import { usableOpenAlexConcepts } from './open-alex-concepts.ts';
import { normalizePmid } from './public-navigation.ts';
import { openAlexIsWorkingPaper, openAlexPeerReviewed, openAlexPublicationStatus } from './publication-status.ts';

// An OpenAlex work as the app's papers: a whole card (`mapOpenAlexWork`) or the
// fields it adds to a card from another source (`mapOpenAlexEnrichmentWork`).
// Free of browser modules, so the Worker's paper store maps works the same way.

// The top-level fields `mapOpenAlexWork` and `getArxivIdFromWork` read, and
// the only ones a search asks for (`select=`). A works page used to arrive
// whole: 455 KB uncompressed, 65–82 KB on the wire, most of it fields nothing
// here reads (`referenced_works`, `keywords`, `counts_by_year`, the second
// half of `authorships`). Measured 2026-09-16 with this list: 326 KB and
// 45–49 KB. The Worker relays `select` untouched (OPENALEX_PARAMS). Nested
// selection is not something OpenAlex offers, so `authorships` and
// `locations` still travel whole. open-alex-adapter.test.ts holds the guard:
// a work stripped to these fields must map to the same paper as the full one.
export const OPENALEX_WORK_SEARCH_FIELDS = Object.freeze([
  'id',
  'doi',
  'ids',
  'title',
  'type',
  'publication_date',
  'publication_year',
  'authorships',
  'abstract_inverted_index',
  'primary_location',
  'locations',
  'open_access',
  'cited_by_count',
  'concepts',
  'topics',
  'primary_topic',
]);


// The fields an enrichment of another source's card asks for.
export const OPENALEX_ENRICHMENT_SELECT = [
  'id',
  'doi',
  'ids',
  'concepts',
  'topics',
  'primary_topic',
  'cited_by_count',
  'related_works',
  'locations',
  'primary_location',
  'type',
  'open_access',
  // The ids that decide which door a card's author link opens: with one, the
  // explorer asks for the profile once; without, it has to find the author
  // again from the name. Measured 2026-09-07, that is 433 ms against 2462 ms.
  // Subfield selection is refused (`authorships.author.id` answers 400), so
  // this costs the whole authorships array: ~5.7 KB a work.
  'authorships',
  // OpenAlex charges per call, not per field, so this rides along on a request
  // the feed already makes. It costs ~2.6 KB per paper and buys a readable card
  // for the sources that arrive without one -- half of NASA's records, a tenth
  // of Europe PMC's -- which also unlocks the AI explanation, gated on having a
  // usable abstract.
  'abstract_inverted_index',
].join(',');

export type OpenAlexEnrichment = Partial<Paper> & { related_works?: string[] };

/**
 * How many of a work's authorships travel into the enrichment. The select has
 * to ask for the whole array (OpenAlex refuses a subfield), but nothing after
 * it needs more than the authors a card can show: the graft (PaperBuilder)
 * matches against names the paper already has. Unbounded, a 2,000-author
 * collaboration paper mapped to ~150K chars of `authors` — over the persistent
 * store's per-entry cap — so it was never cached across sessions.
 */
export const MAX_ENRICHMENT_AUTHORS = 50;

function normalizeDoi(value: unknown) {
  return String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
}

// The DOI as a path id the Worker relay accepts (`openAlexTargetUrl` in
// worker/openalex-api.ts): letters, digits and `._:%|,-/`, at most 240
// characters, nothing that decodes to `..`. `encodeURIComponent` leaves
// `!'()*~` as they are, and SICI DOIs carry parentheses; the slash after the
// DOI prefix stays a slash. A `.` or `..` segment would not reach the relay as
// sent: the URL parser resolves it first, into another path. A DOI the relay
// would refuse, or the parser rewrite, has no path id ('').
export function doiPathId(doi: string) {
  const id = `doi:${encodeURIComponent(doi)
    .replace(/[!'()*~]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/gi, '/')}`;
  return id.length <= 240 && !doi.includes('..') && !doi.split('/').includes('.') ? id : '';
}

function extractArxivId(value: unknown) {
  const text = String(value || '');
  const match = text.match(/(?:arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.|arxiv:)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i);
  return match?.[1] || '';
}

/**
 * The arXiv id an OpenAlex work is hosted under, if any.
 *
 * OpenAlex indexes the preprint and the published version as one work, and the
 * arXiv id is never a field of its own: it has to be read out of whichever of
 * the identifiers happens to carry it. Exported because the feed and the search
 * want it too — a card without this id can never show the paper's figure.
 */
export function getArxivIdFromWork(work: OpenAlexWork | null | undefined) {
  const direct = extractArxivId(work?.ids?.arxiv);
  if (direct) return direct;

  const candidates = [work?.doi, work?.ids?.doi];
  for (const location of work?.locations || []) {
    candidates.push(location?.landing_page_url, location?.pdf_url, location?.id);
  }
  return candidates.map(extractArxivId).find(Boolean) || '';
}

function getReliableEnrichmentDoi(work: OpenAlexWork, arxivId: string) {
  const doi = normalizeDoi(work?.doi || work?.ids?.doi);
  if (!doi) return undefined;

  const canonicalArxivId = extractArxivId(doi);
  if (canonicalArxivId) return canonicalArxivId === arxivId ? doi : undefined;

  const hasPublishedLocation = (work?.locations || []).some(location => location?.is_published && location?.source);
  return work?.type !== 'preprint' || hasPublishedLocation ? doi : undefined;
}

export function mapOpenAlexEnrichmentWork(work: OpenAlexWork | null): { openAlexId: string; arxivId: string; enrichment: OpenAlexEnrichment } | null {
  if (!work || typeof work !== 'object') return null;
  const openAlexUrl = work.id || work.ids?.openalex || '';
  const openAlexId = String(openAlexUrl).split('/').pop();
  const arxivId = getArxivIdFromWork(work);
  if (!openAlexId) return null;
  const semanticTopics = usableOpenAlexConcepts(Array.isArray(work.concepts) && work.concepts.length > 0
    ? work.concepts
    : (work.topics || []));

  // Absent rather than empty when the work has no authorships: `merge` fills a
  // gap with this list, and an empty one would erase the authors a card is
  // already showing.
  const authorships = Array.isArray(work.authorships) ? work.authorships.slice(0, MAX_ENRICHMENT_AUTHORS) : [];
  const authors = authorships.length > 0
    ? authorships.map(authorship => ({
      name: authorship?.author?.display_name || 'Unknown',
      id: authorship?.author?.id || null,
    }))
    : undefined;

  return {
    openAlexId,
    arxivId,
    enrichment: {
      ...(authors ? { authors } : {}),
      abstract: usableOpenAlexAbstract(work),
      concepts: semanticTopics,
      topics: work.topics || [],
      primaryTopic: work.primary_topic || null,
      citationCount: Number.isFinite(work.cited_by_count) ? work.cited_by_count! : 0,
      citationCountKnown: Number.isFinite(work.cited_by_count),
      related_works: work.related_works || [],
      publicationType: work.type || work.primary_location?.source?.type || 'preprint',
      publicationStatus: openAlexPublicationStatus(work),
      peerReviewed: openAlexPeerReviewed(work),
      workingPaper: openAlexIsWorkingPaper(work) || undefined,
      doi: arxivId
        ? getReliableEnrichmentDoi(work, arxivId)
        : (normalizeDoi(work.doi || work.ids?.doi) || undefined),
      pmid: normalizePmid(work.ids?.pmid) || undefined,
      journal: work.primary_location?.source?.display_name,
      publisher: work.primary_location?.source?.host_organization_name,
      openAccess: work.open_access?.is_oa,
      pdfUrl: work.open_access?.oa_url,
      landingPageUrl: work.primary_location?.landing_page_url,
    },
  };
}

/** A work as a card of its own, the shape the OpenAlex search and topic lanes show. */
export function mapOpenAlexWork(work: OpenAlexWork | null | undefined, provider = 'openalex_search'): Paper | null {
  if (!work || !work.id) return null;

  const doi = work.doi ? work.doi.replace('https://doi.org/', '') : null;
  const authors = (work.authorships || []).map(a => ({
    name: a.author?.display_name || 'Unknown',
    id: a.author?.id,
    affiliation: a.institutions?.[0]?.display_name || null
  }));
  const institutions = [...new Map((work.authorships || [])
    .flatMap(authorship => authorship.institutions || [])
    .filter(Boolean)
    .map(institution => [institution.id || institution.ror || institution.display_name, {
      id: institution.id,
      ror: institution.ror,
      displayName: institution.display_name,
    }])).values()];

  const abstract = usableOpenAlexAbstract(work) || 'No abstract available.';

  const isOpenAccess = work.open_access?.is_oa || false;
  const pdfUrl = work.open_access?.oa_url || null;
  const landingPageUrl = work.primary_location?.landing_page_url || work.doi || null;

  const sourceName = work.primary_location?.source?.display_name || 'Unknown Journal';

  const semanticEntries = work.concepts?.length ? work.concepts : (work.topics || []);
  const conceptObjects = usableOpenAlexConcepts(semanticEntries);
  const concepts = conceptObjects.map(concept => concept.display_name);
  const publicationType = work.type || work.primary_location?.source?.type || 'article';
  const publicationStatus = openAlexPublicationStatus(work);

  return {
    id: work.id.replace('https://openalex.org/', 'openalex:'),
    sources: { primary: 'openalex', enrichedBy: [] },
    doi,
    arxivId: getArxivIdFromWork(work) || undefined,
    pmid: normalizePmid(work.ids?.pmid) || undefined,
    title: work.title || 'Untitled',
    abstract,
    authors,
    institutions,
    publishedDate: work.publication_date,
    year: work.publication_year,
    sourceName,
    sourceType: work.type === 'conference-paper' || work.type === 'proceedings-article' ? 'conference' : 'journal',
    publicationType,
    publicationStatus,
    peerReviewed: openAlexPeerReviewed(work),
    workingPaper: openAlexIsWorkingPaper(work) || undefined,
    openAccess: isOpenAccess,
    pdfUrl,
    landingPageUrl,
    citationsCount: work.cited_by_count || 0,
    citationCountKnown: Number.isFinite(work.cited_by_count),
    concepts: conceptObjects,
    topics: work.topics || [],
    primaryTopic: work.primary_topic || null,
    provider,
    categories: concepts,
    keywords: concepts,
    raw: work
  };
}
