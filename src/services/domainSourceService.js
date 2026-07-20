import { CATEGORIES } from '../data/categories.js';
import { PaperBuilder } from './PaperBuilder.js';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const REQUEST_TIMEOUT_MS = 10_000;

const BIORXIV_CATEGORIES = {
  'bio.gen': 'genetics',
  'bio.mol': 'molecular biology',
  'bio.cell': 'cell biology',
  'bio.neuro': 'neuroscience',
  'bio.eco': 'ecology',
  'bio.evo': 'evolutionary biology',
  'bio.zoo': 'animal behavior and cognition',
  'bio.bot': 'plant biology',
  'bio.micro': 'microbiology',
  'bio.immuno': 'immunology',
  'bio.comp': 'bioinformatics',
  'bio.physio': 'physiology',
  'bio.biochem': 'biochemistry',
  'bio.marine': 'ecology',
  'bio.biotech': 'synthetic biology',
};

const OSTI_CATEGORIES = new Set([
  'eess.power',
  'civil.env',
  'civil.hydro',
  'chemeng.process',
  'chemeng.nano',
  'chemeng.energy',
  'chemeng.metal',
  'chemeng.ceramics',
  'chemeng.sep',
]);

const NASA_CATEGORIES = new Set([
  'mech.dyn',
  'mech.fluid',
  'mech.thermo',
  'mech.solid',
  'mech.aero',
  'mech.cad',
  'mech.acoustics',
]);

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

function safeYear(value) {
  const year = new Date(value).getUTCFullYear();
  return Number.isInteger(year) && year > 1800 ? year : new Date().getUTCFullYear();
}

function categoryLabel(categoryId) {
  for (const area of Object.values(CATEGORIES)) {
    const category = area.subcategories?.[categoryId];
    if (category) return category.labelEn || category.label;
  }
  return categoryId.replace(/[.-]/g, ' ');
}

function selectCategory(providerLabel, requestedCategories) {
  if (!requestedCategories?.length) return '';
  if (requestedCategories.length === 1) return requestedCategories[0];
  const normalizedProvider = normalizeText(providerLabel).toLowerCase();
  return requestedCategories.find(categoryId => {
    const label = categoryLabel(categoryId).toLowerCase();
    return normalizedProvider.includes(label) || label.includes(normalizedProvider);
  }) || requestedCategories[0];
}

function withRequestedCategory(paper, requestedCategories, providerLabel = '') {
  const selected = selectCategory(providerLabel, requestedCategories);
  if (!selected) return paper;
  return {
    ...paper,
    primaryCategory: selected,
    categories: [...new Set([selected, ...(paper.categories || [])])],
    allCategories: [...new Set([selected, ...(paper.allCategories || paper.categories || [])])],
  };
}

function authorObjects(values) {
  return (values || [])
    .map(value => typeof value === 'string' ? value : value?.name || value?.fullName)
    .map(normalizeText)
    .filter(Boolean)
    .map(name => ({ name }));
}

export function mapBioRxivPaper(raw, requestedCategories = []) {
  const doi = normalizeDoi(raw?.doi);
  if (!doi || !raw?.title) return null;
  const version = String(raw.version || '1').replace(/\D/g, '') || '1';
  const category = normalizeText(raw.category);
  const landingPageUrl = `https://www.biorxiv.org/content/${doi}v${version}`;
  const paper = PaperBuilder.create({
    id: `biorxiv:${encodeURIComponent(doi)}:v${version}`,
    doi,
    sources: { primary: 'biorxiv', enrichedBy: [] },
    title: normalizeText(raw.title),
    abstract: normalizeText(raw.abstract),
    authors: authorObjects(String(raw.authors || '').split(';')),
    year: safeYear(raw.date),
    published: raw.date || '',
    publicationType: 'preprint',
    publicationStatus: 'preprint',
    openAccess: true,
    landingPageUrl,
    pdfUrl: `${landingPageUrl}.full.pdf`,
    license: normalizeText(raw.license),
    concepts: category ? [{ id: `biorxiv:${category.toLowerCase().replace(/\s+/g, '-')}`, display_name: category, level: 2 }] : [],
    categories: category ? [category] : [],
    keywords: category ? [category] : [],
  });
  return withRequestedCategory(paper, requestedCategories, category);
}

