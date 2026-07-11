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
      let mappedPapers = results.map(item => this.mapToStandard(item));

      // 3. Enrich with efetch AND OpenAlex
      try {
          const enrichmentMap = {};
          if (pmids.length > 0) {
              const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=xml`;
              const fetchProm = fetch(fetchUrl).then(r => r.text()).catch(() => '');
              
              const oaUrl = `https://api.openalex.org/works?filter=ids.pmid:${pmids.join('|')}&select=ids,abstract_inverted_index,concepts`;
              const oaProm = fetch(oaUrl).then(r => r.json()).catch(() => null);
              
              const [xmlText, oaData] = await Promise.all([fetchProm, oaProm]);
              
              // Parse XML (EFetch)
              if (xmlText) {
                  const parser = new DOMParser();
                  const xmlDoc = parser.parseFromString(xmlText, "text/xml");
                  
                  const articles = xmlDoc.querySelectorAll('PubmedArticle');
                  articles.forEach(article => {
                      const pmidEl = article.querySelector('PMID');
                      if (!pmidEl) return;
                      const pmid = pmidEl.textContent;
                      
                      const abstractTexts = article.querySelectorAll('AbstractText');
                      const abstract = Array.from(abstractTexts).map(el => el.textContent).join(' ');
                      
                      const meshHeadings = article.querySelectorAll('MeshHeading > DescriptorName');
                      const categories = Array.from(meshHeadings).map(el => el.textContent);
                      
                      enrichmentMap[`pmid:${pmid}`] = { abstract, categories };
                  });
              }
              
              // Parse OpenAlex
              if (oaData && oaData.results) {
                  oaData.results.forEach(work => {
                      if (work.ids && work.ids.pmid) {
                          const pmid = work.ids.pmid.split('/').pop();
                          const pmidKey = `pmid:${pmid}`;
                          if (!enrichmentMap[pmidKey]) enrichmentMap[pmidKey] = { abstract: '', categories: [] };
                          
                          let abstract = '';
                          if (work.abstract_inverted_index) {
                              const words = [];
                              for (const [word, positions] of Object.entries(work.abstract_inverted_index)) {
                                  for (const pos of positions) {
                                      words[pos] = word;
                                  }
                              }
                              abstract = words.join(' ').replace(/\s+/g, ' ').trim();
                          }
                          const categories = work.concepts?.map(c => c.display_name) || [];
                          
                          // Merge (prefer efetch abstract if exists, prefer whichever has categories)
                          if (!enrichmentMap[pmidKey].abstract && abstract) {
                              enrichmentMap[pmidKey].abstract = abstract;
                          }
                          if (enrichmentMap[pmidKey].categories.length === 0 && categories.length > 0) {
                              enrichmentMap[pmidKey].categories = categories;
                          }
                      }
                  });
              }

              mappedPapers = mappedPapers.map(p => {
                const enrichment = enrichmentMap[p.id];
                if (enrichment) {
                  if (enrichment.abstract) p.abstract = enrichment.abstract;
                  if (enrichment.categories && enrichment.categories.length > 0) {
                    p.categories = enrichment.categories;
                    p.keywords = enrichment.categories;
                  }
                }
                return p;
              });
          }
      } catch (err) {
        console.warn("PubmedAdapter enrichment failed:", err);
      }

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
      // We don't set pdfUrl because PMC PDFs block iframes (X-Frame-Options: SAMEORIGIN)
      // The landing page URL will be used instead, opening natively in a new tab.
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
