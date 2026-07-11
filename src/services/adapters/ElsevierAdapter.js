import { BaseAdapter } from './BaseAdapter.js';

export class ElsevierAdapter extends BaseAdapter {
  constructor() {
    super('elsevier'); // Keep name for downstream compatibility
  }

  async search(query, page = 1, filters = {}) {
    const limit = 25;
    const offset = (page - 1) * limit;
    
    // Clean query
    let safeQuery = query.replace(/OR|AND/g, ' ').replace(/"/g, '').replace(/[()]/g, '');
    if (filters && filters.type === 'author') {
       safeQuery = query;
    }

    const fields = 'paperId,title,abstract,authors,year,isOpenAccess,venue,publicationTypes,citationCount,referenceCount,openAccessPdf';
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(safeQuery)}&offset=${offset}&limit=${limit}&fields=${fields}`;

    let attempts = 0;
    const maxAttempts = 3;
    let delay = 1200;

    while (attempts < maxAttempts) {
      try {
        const response = await fetch(url);
        
        if (response.status === 429) {
          attempts++;
          console.warn(`Semantic Scholar API rate limited (429). Retrying attempt ${attempts}/${maxAttempts} in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 1.5;
          continue;
        }

        if (!response.ok) {
          return { papers: [], total: 0 };
        }
        
        const data = await response.json();
        if (!data.data) return { papers: [], total: 0 };

        let mappedPapers = data.data.map(item => this.mapToStandard(item));
        
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
        return { papers: mappedPapers, total: data.total || 0 };
      } catch (e) {
        attempts++;
        if (attempts >= maxAttempts) {
          console.error("Error fetching from S2 fallback (ElsevierAdapter):", e);
          return { papers: [], total: 0 };
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return { papers: [], total: 0 };
  }

  async getDetails() {
    return null; 
  }

  mapToStandard(raw) {
    const isPreprint = raw.publicationTypes?.some(t => t.toLowerCase().includes('review') || t === 'preprint');
    return {
      id: raw.paperId,
      doi: null,
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
