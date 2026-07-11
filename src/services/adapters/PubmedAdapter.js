import { BaseAdapter } from './BaseAdapter';

export class PubmedAdapter extends BaseAdapter {
  constructor() {
    super('pubmed');
    this.searchBase = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
    this.summaryBase = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
  }

  async search(query, page = 1, filters = {}) {
    try {
      const count = 25;
      const start = (page - 1) * count;

      let finalQuery = query;
      if (filters && filters.type === 'author') {
         finalQuery = `${query}[Author]`;
      }

      // 1. Fetch PMIDs
      const searchUrl = new URL(this.searchBase);
      searchUrl.searchParams.append('db', 'pubmed');
      searchUrl.searchParams.append('term', finalQuery);
      searchUrl.searchParams.append('retmode', 'json');
      searchUrl.searchParams.append('retmax', count.toString());
      searchUrl.searchParams.append('retstart', start.toString());

      const searchRes = await fetch(searchUrl.toString());
      if (!searchRes.ok) throw new Error(`PubMed Search Error: ${searchRes.status}`);
      const searchData = await searchRes.json();
      
      const pmids = searchData.esearchresult?.idlist || [];
      const total = parseInt(searchData.esearchresult?.count || '0');

      if (pmids.length === 0) {
        return { papers: [], total };
      }

      // 2. Fetch Summaries
      const summaryUrl = new URL(this.summaryBase);
      summaryUrl.searchParams.append('db', 'pubmed');
      summaryUrl.searchParams.append('id', pmids.join(','));
      summaryUrl.searchParams.append('retmode', 'json');

      const summaryRes = await fetch(summaryUrl.toString());
      if (!summaryRes.ok) throw new Error(`PubMed Summary Error: ${summaryRes.status}`);
      const summaryData = await summaryRes.json();

      const results = pmids.map(pmid => summaryData.result[pmid]).filter(Boolean);
      const mappedPapers = results.map(item => this.mapToStandard(item));

      return { papers: mappedPapers, total };

    } catch (error) {
      console.error("PubmedAdapter Error:", error);
      return { papers: [], total: 0 };
    }
  }

  mapToStandard(raw) {
    let doi = null;
    let pmc = null;
    
    if (raw.articleids) {
       const doiObj = raw.articleids.find(id => id.idtype === 'doi');
       if (doiObj) doi = doiObj.value;
       
       const pmcObj = raw.articleids.find(id => id.idtype === 'pmc');
       if (pmcObj) pmc = pmcObj.value;
    }

    const id = raw.uid;
    
    let authors = [];
    if (raw.authors && Array.isArray(raw.authors)) {
      authors = raw.authors.map(a => ({ name: a.name }));
    }

    let pdfUrl = '';
    let isOpenAccess = false;
    
    if (pmc) {
      isOpenAccess = true;
      pdfUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmc}/pdf/`;
    }

    const landingPageUrl = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;

    return {
      id: `pmid:${id}`,
      sources: { primary: this.name, enrichedBy: [] },
      title: raw.title || 'Untitled',
      abstract: '', // E-utilities esummary doesn't return full abstract, EFetch is needed for that. We leave it empty and let OpenAlex enrich it if possible.
      authors,
      doi,
      journal: raw.source || '',
      year: raw.pubdate ? parseInt(raw.pubdate.substring(0, 4)) : new Date().getFullYear(),
      publicationStatus: 'published',
      isOpenAccess,
      pdfUrl,
      landingPageUrl,
      citationsCount: 0,
      provider: this.name,
      raw
    };
  }
}
