import { BaseAdapter } from './BaseAdapter.js';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const SCOPUS_ENABLED = import.meta.env?.VITE_SCOPUS_ENABLED === 'true';
const REQUEST_TIMEOUT_MS = 12_000;

export function isScopusEnabled() {
  return SCOPUS_ENABLED && Boolean(PAPER_API_BASE);
}

function normalizeText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDoi(value) {
  return String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function extractTerms(query) {
  const quoted = [...String(query || '').matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const candidates = quoted.length > 0 ? quoted : String(query || '').split(/\s+OR\s+/i);
  return [...new Set(candidates.map(normalizeText).filter(Boolean))].slice(0, 4);
}

function authorName(author) {
  return normalizeText(
    author?.authname
      || author?.['ce:indexed-name']
      || [author?.['given-name'], author?.surname].filter(Boolean).join(' ')
      || author?.name,
  );
}

function linksByRelation(raw) {
  return (Array.isArray(raw?.link) ? raw.link : raw?.link ? [raw.link] : []).reduce((links, item) => {
    const relation = item?.['@ref'] || item?.['@rel'];
    const href = safeUrl(item?.['@href'] || item?.href);
    if (relation && href) links[relation] = href;
    return links;
  }, {});
}

function selectRequestedCategory(raw, requestedCategories) {
  if (!requestedCategories?.length) return '';
  if (requestedCategories.length === 1) return requestedCategories[0];
  const text = `${raw?.['dc:title'] || ''} ${raw?.['dc:description'] || ''}`.toLowerCase();
  return requestedCategories.find(category => {
    const tokens = category.split(/[.-]/).filter(token => token.length > 3);
    return tokens.some(token => text.includes(token.toLowerCase()));
  }) || requestedCategories[0];
}

export class ScopusAdapter extends BaseAdapter {
  constructor() {
    super('scopus');
  }

  async search(query, page = 1, filters = {}) {
    if (!PAPER_API_BASE) return { papers: [], total: 0, unavailable: true };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`${PAPER_API_BASE}/sources/scopus`);
      url.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
      url.searchParams.set('limit', String(Math.max(1, Math.min(10, Number(filters.limit) || 8))));
      url.searchParams.set('sort', filters.sort === 'recent' ? 'recent' : 'relevance');
      if (filters.type === 'author') {
        url.searchParams.set('author', normalizeText(query).replace(/^"|"$/g, ''));
      } else {
        const terms = filters.terms?.length ? filters.terms : extractTerms(query);
        url.searchParams.set('terms', terms.join('|'));
      }

      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Scopus source returned ${response.status}`);
      const data = await response.json();
      const searchResults = data?.['search-results'] || {};
      const entries = Array.isArray(searchResults.entry) ? searchResults.entry : [];
      return {
        papers: entries.map(entry => this.mapToStandard(entry, filters.internalCategories)).filter(Boolean),
        total: Math.max(0, Number(searchResults['opensearch:totalResults']) || 0),
        quota: data?._papertok?.quota || null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getDetails() {
    return null;
  }

  mapToStandard(raw, requestedCategories = []) {
    if (!raw?.['dc:title']) return null;
    const links = linksByRelation(raw);
    const scopusId = String(raw.eid || raw['dc:identifier'] || '').replace(/^SCOPUS_ID:/i, '');
    const doi = normalizeDoi(raw['prism:doi']);
    const rawAuthors = Array.isArray(raw.author)
      ? raw.author
      : Array.isArray(raw.authors?.author)
        ? raw.authors.author
        : [];
    const authors = rawAuthors.map(author => ({ name: authorName(author), id: author?.authid || undefined })).filter(author => author.name);
    if (authors.length === 0 && raw['dc:creator']) authors.push({ name: normalizeText(raw['dc:creator']) });

    const published = raw['prism:coverDate'] || '';
    const year = Number(String(published).slice(0, 4)) || new Date().getFullYear();
    const citedByUrl = links['scopus-citedby'] || '';
    const rawCitationCount = Number(raw['citedby-count']);
    const hasAttributedCitations = Number.isFinite(rawCitationCount) && Boolean(citedByUrl);
    const openAccess = String(raw.openaccess || '') === '1' || String(raw.openaccessFlag || '').toLowerCase() === 'true';
    const selectedCategory = selectRequestedCategory(raw, requestedCategories);

    return {
      id: scopusId ? `scopus:${scopusId}` : doi ? `scopus:doi:${doi}` : `scopus:title:${normalizeText(raw['dc:title']).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 100)}`,
      sources: { primary: 'scopus', enrichedBy: [] },
      scopusId: scopusId || undefined,
      scopusUrl: links.scopus || safeUrl(raw['prism:url']) || undefined,
      scopusCitedByUrl: citedByUrl || undefined,
      scopusCitationCount: hasAttributedCitations ? rawCitationCount : undefined,
      doi: doi || undefined,
      title: normalizeText(raw['dc:title']),
      abstract: normalizeText(raw['dc:description'] || raw['prism:teaser']) || 'No abstract available.',
      authors,
      publishedDate: published || undefined,
      published,
      year,
      sourceName: normalizeText(raw['prism:publicationName']),
      journal: normalizeText(raw['prism:publicationName']),
      sourceType: /conference/i.test(raw.subtypeDescription || raw['prism:aggregationType'] || '') ? 'conference' : 'journal',
      publicationType: normalizeText(raw.subtypeDescription) || 'article',
      publicationStatus: 'published',
      openAccess,
      landingPageUrl: links.scopus || (doi ? `https://doi.org/${doi}` : safeUrl(raw['prism:url'])),
      citationsCount: hasAttributedCitations ? rawCitationCount : 0,
      citationCountKnown: hasAttributedCitations,
      categories: selectedCategory ? [selectedCategory] : [],
      allCategories: selectedCategory ? [selectedCategory] : [],
      primaryCategory: selectedCategory,
      provider: this.name,
      raw,
    };
  }
}
