import { BaseAdapter } from './BaseAdapter';

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
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`OpenAlex API error: ${response.status}`);
      }

      const data = await response.json();
      
      const papers = data.results.map(work => this.mapToStandard(work)).filter(Boolean);

      return {
        papers,
        total: data.meta.count
      };
    } catch (error) {
      console.error('[OpenAlexAdapter] Error en búsqueda:', error);
      return { papers: [], total: 0 };
    }
  }

  async getDetails(id) {
    let cleanId = id;
    if (id.startsWith('openalex:')) cleanId = id.replace('openalex:', '');
    
    const url = `${this.baseUrl}/${cleanId}?mailto=${this.mailto}`;
    try {
      const response = await fetch(url);
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
    
    const concepts = (work.concepts || []).filter(c => c.score > 0.3).map(c => c.display_name);

    return {
      id: work.id.replace('https://openalex.org/', 'openalex:'),
      doi,
      title: work.title || 'Untitled',
      abstract,
      authors,
      publishedDate: work.publication_date,
      year: work.publication_year,
      sourceName,
      sourceType: work.type === 'proceedings-article' ? 'conference' : 'journal',
      publicationStatus: 'published',
      openAccess: isOpenAccess,
      pdfUrl,
      landingPageUrl,
      citationsCount: work.cited_by_count || 0,
      provider: this.name,
      categories: concepts,
      keywords: concepts,
      raw: work
    };
  }
}