export function mapEuropePmcSearchResult(raw, requestedCategories = []) {
  const providerId = String(raw?.id || '').trim();
  const pmid = String(raw?.pmid || '').trim();
  if ((!providerId && !pmid) || !raw?.title) return null;
  const doi = normalizeDoi(raw.doi);
  const pmcid = String(raw.pmcid || '').trim();
  const urls = raw.fullTextUrlList?.fullTextUrl || [];
  const isOpenAccess = String(raw.isOpenAccess || '').toUpperCase() === 'Y';
  const availableUrls = urls.filter(item => isOpenAccess || ['OA', 'F'].includes(item?.availabilityCode));
  const pdfUrl = safeUrl(availableUrls.find(item => item.documentStyle === 'pdf')?.url);
  const htmlUrl = safeUrl(availableUrls.find(item => item.documentStyle === 'html')?.url);
  const hasOpenFullText = isOpenAccess || availableUrls.length > 0;
  const keywords = (raw.keywordList?.keyword || []).map(normalizeText).filter(Boolean);
  const meshTerms = (raw.meshHeadingList?.meshHeading || [])
    .map(item => normalizeText(typeof item?.descriptorName === 'string' ? item.descriptorName : item?.descriptorName?.$))
    .filter(Boolean);
  const terms = [...new Set([...meshTerms, ...keywords])].slice(0, 12);
  const published = raw.firstPublicationDate || raw.electronicPublicationDate || raw.dateOfCreation || '';
  const paper = PaperBuilder.create({
    id: pmid ? `pmid:${pmid}` : `europepmc:${raw.source || 'EPMC'}:${providerId}`,
    pmid: pmid || undefined,
    pmcid: pmcid || undefined,
    doi: doi || undefined,
    sources: { primary: 'europepmc', enrichedBy: [] },
    title: normalizeText(raw.title),
    abstract: normalizeText(raw.abstractText),
    authors: authorObjects(raw.authorList?.author || String(raw.authorString || '').split(',')),
    journal: normalizeText(raw.journalInfo?.journal?.title),
    year: safeYear(published || `${raw.journalInfo?.yearOfPublication || ''}-01-01`),
    published,
    publicationType: 'article',
    publicationStatus: 'published',
    openAccess: hasOpenFullText,
    landingPageUrl: htmlUrl || (pmcid ? `https://europepmc.org/articles/${encodeURIComponent(pmcid)}` : `https://europepmc.org/article/${encodeURIComponent(raw.source || 'MED')}/${encodeURIComponent(providerId || pmid)}`),
    pdfUrl: pdfUrl || undefined,
    openAccessPdfUrl: pdfUrl || undefined,
    europePmcUrl: htmlUrl || undefined,
    license: raw.license || undefined,
    citationCount: Number(raw.citedByCount) || 0,
    concepts: terms.map((term, index) => ({ id: `europepmc:${providerId || pmid}:${index}`, display_name: term, level: 2 })),
    categories: terms,
    keywords: terms,
    biomedicalTerms: terms,
    hasReferences: String(raw.hasReferences).toUpperCase() === 'Y',
    hasData: String(raw.hasData).toUpperCase() === 'Y',
    hasSupplement: String(raw.hasSuppl).toUpperCase() === 'Y',
    accessSource: hasOpenFullText ? 'europepmc' : undefined,
  });
  return withRequestedCategory(paper, requestedCategories, terms.join(' '));
}

