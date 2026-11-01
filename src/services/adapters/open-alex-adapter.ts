import type { Paper } from '../../models/paper.ts';
import type { PaperSearchFilters, PaperSearchResult } from './index.ts';
import type { OpenAlexWork } from './open-alex-types.ts';
import type { OpenAlexRequestError } from '../open-alex-client.ts';

import { getCategoryArea } from '../../data/category-taxonomy.ts';
import { openAlexFetch } from '../open-alex-client.ts';
import { OPENALEX_PUBLISHED_TYPES, OPENALEX_WORK_SEARCH_FIELDS, mapOpenAlexWork } from '../../utils/open-alex-work.ts';
import { normalizeSearchText } from '../../utils/search-relevance.ts';
import { openAlexTypeaheadExpression } from '../open-alex-search-query.ts';

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
