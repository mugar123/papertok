import { BaseAdapter } from './BaseAdapter';
import { PaperBuilder } from '../PaperBuilder';

export class ArxivAdapter extends BaseAdapter {
  constructor() {
    super('arxiv');
  }

  async search(query, page = 1, filters = {}) {
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
      const year = new Date(published).getFullYear();
      
      const doiNode = Array.from(entry.getElementsByTagName('link')).find(link => link.getAttribute('title') === 'doi');
      const doi = doiNode ? doiNode.getAttribute('href').replace('http://dx.doi.org/', '') : null;

      // Extract PDF URL
      const pdfNode = Array.from(entry.getElementsByTagName('link')).find(link => link.getAttribute('title') === 'pdf');
      const pdfUrl = pdfNode ? pdfNode.getAttribute('href') + '.pdf' : null;

      return {
        id,
        doi,
        title,
        abstract,
        authors,
        publishedDate: published,
        year,
        sourceName: 'arXiv',
        sourceType: 'repository',
        publicationStatus: 'preprint',
        isOpenAccess: true,
        pdfUrl,
        landingPageUrl: `https://arxiv.org/abs/${id}`,
        citationsCount: 0,
        provider: this.name,
        raw: null // XML nodes are tricky to serialize, skip for now
      };
    } catch (e) {
      console.error("Error parsing arXiv entry:", e);
      return null;
    }
  }
}