export function mapCoreWork(raw, requestedCategories = []) {
  if (!raw?.id || !raw?.title) return null;
  const doi = normalizeDoi(raw.doi);
  const published = raw.publishedDate || raw.acceptedDate || raw.depositedDate || '';
  const downloadUrl = safeUrl(raw.downloadUrl);
  const displayUrl = safeUrl((raw.links || []).find(link => link?.type === 'display')?.url);
  const providerTerms = [raw.fieldOfStudy, raw.documentType].map(normalizeText).filter(Boolean);
  const paper = PaperBuilder.create({
    id: `core:${raw.id}`,
    doi: doi || undefined,
    arxivId: raw.arxivId || undefined,
    sources: { primary: 'core', enrichedBy: [] },
    title: normalizeText(raw.title),
    abstract: normalizeText(raw.abstract),
    authors: authorObjects(raw.authors),
    year: Number(raw.yearPublished) || safeYear(published),
    published,
    publisher: normalizeText(raw.publisher),
    journal: normalizeText(raw.journals?.[0]?.title),
    publicationType: /thesis/i.test(providerTerms.join(' ')) ? 'thesis' : 'article',
    publicationStatus: 'published',
    openAccess: Boolean(downloadUrl),
    pdfUrl: downloadUrl || undefined,
    landingPageUrl: displayUrl || (doi ? `https://doi.org/${doi}` : ''),
    citationCount: Number(raw.citationCount) || 0,
    concepts: providerTerms.map((term, index) => ({ id: `core:${raw.id}:${index}`, display_name: term, level: 2 })),
    categories: providerTerms,
    keywords: providerTerms,
  });
  return withRequestedCategory(paper, requestedCategories, providerTerms.join(' '));
}

export function mapOstiRecord(raw, requestedCategories = []) {
  if (!raw?.osti_id || !raw?.title) return null;
  const doi = normalizeDoi(raw.doi);
  const fullTextUrl = safeUrl((raw.links || []).find(link => link?.rel === 'fulltext')?.href);
  const landingPageUrl = safeUrl((raw.links || []).find(link => link?.rel === 'citation')?.href);
  const subjects = (raw.subjects || []).map(normalizeText).filter(Boolean);
  const paper = PaperBuilder.create({
    id: `osti:${raw.osti_id}`,
    doi: doi || undefined,
    sources: { primary: 'osti', enrichedBy: [] },
    title: normalizeText(raw.title),
    abstract: normalizeText(raw.description),
    authors: authorObjects(raw.authors),
    institutions: (raw.research_orgs || []).map(displayName => ({ displayName: normalizeText(displayName) })),
    year: safeYear(raw.publication_date),
    published: raw.publication_date || '',
    journal: normalizeText(raw.journal_name),
    publisher: normalizeText(raw.publisher),
    publicationType: /journal article/i.test(raw.product_type || '') ? 'article' : 'report',
    publicationStatus: 'published',
    openAccess: Boolean(fullTextUrl),
    pdfUrl: fullTextUrl || undefined,
    landingPageUrl: landingPageUrl || (doi ? `https://doi.org/${doi}` : ''),
    concepts: subjects.slice(0, 8).map((term, index) => ({ id: `osti:${raw.osti_id}:${index}`, display_name: term, level: 2 })),
    categories: subjects,
    keywords: subjects,
  });
  return withRequestedCategory(paper, requestedCategories, subjects.join(' '));
}

export function mapNasaRecord(raw, requestedCategories = []) {
  if (!raw?.id || !raw?.title) return null;
  const published = raw.publications?.[0]?.publicationDate || raw.distributionDate || raw.submittedDate || '';
  const download = (raw.downloads || []).find(item => item?.links?.pdf || item?.mimetype === 'application/pdf');
  const pdfPath = download?.links?.pdf || download?.links?.original || '';
  const pdfUrl = pdfPath ? safeUrl(new URL(pdfPath, 'https://ntrs.nasa.gov').toString()) : '';
  const terms = [...new Set([...(raw.subjectCategories || []), ...(raw.keywords || [])].map(normalizeText).filter(Boolean))];
  const paper = PaperBuilder.create({
    id: `nasa:${raw.id}`,
    sources: { primary: 'nasa-ntrs', enrichedBy: [] },
    title: normalizeText(raw.title),
    abstract: normalizeText(raw.abstract),
    authors: authorObjects((raw.authorAffiliations || []).map(item => item?.meta?.author)),
    institutions: (raw.authorAffiliations || [])
      .map(item => normalizeText(item?.meta?.organization?.name))
      .filter(Boolean)
      .map(displayName => ({ displayName })),
    year: safeYear(published),
    published,
    publisher: 'NASA',
    publicationType: raw.stiType === 'PREPRINT' ? 'preprint' : 'report',
    publicationStatus: raw.stiType === 'PREPRINT' ? 'preprint' : 'published',
    openAccess: Boolean(pdfUrl),
    pdfUrl: pdfUrl || undefined,
    landingPageUrl: `https://ntrs.nasa.gov/citations/${encodeURIComponent(raw.id)}`,
    concepts: terms.slice(0, 8).map((term, index) => ({ id: `nasa:${raw.id}:${index}`, display_name: term, level: 2 })),
    categories: terms,
    keywords: terms,
  });
  return withRequestedCategory(paper, requestedCategories, terms.join(' '));
}

