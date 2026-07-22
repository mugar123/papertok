import { BaseAdapter } from './BaseAdapter.js';
import { assignRequestedCategories } from '../arxivService.js';
import { openAlexFetch } from '../openAlexClient.js';

export class OpenAlexAdapter extends BaseAdapter {
  constructor() {
    super('openalex_search');
    this.baseUrl = 'https://api.openalex.org/works';
    this.mailto = 'app@papertok.io';
  }

  async search(query, page = 1, filters = {}) {
    const perPage = 25;
    
    // Convert query to OpenAlex default.search format
    const searchParam = encodeURIComponent(query);
    
    // We only want journal articles and proceedings (published papers)
    const typeFilter = 'type:article|proceedings-article';
    
    let url = `${this.baseUrl}?filter=default.search:${searchParam},${typeFilter}&page=${page}&per-page=${perPage}&mailto=${this.mailto}`;

    try {
      const response = await openAlexFetch(url, {
        timeoutMs: 10000,
        cacheTtlMs: 10 * 60 * 1000,
        staleIfError: true,
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
      console.error('[OpenAlexAdapter] Error en búsqueda:', error);
      throw new Error(`No se pudo conectar con OpenAlex: ${error.message}`, { cause: error });
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

    // Reconstruct abstract from inverted index
    let abstract = 'No abstract available.';
    if (work.abstract_inverted_index) {
      const index = work.abstract_inverted_index;
      const wordPositions = [];
      for (const [word, positions] of Object.entries(index)) {
        for (const pos of positions) {
          wordPositions.push({ word, pos });
        }
      }
      wordPositions.sort((a, b) => a.pos - b.pos);
      abstract = wordPositions.map(wp => wp.word).join(' ');
    }

    const isOpenAccess = work.open_access?.is_oa || false;
    const pdfUrl = work.open_access?.oa_url || null;
    const landingPageUrl = work.primary_location?.landing_page_url || work.doi || null;
    
    const sourceName = work.primary_location?.source?.display_name || 'Unknown Journal';
    
    const semanticEntries = work.concepts?.length ? work.concepts : (work.topics || []);
    const conceptObjects = semanticEntries.filter(concept => concept.score === undefined || concept.score > 0.3);
    const concepts = conceptObjects.map(concept => concept.display_name);
    const publicationType = work.type || work.primary_location?.source?.type || 'article';
    const publicationStatus = publicationType === 'preprint' || work.primary_location?.source?.type === 'repository'
      ? 'preprint'
      : 'published';

    return {
      id: work.id.replace('https://openalex.org/', 'openalex:'),
      sources: { primary: 'openalex', enrichedBy: [] },
      doi,
      title: work.title || 'Untitled',
      abstract,
      authors,
      institutions,
      publishedDate: work.publication_date,
      year: work.publication_year,
      sourceName,
      sourceType: work.type === 'proceedings-article' ? 'conference' : 'journal',
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
