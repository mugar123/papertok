import type { Paper } from '../../models/paper.ts';
import type { PaperSearchFilters, PaperSearchResult } from './index.ts';

import { readSourceCache, writeSourceCache } from '../../utils/source-cache.ts';
import { mapPubmedSummary, readPubmedPayload, type PubmedResponse, type PubmedSummary } from './pubmed-records.ts';
import { fetchWorkerSourceJson } from '../worker-api-client.ts';

// E-utilities answer as three serial requests (esearch → esummary → efetch).
// Run from the browser that was 1.35–2.05 s per feed load measured in production,
// with nothing cacheable along the way — the constant floor under every guest
// load — and NCBI counts those requests against the caller's IP, so users behind
// one NAT rate-limited each other. The chain now runs in the Worker, which holds
// the NCBI key, caches the answer at the edge and reserves against a global
// per-minute ceiling. This cache stays as a second tier in front of that one:
// ten minutes of staleness is invisible in a paper feed, and a hit here costs no
// request at all.
const PUBMED_CACHE_TTL_MS = 10 * 60 * 1000;
const PUBMED_PAGE_SIZE = 25;

export class PubmedAdapter {
  declare name: string;
  declare workerOptions: Parameters<typeof fetchWorkerSourceJson>[2];
  // `workerOptions` is the injection seam `openAlexClient` already uses:
  // `import.meta.env` does not exist under `node --test`, so without it this
  // adapter's network path could only be exercised in a browser.
  constructor(workerOptions: Parameters<typeof fetchWorkerSourceJson>[2] = {}) {
    this.name = 'pubmed';
    this.workerOptions = workerOptions;
  }

  async search(query: string, page = 1, filters: PaperSearchFilters = {}): Promise<PaperSearchResult> {
    const cacheKey = [
      'pubmed',
      query,
      page,
      filters?.type || '',
      [...(filters?.internalCategories || [])].sort().join(','),
      filters?.requireAbstract ? 'abstract' : '',
    ].join('|');

    const cached = readSourceCache<PaperSearchResult>(cacheKey, PUBMED_CACHE_TTL_MS);
    if (cached) return cached;

    const result = await this.fetchSearch(query, page, filters);
    // Errors throw past this point uncached; an empty result is a real answer
    // from PubMed and caches like any other.
    writeSourceCache(cacheKey, result);
    return result;
  }

  async fetchSearch(query: string, page = 1, filters: PaperSearchFilters = {}): Promise<PaperSearchResult> {
    try {
      let finalQuery = query;
      if (filters && filters.type === 'author') {
         finalQuery = `${query}[Author]`;
      }
      if (filters.requireAbstract) finalQuery = `(${finalQuery}) AND hasabstract`;

      // 1. The whole E-utilities chain, in one call to the Worker. It returns the
      // three upstream payloads unchanged — esearch, esummary and the efetch XML —
      // so everything below maps exactly what it mapped when the browser fetched
      // them itself.
      const pubmedData = await fetchWorkerSourceJson<PubmedResponse>('/sources/pubmed', {
        q: finalQuery,
        page,
        limit: PUBMED_PAGE_SIZE,
      }, this.workerOptions);

      const total = parseInt(pubmedData?.esearchresult?.count || '0');
      const parseXml = typeof DOMParser === 'function' ? (xml: string) => new DOMParser().parseFromString(xml, 'text/xml') : null;
      const mappedPapers = readPubmedPayload(pubmedData, { internalCategories: filters.internalCategories, parseXml, provider: this.name });

      return { papers: mappedPapers, total };

    } catch (error) {
      console.error("PubmedAdapter Error:", error);
      throw error;
    }
  }

  mapToStandard(raw: PubmedSummary): Paper {
    return mapPubmedSummary(raw, this.name);
  }
}