async function fetchJson(path, params) {
  if (!PAPER_API_BASE) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = new URL(`${PAPER_API_BASE}${path}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    });
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function sourceQuery(categories) {
  return categories.map(categoryLabel).map(label => `"${label}"`).join(' OR ');
}

export function getDomainSourcePlan(categories = []) {
  const unique = [...new Set(categories)].filter(Boolean);
  const biology = unique.filter(category => category.startsWith('bio.'));
  const engineering = unique.filter(category => /^(?:eess|mech|civil|chemeng)\./.test(category));
  return {
    biology,
    engineering,
    biorxivCategory: biology.map(category => BIORXIV_CATEGORIES[category]).find(Boolean) || '',
    osti: engineering.filter(category => OSTI_CATEGORIES.has(category)),
    nasa: engineering.filter(category => NASA_CATEGORIES.has(category)),
  };
}

export async function fetchDomainPapers(categories, page = 1, limit = 8, queryMode = 'recent') {
  const plan = getDomainSourcePlan(categories);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 8));
  const requests = [];

  if (plan.biorxivCategory) {
    requests.push(fetchJson('/sources/biorxiv', {
      category: plan.biorxivCategory,
      page: safePage,
      limit: safeLimit,
    }).then(data => (data?.collection || []).slice(0, safeLimit).map(item => mapBioRxivPaper(item, plan.biology))));
  }

  if (plan.biology.length > 0) {
    requests.push(fetchJson('/sources/europepmc', {
      q: sourceQuery(plan.biology.slice(0, 3)),
      page: safePage,
      limit: safeLimit,
      sort: queryMode,
    }).then(data => (data?.resultList?.result || []).map(item => mapEuropePmcSearchResult(item, plan.biology))));
  }

  if (plan.engineering.length > 0) {
    requests.push(fetchJson('/sources/core', {
      q: sourceQuery(plan.engineering.slice(0, 4)),
      page: safePage,
      limit: safeLimit,
    }).then(data => (data?.results || []).map(item => mapCoreWork(item, plan.engineering))));
  }

  if (plan.osti.length > 0) {
    requests.push(fetchJson('/sources/osti', {
      q: sourceQuery(plan.osti.slice(0, 3)),
      page: safePage,
      limit: Math.min(6, safeLimit),
      sort: queryMode,
    }).then(data => (Array.isArray(data) ? data : []).map(item => mapOstiRecord(item, plan.osti))));
  }

  if (plan.nasa.length > 0) {
    requests.push(fetchJson('/sources/nasa', {
      q: sourceQuery(plan.nasa.slice(0, 3)),
      page: safePage,
      limit: Math.min(6, safeLimit),
      sort: queryMode,
    }).then(data => (data?.results || []).map(item => mapNasaRecord(item, plan.nasa))));
  }

  if (requests.length === 0) return [];
  const settled = await Promise.allSettled(requests);
  return PaperBuilder.deduplicate(
    settled.flatMap(result => result.status === 'fulfilled' ? result.value.filter(Boolean) : [])
  ).slice(0, safeLimit * 2);
}
