import type { Paper, PaperAuthor } from '../../models/Paper.ts';
import type { PaperSearchFilters, PaperSearchResult } from './index.ts';

type ScopusLink = { '@ref'?: string; '@rel'?: string; '@href'?: string; href?: string };
type ScopusAuthor = { authname?: string; 'ce:indexed-name'?: string; 'given-name'?: string; surname?: string; name?: string; authid?: string };
type ScopusTextKey = 'dc:title' | 'dc:description' | 'dc:identifier' | 'dc:creator' | 'prism:doi' | 'prism:url' | 'prism:coverDate' | 'prism:teaser' | 'prism:publicationName' | 'prism:aggregationType' | 'subtypeDescription';
export type ScopusEntry = Partial<Record<ScopusTextKey, string>> & {
  eid?: string;
  link?: ScopusLink | ScopusLink[];
  author?: ScopusAuthor[];
  authors?: { author?: ScopusAuthor[] };
  'citedby-count'?: string | number;
  openaccess?: string | number;
  openaccessFlag?: string | boolean;
};

import { PaperBuilder } from '../PaperBuilder.ts';
import { authenticatedWorkerFetch, hasWorkerSession } from '../workerApiClient.ts';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const SCOPUS_ENABLED = import.meta.env?.VITE_SCOPUS_ENABLED === 'true';
const REQUEST_TIMEOUT_MS = 12_000;

// The Worker route is credential-backed and rejects anonymous callers, so
// `authenticatedWorkerFetch` throws before any request leaves the browser when
// there is no session. Reporting Scopus as unavailable keeps callers from
// queueing a call that cannot succeed.
export function isScopusEnabled() {
  return SCOPUS_ENABLED && Boolean(PAPER_API_BASE) && hasWorkerSession();
}

function normalizeText(value: unknown) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDoi(value: unknown) {
  return String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
}

function safeUrl(value: string | undefined) {
  try {
    const url = new URL(value as string);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function extractTerms(query: unknown) {
  const quoted = [...String(query || '').matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const candidates = quoted.length > 0 ? quoted : String(query || '').split(/\s+OR\s+/i);
  return [...new Set(candidates.map(normalizeText).filter(Boolean))].slice(0, 4);
}

function authorName(author: ScopusAuthor | null | undefined) {
  return normalizeText(
    author?.authname
      || author?.['ce:indexed-name']
      || [author?.['given-name'], author?.surname].filter(Boolean).join(' ')
      || author?.name,
  );
}

function linksByRelation(raw: ScopusEntry) {
  return (Array.isArray(raw?.link) ? raw.link : raw?.link ? [raw.link] : []).reduce<Record<string, string>>((links, item) => {
    const relation = item?.['@ref'] || item?.['@rel'];
    const href = safeUrl(item?.['@href'] || item?.href);
    if (relation && href) links[relation] = href;
    return links;
  }, {});
}

export class ScopusAdapter {
  declare name: string;
  constructor() {
    this.name = 'scopus';
  }

  async search(query: string, page = 1, filters: PaperSearchFilters = {}): Promise<PaperSearchResult> {
    if (!PAPER_API_BASE) return { papers: [], total: 0, unavailable: true };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`${PAPER_API_BASE}/sources/scopus`);
      url.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
      url.searchParams.set('limit', String(Math.max(1, Math.min(10, Number(filters.limit) || 8))));
      url.searchParams.set('sort', filters.sort === 'recent' ? 'recent' : 'relevance');
      if (filters.type === 'author') {
        url.searchParams.set('author', normalizeText(query).replace(/^"|"$/g, ''));
      } else {
        const terms = filters.terms?.length ? filters.terms : extractTerms(query);
        url.searchParams.set('terms', terms.join('|'));
      }

      const response = await authenticatedWorkerFetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      // A Worker without an Elsevier key is a configuration state, not a
      // failure: the caller drops the source instead of logging an error.
      if (response.status === 503) return { papers: [], total: 0, unavailable: true };
      if (!response.ok) {
        const error = new Error(`Scopus source returned ${response.status}`) as Error & { status: number };
        error.status = response.status;
        throw error;
      }
      const data = await response.json() as { 'search-results'?: { entry?: ScopusEntry[]; 'opensearch:totalResults'?: string }; _papertok?: { quota?: unknown } };
      const searchResults = data?.['search-results'] || {};
      const entries = Array.isArray(searchResults.entry) ? searchResults.entry : [];
      return {
        papers: entries.map(entry => this.mapToStandard(entry, filters.internalCategories)).filter(Boolean) as Paper[],
        total: Math.max(0, Number(searchResults['opensearch:totalResults']) || 0),
        quota: data?._papertok?.quota || null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  mapToStandard(raw: ScopusEntry, requestedCategories: string[] = []): Paper | null {
    if (!raw?.['dc:title']) return null;
    const links = linksByRelation(raw);
    const scopusId = String(raw.eid || raw['dc:identifier'] || '').replace(/^SCOPUS_ID:/i, '');
    const doi = normalizeDoi(raw['prism:doi']);
    const rawAuthors = Array.isArray(raw.author)
      ? raw.author
      : Array.isArray(raw.authors?.author)
        ? raw.authors.author
        : [];
    const authors: PaperAuthor[] = rawAuthors.map(author => ({ name: authorName(author), id: author?.authid || undefined })).filter(author => author.name);
    if (authors.length === 0 && raw['dc:creator']) authors.push({ name: normalizeText(raw['dc:creator']) });

    const published = raw['prism:coverDate'] || '';
    const year = Number(String(published).slice(0, 4)) || new Date().getFullYear();
    const citedByUrl = links['scopus-citedby'] || '';
    const rawCitationCount = Number(raw['citedby-count']);
    const hasAttributedCitations = Number.isFinite(rawCitationCount) && Boolean(citedByUrl);
    const openAccess = String(raw.openaccess || '') === '1' || String(raw.openaccessFlag || '').toLowerCase() === 'true';

    // Every other source mapper hands the builder its data; doing the same here
    // normalizes the citation field, applies the shared defaults, and leaves the
    // full Scopus record behind instead of carrying it through the feed.
    return PaperBuilder.create({
      id: scopusId ? `scopus:${scopusId}` : doi ? `scopus:doi:${doi}` : `scopus:title:${normalizeText(raw['dc:title']).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 100)}`,
      sources: { primary: 'scopus', enrichedBy: [] },
      scopusId: scopusId || undefined,
      scopusUrl: links.scopus || safeUrl(raw['prism:url']) || undefined,
      scopusCitedByUrl: citedByUrl || undefined,
      scopusCitationCount: hasAttributedCitations ? rawCitationCount : undefined,
      doi: doi || undefined,
      title: normalizeText(raw['dc:title']),
      abstract: normalizeText(raw['dc:description'] || raw['prism:teaser']),
      authors,
      published,
      year,
      journal: normalizeText(raw['prism:publicationName']),
      sourceType: /conference/i.test(raw.subtypeDescription || raw['prism:aggregationType'] || '') ? 'conference' : 'journal',
      publicationType: normalizeText(raw.subtypeDescription) || 'article',
      publicationStatus: 'published',
      openAccess,
      landingPageUrl: links.scopus || (doi ? `https://doi.org/${doi}` : safeUrl(raw['prism:url'])),
      citationCount: hasAttributedCitations ? rawCitationCount : 0,
      citationCountKnown: hasAttributedCitations,
      // The search view names no subject area, so the card has no category;
      // the request is only why it was fetched.
      _fetchedFor: requestedCategories,
      provider: this.name,
    });
  }
}
