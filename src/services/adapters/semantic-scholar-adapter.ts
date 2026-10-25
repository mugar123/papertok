import type { Paper } from '../../models/paper.ts';
import type { PaperSearchFilters, PaperSearchResult } from './index.ts';

export interface SemanticScholarRecord {
  paperId: string;
  title?: string;
  publicationDate?: string;
  url?: string;
  abstract?: string | null;
  authors?: Array<{ name: string; authorId?: string | null }>;
  publicationTypes?: string[] | null;
  externalIds?: { DOI?: string | null; ArXiv?: string | null };
  year?: number | null;
  venue?: string | null;
  isOpenAccess?: boolean;
  openAccessPdf?: { url?: string | null } | null;
  citationCount?: number | null;
  referenceCount?: number | null;
}

import { fetchWorkerSourceJson } from '../worker-api-client.ts';
import { semanticScholarIsPreprint } from '../../utils/publication-status.ts';

const SEMANTIC_SCHOLAR_PAGE_SIZE = 25;

export class SemanticScholarAdapter {
  declare name: string;
  declare workerOptions: Parameters<typeof fetchWorkerSourceJson>[2];
  // Same injection seam as `PubmedAdapter`: `import.meta.env` is absent under
  // `node --test`, so the Worker origin has to be passable for the network path
  // to be testable at all.
  constructor(workerOptions: Parameters<typeof fetchWorkerSourceJson>[2] = {}) {
    this.name = 'semanticscholar';
    this.workerOptions = workerOptions;
  }

  async search(query: string, page = 1, filters: PaperSearchFilters = {}): Promise<PaperSearchResult> {
    // Clean query
    // Word boundaries, or CORD-19 becomes "C D-19": the operators are words.
    let safeQuery = query.replace(/\b(?:OR|AND)\b/g, ' ').replace(/"/g, '').replace(/[()]/g, '');
    if (filters && filters.type === 'author') {
       safeQuery = query;
    }

    // Semantic Scholar rate-limits per API key, not per caller, and this used to
    // go straight out of the browser with no key and a retry loop of its own —
    // one that every tab ran independently, so the more tabs the harder they
    // rate-limited each other. Both the key and the single shared ceiling live in
    // the Worker; a refusal arrives here already carrying its `retry-after`, so
    // there is nothing left for a local backoff to add.
    try {
      const data = await fetchWorkerSourceJson<{ data?: SemanticScholarRecord[]; total?: number }>('/sources/s2', {
        q: safeQuery,
        page,
        limit: SEMANTIC_SCHOLAR_PAGE_SIZE,
      }, this.workerOptions);

      if (!data?.data) return { papers: [], total: 0 };

      return { papers: data.data.map(item => this.mapToStandard(item)), total: data.total || 0 };
    } catch (e) {
      console.error("Error fetching from Semantic Scholar:", e);
      return { papers: [], total: 0 };
    }
  }

  mapToStandard(raw: SemanticScholarRecord): Paper {
    const isPreprint = semanticScholarIsPreprint(raw.publicationTypes);
    // The DOI and the arXiv id ride in `externalIds` (the Worker asks for
    // them). They used to be dropped — `doi: null` — so a paper saved from a
    // Semantic Scholar card was remembered under its S2 hash alone, an id no
    // public paper page can load, and its row in a list had no address.
    const externalIds = raw.externalIds || {};
    const doi = typeof externalIds.DOI === 'string' && externalIds.DOI.trim() ? externalIds.DOI.trim() : null;
    const arxivId = typeof externalIds.ArXiv === 'string' && externalIds.ArXiv.trim() ? externalIds.ArXiv.trim() : undefined;
    return {
      id: raw.paperId,
      sources: { primary: 'semanticscholar', enrichedBy: [] },
      doi,
      arxivId,
      title: raw.title || 'Untitled',
      abstract: raw.abstract || 'No abstract available.',
      authors: raw.authors?.map(a => ({ name: a.name, id: a.authorId })) || [],
      publishedDate: raw.year ? `${raw.year}-01-01` : null,
      year: raw.year || new Date().getFullYear(),
      sourceName: raw.venue || '',
      sourceType: 'journal',
      publicationStatus: isPreprint ? 'preprint' : 'published',
      openAccess: !!raw.isOpenAccess,
      pdfUrl: raw.openAccessPdf?.url || null,
      landingPageUrl: raw.paperId ? `https://www.semanticscholar.org/paper/${raw.paperId}` : null,
      citationsCount: raw.citationCount || 0,
      referenceCount: raw.referenceCount || 0,
      provider: this.name,
      raw
    };
  }
}
