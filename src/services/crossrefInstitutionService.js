const CROSSREF_WORKS_LIMIT = 30;

function stripMarkup(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCrossrefPublishedDate(work) {
  const dateParts = work.published?.['date-parts']?.[0]
    || work['published-online']?.['date-parts']?.[0]
    || work.issued?.['date-parts']?.[0]
    || [];
  const [year, month = 1, day = 1] = dateParts;
  if (!year) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function mapCrossrefInstitutionWork(work) {
  const doi = String(work?.DOI || '').trim().toLowerCase();
  const title = work?.title?.[0] || '';
  if (!doi || !title) return null;
  const published = getCrossrefPublishedDate(work);
  const year = Number(published.slice(0, 4)) || new Date().getFullYear();
  const licenseUrl = work.license?.find(license => /^https?:\/\//i.test(license?.URL || ''))?.URL || '';

  return {
    id: `crossref:${doi}`,
    doi,
    title,
    abstract: stripMarkup(work.abstract) || 'El resumen no está disponible en Crossref.',
    authors: (work.author || []).map(author => ({
      name: [author.given, author.family].filter(Boolean).join(' ').trim() || author.name || 'Autor desconocido',
    })).filter(author => author.name !== 'Autor desconocido'),
    year,
    published,
    journal: work['container-title']?.[0] || '',
    publisher: work.publisher || '',
    publicationType: work.type === 'journal-article' ? 'journal' : 'publication',
    publicationStatus: 'published',
    openAccess: Boolean(licenseUrl),
    license: licenseUrl || undefined,
    landingPageUrl: work.URL || `https://doi.org/${doi}`,
    citationCount: Number(work['is-referenced-by-count']) || 0,
    sourceType: work.type || 'article',
    provider: 'crossref',
    sources: { primary: 'crossref', enrichedBy: [] },
  };
}

function matchesInstitutionFallbackFilters(paper, filters = {}) {
  if (filters.peerReviewed && paper.publicationType !== 'journal') return false;
  if (filters.dateRange) {
    const year = paper.year || 0;
    const currentYear = new Date().getFullYear();
    if (filters.dateRange === 'last_year' && year < currentYear - 1) return false;
    if (filters.dateRange === 'last_5_years' && year < currentYear - 5) return false;
  }
  const query = String(filters.searchQuery || '').trim().toLowerCase();
  return !query || `${paper.title} ${paper.abstract} ${(paper.authors || []).map(author => author.name).join(' ')}`.toLowerCase().includes(query);
}

export async function getInstitutionWorksFromCrossref(institutionName, page, searchQuery, filters = {}, request) {
  if (!institutionName) return { papers: [], total: 0, source: 'crossref' };
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query.affiliation', institutionName);
  url.searchParams.set('rows', String(CROSSREF_WORKS_LIMIT));
  url.searchParams.set('offset', String((page - 1) * CROSSREF_WORKS_LIMIT));
  url.searchParams.set('select', 'DOI,title,author,published,issued,abstract,container-title,publisher,URL,is-referenced-by-count,type,license');
  if (searchQuery) url.searchParams.set('query.bibliographic', searchQuery);

  const response = await request(url.toString());
  if (!response.ok) throw new Error(`Crossref API error: ${response.status}`);
  const payload = await response.json();
  const papers = (payload.message?.items || [])
    .map(mapCrossrefInstitutionWork)
    .filter(Boolean)
    .filter(paper => matchesInstitutionFallbackFilters(paper, { ...filters, searchQuery }));

  // Crossref's affiliation total is relevance-oriented and can be very broad.
  // Limit fallback pagination so it remains useful without pretending to be exhaustive.
  const total = page < 3 && papers.length === CROSSREF_WORKS_LIMIT
    ? page * CROSSREF_WORKS_LIMIT + 1
    : (page - 1) * CROSSREF_WORKS_LIMIT + papers.length;
  return { papers, total, source: 'crossref' };
}
