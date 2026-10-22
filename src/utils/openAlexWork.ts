import type { Paper } from '../models/Paper.ts';
import type { OpenAlexWork } from '../services/adapters/openAlexTypes.ts';

import { usableOpenAlexAbstract } from './openAlexAbstract.ts';
import { usableOpenAlexConcepts } from './openAlexConcepts.ts';
import { normalizePmid } from './publicNavigation.ts';
import { openAlexIsWorkingPaper, openAlexPeerReviewed, openAlexPublicationStatus } from './publicationStatus.ts';

// An OpenAlex work as the app's papers: a whole card (`mapOpenAlexWork`) or the
// fields it adds to a card from another source (`mapOpenAlexEnrichmentWork`).
// Free of browser modules, so the Worker's paper store maps works the same way.

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

export function normalizeDoi(value: unknown) {
  return String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
}

export function extractArxivId(value: unknown) {
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
