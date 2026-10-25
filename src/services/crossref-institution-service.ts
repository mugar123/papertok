import type { Paper, PaperAuthor } from '../models/paper.ts';
import type { OpenAlexAuthor } from './adapters/open-alex-types.ts';
import type { CrossrefLicense } from '../utils/crossref-license.ts';
interface CrossrefWork {
  DOI?: string; title?: string[]; abstract?: string; type?: string;
  published?: { 'date-parts'?: number[][] }; 'published-online'?: { 'date-parts'?: number[][] }; issued?: { 'date-parts'?: number[][] };
  author?: Array<{ given?: string; family?: string; name?: string; ORCID?: string }>;
  'container-title'?: string[]; publisher?: string; URL?: string; 'is-referenced-by-count'?: number;
  license?: CrossrefLicense[];
}
interface CrossrefFilters { peerReviewed?: boolean; dateRange?: string; searchQuery?: string; }

import { openLicenseFromCrossref } from '../utils/crossref-license.ts';

const CROSSREF_WORKS_LIMIT = 30;
const CROSSREF_AUTHORS_WORKS_LIMIT = 100;

// Crossref's abstracts are JATS XML; the text without its tags.
export function stripMarkup(value: unknown) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCrossrefPublishedDate(work: CrossrefWork) {
  const dateParts = work.published?.['date-parts']?.[0]
    || work['published-online']?.['date-parts']?.[0]
    || work.issued?.['date-parts']?.[0]
    || [];
  const [year, month = 1, day = 1] = dateParts;
  if (!year) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * What Crossref's `type` says about how a work reached the record.
 *
 * `peerReviewed` is the canonical field: `PaperBuilder` writes it, the Explorer
 * filter reads it and `paperStatus` decides the chip from it. This fallback
 * builds its papers by hand and never goes through `PaperBuilder`, so nobody
 * else was going to fill the field in for it.
 *
 * `posted-content` is Crossref's preprint type, so a work carrying it is
 * neither published nor reviewed, whatever its DOI looks like.
 */
function publicationFactsForCrossrefType(type: string | undefined): Pick<Paper, 'publicationType' | 'publicationStatus' | 'peerReviewed'> {
  if (type === 'journal-article') {
    return { publicationType: 'journal', publicationStatus: 'published', peerReviewed: true };
  }
  if (type === 'proceedings-article') {
    return { publicationType: 'conference', publicationStatus: 'published', peerReviewed: true };
  }
  if (type === 'posted-content') {
    return { publicationType: 'preprint', publicationStatus: 'preprint', peerReviewed: false };
  }
  return { publicationType: 'publication', publicationStatus: 'published', peerReviewed: false };
}

export function mapCrossrefInstitutionWork(work: CrossrefWork): Paper | null {
  const doi = String(work?.DOI || '').trim().toLowerCase();
  const title = work?.title?.[0] || '';
  if (!doi || !title) return null;
  const published = getCrossrefPublishedDate(work);
  const year = Number(published.slice(0, 4)) || new Date().getFullYear();
  // Not the first licence with a URL: Elsevier lists its text-mining licence
  // first, and that read every subscription article as open access.
  const openLicense = openLicenseFromCrossref(work);
  const { publicationType, publicationStatus, peerReviewed } = publicationFactsForCrossrefType(work.type);

  return {
    id: `crossref:${doi}`,
    doi,
    title,
    abstract: stripMarkup(work.abstract),
    authors: (work.author || []).map(author => ({
      name: [author.given, author.family].filter(Boolean).join(' ').trim() || author.name || 'Autor desconocido',
    })).filter(author => author.name !== 'Autor desconocido'),
    year,
    published,
    journal: work['container-title']?.[0] || '',
    publisher: work.publisher || '',
    publicationType,
    publicationStatus,
    peerReviewed,
    // No open licence is not a paywall either: unknown stays unknown, and the
    // card asks for a free copy itself.
    openAccess: openLicense ? true : undefined,
    license: openLicense?.url,
    landingPageUrl: work.URL || `https://doi.org/${doi}`,
    citationCount: Number(work['is-referenced-by-count']) || 0,
    sourceType: work.type || 'article',
    provider: 'crossref',
    sources: { primary: 'crossref', enrichedBy: [] },
  };
}

function matchesInstitutionFallbackFilters(paper: Paper, filters: CrossrefFilters = {}) {
  // The canonical field, the one `entityExplorer` and `paperStatus` read. Asking
  // `publicationType !== 'journal'` instead agreed with it only by accident, and
  // dropped every refereed work whose venue is not a journal.
  if (filters.peerReviewed && paper.peerReviewed !== true) return false;
  if (filters.dateRange) {
    const year = paper.year || 0;
    const currentYear = new Date().getFullYear();
    if (filters.dateRange === 'last_year' && year < currentYear - 1) return false;
    if (filters.dateRange === 'last_5_years' && year < currentYear - 5) return false;
  }
  const query = String(filters.searchQuery || '').trim().toLowerCase();
  return !query || `${paper.title} ${paper.abstract} ${(paper.authors || []).map(author => (author as PaperAuthor).name).join(' ')}`.toLowerCase().includes(query);
}

export async function getInstitutionWorksFromCrossref(institutionName: string, page: number, searchQuery: string, filters: CrossrefFilters = {}, request: (url: string) => Promise<Response>) {
  if (!institutionName) return { papers: [], total: 0, source: 'crossref' };
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query.affiliation', institutionName);
  url.searchParams.set('rows', String(CROSSREF_WORKS_LIMIT));
  url.searchParams.set('offset', String((page - 1) * CROSSREF_WORKS_LIMIT));
  url.searchParams.set('select', 'DOI,title,author,published,issued,abstract,container-title,publisher,URL,is-referenced-by-count,type,license');
  if (searchQuery) url.searchParams.set('query.bibliographic', searchQuery);

  const response = await request(url.toString());
  if (!response.ok) throw new Error(`Crossref API error: ${response.status}`);
  const payload = await response.json() as { message?: { items?: CrossrefWork[] } };
  const papers = ((payload.message?.items || [])
    .map(mapCrossrefInstitutionWork)
    .filter(Boolean) as Paper[])
    .filter(paper => matchesInstitutionFallbackFilters(paper, { ...filters, searchQuery }));

  // Crossref's affiliation total is relevance-oriented and can be very broad.
  // Limit fallback pagination so it remains useful without pretending to be exhaustive.
  const total = page < 3 && papers.length === CROSSREF_WORKS_LIMIT
    ? page * CROSSREF_WORKS_LIMIT + 1
    : (page - 1) * CROSSREF_WORKS_LIMIT + papers.length;
  return { papers, total, source: 'crossref' };
}

function normalizeAuthorSearchValue(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export async function getInstitutionAuthorsFromCrossref(institutionName: string, page: number, searchQuery: string, request: (url: string) => Promise<Response>) {
  if (!institutionName || page > 1) {
    return { authors: [], total: 0, source: 'crossref' };
  }

  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query.affiliation', institutionName);
  url.searchParams.set('rows', String(CROSSREF_AUTHORS_WORKS_LIMIT));
  url.searchParams.set('select', 'DOI,author,is-referenced-by-count');
  if (searchQuery) url.searchParams.set('query.author', searchQuery);

  const response = await request(url.toString());
  if (!response.ok) throw new Error(`Crossref API error: ${response.status}`);
  const payload = await response.json() as { message?: { items?: CrossrefWork[] } };
  const normalizedQuery = normalizeAuthorSearchValue(searchQuery);
  const authorsByIdentity = new Map<string, OpenAlexAuthor & { works_count: number; cited_by_count: number; source: string }>();

  (payload.message?.items || []).forEach((work) => {
    const citations = Number(work['is-referenced-by-count']) || 0;
    (work.author || []).forEach((author) => {
      const displayName = [author.given, author.family].filter(Boolean).join(' ').trim()
        || String(author.name || '').trim();
      const normalizedName = normalizeAuthorSearchValue(displayName);
      if (!normalizedName || (normalizedQuery && !normalizedName.includes(normalizedQuery))) return;

      const orcid = String(author.ORCID || '').replace(/^https?:\/\/orcid\.org\//i, '');
      const identity = orcid || normalizedName;
      const existing = authorsByIdentity.get(identity) || {
        id: orcid ? `https://orcid.org/${orcid}` : `crossref-author:${encodeURIComponent(normalizedName)}`,
        display_name: displayName,
        works_count: 0,
        cited_by_count: 0,
        h_index: null,
        institution: institutionName,
        concepts: [],
        source: 'crossref',
      };
      existing.works_count += 1;
      existing.cited_by_count += citations;
      authorsByIdentity.set(identity, existing);
    });
  });

  const authors = [...authorsByIdentity.values()]
    .sort((left, right) => (
      right.works_count - left.works_count
      || right.cited_by_count - left.cited_by_count
      || left.display_name.localeCompare(right.display_name)
    ))
    .slice(0, 30);

  return { authors, total: authors.length, source: 'crossref' };
}
