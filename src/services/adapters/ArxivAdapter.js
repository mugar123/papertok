import { BaseAdapter } from './BaseAdapter';

export class ArxivAdapter extends BaseAdapter {
  constructor() {
    super('arxiv');
  }

  async search(query, page = 1) {
    try {
      // ArXiv pagination
      const maxResults = 30;
      const start = (page - 1) * maxResults;
      
      const baseUrl = 'http://export.arxiv.org/api/query';
      const encodedQuery = encodeURIComponent(query);
      const url = `${baseUrl}?search_query=all:${encodedQuery}&start=${start}&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`ArXiv API Error: ${response.status}`);
      const text = await response.text();

      // Simple XML parsing (as it was done in arxivService)
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, 'text/xml');
      const entries = Array.from(xmlDoc.getElementsByTagName('entry'));

      const papers = entries.map(entry => this.mapToStandard(entry)).filter(Boolean);
      
      const totalResultsNode = xmlDoc.getElementsByTagName('opensearch:totalResults')[0];
      const total = totalResultsNode ? parseInt(totalResultsNode.textContent) : 0;

      return { papers, total };
    } catch (e) {
      console.error("Error fetching from arXiv via Adapter:", e);
      return { papers: [], total: 0 };
    }
  }

  mapToStandard(entry) {
    try {
      const idUrl = entry.getElementsByTagName('id')[0]?.textContent || '';
      const id = idUrl.split('/abs/').pop();
      if (!id) return null;

      const title = entry.getElementsByTagName('title')[0]?.textContent.replace(/\\n/g, ' ').trim() || 'No Title';
      const abstract = entry.getElementsByTagName('summary')[0]?.textContent.replace(/\\n/g, ' ').trim() || 'No summary available.';
      
      const authors = Array.from(entry.getElementsByTagName('author')).map(authorNode => {
        return {
          name: authorNode.getElementsByTagName('name')[0]?.textContent || 'Unknown',
          id: null,
          affiliation: null
        };
      });

      const published = entry.getElementsByTagName('published')[0]?.textContent || new Date().toISOString();
      const publishedYear = new Date(published).getFullYear();
      
      const allCategories = Array.from(entry.getElementsByTagName('category')).map(c => c.getAttribute('term'));

      // Extract PDF URL
      const pdfNode = Array.from(entry.getElementsByTagName('link')).find(link => link.getAttribute('title') === 'pdf');
      const pdfUrl = pdfNode ? pdfNode.getAttribute('href') : null;

      const doi = entry.querySelector('doi')?.textContent || entry.getElementsByTagName('arxiv:doi')[0]?.textContent || entry.getElementsByTagNameNS('*', 'doi')[0]?.textContent || '';
      const journalRef = entry.querySelector('journal_ref')?.textContent || entry.getElementsByTagName('arxiv:journal_ref')[0]?.textContent || entry.getElementsByTagNameNS('*', 'journal_ref')[0]?.textContent || '';
      const comment = entry.querySelector('comment')?.textContent || entry.getElementsByTagName('arxiv:comment')[0]?.textContent || entry.getElementsByTagNameNS('*', 'comment')[0]?.textContent || '';

      const isPublishedInArxiv = !!(doi || journalRef || (comment && comment.match(/(accepted|published|appears|to appear) in/i)));

      return {
        id: `arxiv:${id}`,
        title,
        abstract,
        authors,
        year: publishedYear,
        publicationStatus: isPublishedInArxiv ? 'published' : 'preprint',
        publicationType: isPublishedInArxiv ? 'article' : 'preprint',
        openAccess: true,
        pdfUrl,
        landingPageUrl: `https://arxiv.org/abs/${id}`,
        categories: allCategories,
        doi,
        journal: journalRef,
        sources: { primary: 'arxiv' }
      };
    } catch (e) {
      console.error("Error parsing arXiv entry:", e);
      return null;
    }
  }
}
