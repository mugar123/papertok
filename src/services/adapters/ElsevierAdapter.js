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
      // append apiKey so it passes through the proxy without needing headers
      url.searchParams.append('apiKey', this.apiKey);

      let response = null;
      
      try {
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(url.toString())}`;
        response = await fetch(proxyUrl, {
          headers: { 'Accept': 'application/json' }
        });
      } catch (err) {
        console.warn("corsproxy.io failed for Elsevier, trying codetabs", err);
      }

      if (!response || !response.ok) {
        const fallbackProxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url.toString())}`;
        response = await fetch(fallbackProxyUrl, {
          headers: { 'Accept': 'application/json' }
        });
      }

      if (!response.ok) {
        throw new Error(`Elsevier API Error: ${response.status}`);
      }

      const data = await response.json();
      const results = data['search-results']?.entry || [];
      const total = parseInt(data['search-results']?.['opensearch:totalResults'] || '0');

      let mappedPapers = results.map(item => this.mapToStandard(item));

      if (filters && filters.internalCategories && filters.internalCategories.length > 0) {
        mappedPapers = mappedPapers.map(p => {
          const paperText = `${p.title} ${p.abstract || ''}`.toLowerCase();
          let bestMatch = null;
          for (const catId of filters.internalCategories) {
              const keywords = catId.split('.');
              if (keywords.some(kw => kw.length > 2 && paperText.includes(kw))) {
                  bestMatch = catId;
                  break;
              }
          }
          const selectedCat = bestMatch || filters.internalCategories[Math.floor(Math.random() * filters.internalCategories.length)];
          p.categories = [selectedCat, ...(p.categories || [])];
          return p;
        });
      }
      return { papers: mappedPapers, total };
    } catch (e) {
      console.error("Error fetching from Elsevier:", e);
      return { papers: [], total: 0 };
    }
  }

  async getDetails() {
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
      openAccess: isOpenAccess,
      pdfUrl: null, // Scopus API no devuelve PDF directo sin auth institucional, excepto OA vía ScienceDirect API, requeriría otro endpoint.
      landingPageUrl,
      citationsCount: parseInt(raw['citedby-count'] || '0'),
      provider: this.name,
      raw
    };
  }
}
