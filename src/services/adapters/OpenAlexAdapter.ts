import type { Paper } from '../../models/Paper.ts';
import type { PaperSearchFilters, PaperSearchResult } from './index.ts';
import type { OpenAlexWork } from './openAlexTypes.ts';
import type { OpenAlexRequestError } from '../openAlexClient.ts';

import { getCategoryArea } from '../../data/categoryTaxonomy.ts';
import { openAlexFetch } from '../openAlexClient.ts';
import { OPENALEX_WORK_SEARCH_FIELDS, mapOpenAlexWork } from '../../utils/openAlexWork.ts';
import { normalizeSearchText } from '../../utils/searchRelevance.ts';
import { openAlexTypeaheadExpression } from '../openAlexSearchQuery.ts';

// OpenAlex work types, in OpenAlex's current vocabulary. The filter used to ask
// for `proceedings-article`, Crossref's name for a conference paper, which
// OpenAlex no longer uses: `type:proceedings-article` matches zero works
// (probed 2026-09-22 through the Worker relay; `conference-paper` matched 16.2
// million). So the filter that meant "articles and conference papers" had been
// silently returning journal articles alone -- "Segment Anything" (ICCV 2023)
// and every other NeurIPS/CVPR/ICCV paper was invisible to the feed and to the
// search. `scripts/diagnostics/search-coverage-check.mjs` re-runs the probe.
export const OPENALEX_PUBLISHED_TYPES = Object.freeze(['article', 'conference-paper', 'review']);

// What a paper SEARCH accepts. A reader looking up a specific paper expects the
// arXiv preprint when that is the record OpenAlex carries -- FC-CLIP's most
// cited record is the preprint (W4385645314) -- and a survey when the title is
// a survey. Category discovery also includes economics and finance preprints,
// whose working papers may have no arXiv copy. Queries without those categories
// keep the narrower list; datasets, theses, and paratext are still left out here.
export const OPENALEX_SEARCH_TYPES = Object.freeze([...OPENALEX_PUBLISHED_TYPES, 'preprint']);

export class OpenAlexAdapter {
  declare name: string;
  declare baseUrl: string;
  declare mailto: string;
  constructor() {
    this.name = 'openalex_search';
    this.baseUrl = 'https://api.openalex.org/works';
    this.mailto = 'app@papertok.io';
  }

  buildSearchUrl(query: string|number|boolean, page = 1, { types, internalCategories = [], typeahead = false }: PaperSearchFilters = {}) {
    const perPage = 25;

    let searchField = 'default.search';
    let expression = String(query);
    const words = normalizeSearchText(query).split(' ').filter(Boolean);
    const expanded = typeahead ? openAlexTypeaheadExpression(String(query)) : null;
    if (expanded) {
      const titleQuery = words.some(word => /^[a-z]{5,}$/.test(word))
        || (words.length === 1 && /^[a-z]{4,}$/.test(String(query).trim()));
      searchField = titleQuery ? 'title.search.exact' : 'default.search.exact';
      expression = titleQuery ? expanded : `"${words.join(' ')}"`;
    }
    const searchParam = encodeURIComponent(expression);

    const economicCategories = internalCategories.some(category => ['econ', 'q-fin'].includes(getCategoryArea(category) as string));
    const workTypes = types || (economicCategories
      ? [...OPENALEX_PUBLISHED_TYPES, 'preprint']
      : OPENALEX_PUBLISHED_TYPES);
    const typeFilter = `type:${workTypes.join('|')}`;

    return `${this.baseUrl}?filter=${searchField}:${searchParam},${typeFilter}&page=${page}&per-page=${perPage}&mailto=${this.mailto}&select=${OPENALEX_WORK_SEARCH_FIELDS.join(',')}`;
  }

  async search(query: string, page = 1, filters: PaperSearchFilters = {}): Promise<PaperSearchResult> {
    const url = this.buildSearchUrl(query, page, filters);

    try {
      const response = await openAlexFetch(url, {
        timeoutMs: 10000,
        cacheTtlMs: 10 * 60 * 1000,
        staleIfError: true,
        // Suggestions share their exact/fuzzy/prefix branches in one request.
        // Retrying each keystroke on an outage would multiply provider use.
        ...(filters.typeahead ? { retries: 0 } : {}),
        signal: filters.signal,
        // The reader's paper search: ahead of the entity lookups sharing the queue.
        priority: filters.priority === true,
      });
      if (!response.ok) {
        throw new Error(`OpenAlex API error: ${response.status}`);
      }

      const data = await response.json() as { results: OpenAlexWork[]; meta: { count: number } };
      
      // No category from the request: an OpenAlex work carries none of arXiv's,
      // and `internalCategories` only widens the work types above. Choosing one
      // by label words in the abstract called an AI survey "High Energy
      // Physics - Theory" (PAP-60); the card reads `primaryTopic` instead.
      const papers = data.results.map(work => this.mapToStandard(work)).filter(Boolean) as Paper[];

      return {
        papers,
        total: data.meta.count
      };
    } catch (error) {
      if ((error as OpenAlexRequestError).code !== 'aborted') {
        console.error('[OpenAlexAdapter] Search failed:', error);
      }
      throw new Error(`Could not reach OpenAlex: ${(error as Error).message}`, { cause: error });
    }
  }

  mapToStandard(work: OpenAlexWork | null | undefined): Paper | null {
    return mapOpenAlexWork(work, this.name);
  }
}
