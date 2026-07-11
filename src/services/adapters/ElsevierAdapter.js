import { BaseAdapter } from './BaseAdapter';

export class ElsevierAdapter extends BaseAdapter {
  constructor() {
    super('elsevier');
    this.apiKey = import.meta.env.VITE_ELSEVIER_API_KEY;
    this.baseUrl = 'https://api.elsevier.com/content/search/scopus';
  }

  /**
   * Realiza una búsqueda en Scopus.
   */
  async search(query, page = 1, filters = {}) {
    if (!this.apiKey) {
      console.warn("Elsevier API Key no configurada.");
      return { papers: [], total: 0 };
    }

    // Scopus API pagination
    const count = 25;
    const start = (page - 1) * count;
    
    try {
      const url = new URL(this.baseUrl);
      let finalQuery = `TITLE-ABS-KEY(${query})`;
      if (filters && filters.type === 'author') {
        finalQuery = `AUTH(${query})`;
      }
      url.searchParams.append('query', finalQuery);
      url.searchParams.append('start', start);
      url.searchParams.append('count', count);

      const response = await fetch(url.toString(), {
        headers: {
          'X-ELS-APIKey': this.apiKey,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Elsevier API Error: ${response.status}`);
      }

      const data = await response.json();
      const results = data['search-results']?.entry || [];
      const total = parseInt(data['search-results']?.['opensearch:totalResults'] || '0');

      let mappedPapers = results.map(item => this.mapToStandard(item));

      if (filters && filters.internalCategories && filters.internalCategories.length > 0) {
        mappedPapers.forEach(p => {
          p.categories = [...(p.categories || []), ...filters.internalCategories];
        });
      }

      return { papers: mappedPapers, total };
    } catch (e) {
      console.error("Error fetching from Elsevier:", e);
      return { papers: [], total: 0 };
    }
  }

  async getDetails(id) {
    // Para simplificar, devolvemos null, ya que el search suele traer lo necesario
    // Si queremos detalle específico por DOI: https://api.elsevier.com/content/article/doi/{doi}
    return null; 
  }

  mapToStandard(raw) {
    const doi = raw['prism:doi'] || null;
    const id = raw['dc:identifier'] ? raw['dc:identifier'].replace('SCOPUS_ID:', '') : (doi || `elsevier-${Math.random().toString(36).substr(2, 9)}`);
    
    let authors = [];
    if (raw.author && Array.isArray(raw.author)) {
      authors = raw.author.map(a => ({
        name: a.authname || `${a['given-name']} ${a.surname}`,
        id: a.authid || null,
        affiliation: a.afid ? a.afid[0]?.['$'] : null
      }));
    } else if (raw['dc:creator']) {
      authors = [{ name: raw['dc:creator'], id: null, affiliation: null }];
    }

    const year = raw['prism:coverDate'] ? parseInt(raw['prism:coverDate'].split('-')[0]) : new Date().getFullYear();
    const sourceName = raw['prism:publicationName'] || '';
    const aggregationType = raw['prism:aggregationType'] || ''; // e.g. "Journal", "Conference Proceeding"
    
    let sourceType = 'other';
    if (aggregationType.toLowerCase().includes('journal')) sourceType = 'journal';
    if (aggregationType.toLowerCase().includes('conference')) sourceType = 'conference';

    const isOpenAccess = raw.openaccess === '1' || raw.openaccess === 'true';

    // Scopus link
    const landingPageUrl = raw.link?.find(l => l['@ref'] === 'scopus')?.['@href'] || 
                          (doi ? `https://doi.org/${doi}` : null);

    return {
      id,
      doi,
      title: raw['dc:title'] || 'Untitled',
      abstract: raw['dc:description'] || 'No abstract available.', // A veces Scopus no da abstract completo en el search endpoint sin derechos adicionales
      authors,
      publishedDate: raw['prism:coverDate'] || null,
      year,
      sourceName,
      sourceType,
      publicationStatus: 'published', // Scopus indexa contenido publicado/peer-reviewed
      isOpenAccess,
      pdfUrl: null, // Scopus API no devuelve PDF directo sin auth institucional, excepto OA vía ScienceDirect API, requeriría otro endpoint.
      landingPageUrl,
      citationsCount: parseInt(raw['citedby-count'] || '0'),
      provider: this.name,
      raw
    };
  }
}
