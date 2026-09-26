import { BaseAdapter } from './BaseAdapter.js';
import { assignRequestedCategories } from '../arxivService.js';
import { openAlexFetch } from '../openAlexClient.js';
import { getArxivIdFromWork } from '../openAlexService.js';
import { usableOpenAlexAbstract } from '../../utils/openAlexAbstract.js';
import { usableOpenAlexConcepts } from '../../utils/openAlexConcepts.js';
import { openAlexPublicationStatus } from '../../utils/publicationStatus.js';

// The top-level fields `mapToStandard` and `getArxivIdFromWork` read, and
// the only ones a search asks for (`select=`). A works page used to arrive
// whole: 455 KB uncompressed, 65–82 KB on the wire, most of it fields nothing
// here reads (`referenced_works`, `keywords`, `counts_by_year`, the second
// half of `authorships`). Measured 2026-09-16 with this list: 326 KB and
// 45–49 KB. The Worker relays `select` untouched (OPENALEX_PARAMS). Nested
// selection is not something OpenAlex offers, so `authorships` and
// `locations` still travel whole. OpenAlexAdapter.test.js holds the guard:
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

// OpenAlex work types, in OpenAlex's current vocabulary. The filter used to ask
// for `proceedings-article`, Crossref's name for a conference paper, which
// OpenAlex no longer uses: `type:proceedings-article` matches zero works
// (probed 2026-09-22 through the Worker relay; `conference-paper` matched 16.2
// million). So the filter that meant "articles and conference papers" had been
// silently returning journal articles alone -- "Segment Anything" (ICCV 2023)
// and every other NeurIPS/CVPR/ICCV paper was invisible to the feed and to the
// search. `scripts/diagnostics/search-coverage-check.mjs` re-runs the probe.
export const OPENALEX_PUBLISHED_TYPES = Object.freeze(['article', 'conference-paper']);

// What a paper SEARCH accepts. A reader looking up a specific paper expects the
// arXiv preprint when that is the record OpenAlex carries -- FC-CLIP's most
// cited record is the preprint (W4385645314) -- and a survey when the title is
// a survey. The feed keeps the narrower list: preprints reach it from arXiv
// directly, and datasets, theses, and paratext are still left out here.
export const OPENALEX_SEARCH_TYPES = Object.freeze([...OPENALEX_PUBLISHED_TYPES, 'preprint', 'review']);

export class OpenAlexAdapter extends BaseAdapter {
  constructor() {
    super('openalex_search');
    this.baseUrl = 'https://api.openalex.org/works';
    this.mailto = 'app@papertok.io';
  }

  buildSearchUrl(query, page = 1, { types = OPENALEX_PUBLISHED_TYPES } = {}) {
    const perPage = 25;

    // Convert query to OpenAlex default.search format
    const searchParam = encodeURIComponent(query);

    const typeFilter = `type:${types.join('|')}`;

    return `${this.baseUrl}?filter=default.search:${searchParam},${typeFilter}&page=${page}&per-page=${perPage}&mailto=${this.mailto}&select=${OPENALEX_WORK_SEARCH_FIELDS.join(',')}`;
  }

  async search(query, page = 1, filters = {}) {
    const url = this.buildSearchUrl(query, page, { types: filters.types || OPENALEX_PUBLISHED_TYPES });

    try {
      const response = await openAlexFetch(url, {
        timeoutMs: 10000,
        cacheTtlMs: 10 * 60 * 1000,
        staleIfError: true,
        signal: filters.signal,
        // The feed's main search: ahead of the entity lookups sharing the queue.
        priority: filters.priority === true,
      });
      if (!response.ok) {
        throw new Error(`OpenAlex API error: ${response.status}`);
      }

      const data = await response.json();
      
      const papers = assignRequestedCategories(
        data.results.map(work => this.mapToStandard(work)).filter(Boolean),
        filters.internalCategories
      );

      return {
        papers,
        total: data.meta.count
      };
    } catch (error) {
      if (error.code !== 'aborted') {
        console.error('[OpenAlexAdapter] Search failed:', error);
      }
      throw new Error(`Could not reach OpenAlex: ${error.message}`, { cause: error });
    }
  }

  async getDetails(id) {
    let cleanId = id;
    if (id.startsWith('openalex:')) cleanId = id.replace('openalex:', '');
    
    const url = `${this.baseUrl}/${cleanId}?mailto=${this.mailto}`;
    try {
      const response = await openAlexFetch(url, {
        timeoutMs: 10000,
        cacheTtlMs: 24 * 60 * 60 * 1000,
        staleIfError: true,
      });
      if (!response.ok) throw new Error(`OpenAlex API error: ${response.status}`);
      
      const data = await response.json();
      return this.mapToStandard(data);
    } catch (error) {
      console.error('[OpenAlexAdapter] Error obteniendo detalles:', error);
      return null;
    }
  }

  mapToStandard(work) {
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
      openAccess: isOpenAccess,
      pdfUrl,
      landingPageUrl,
      citationsCount: work.cited_by_count || 0,
      citationCountKnown: Number.isFinite(work.cited_by_count),
      concepts: conceptObjects,
      topics: work.topics || [],
      primaryTopic: work.primary_topic || null,
      provider: this.name,
      categories: concepts,
      keywords: concepts,
      raw: work
    };
  }
}
