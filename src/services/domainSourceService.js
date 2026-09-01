import { CATEGORIES } from '../data/categories.js';
import { PaperBuilder } from './PaperBuilder.js';
import { isScopusEnabled, ScopusAdapter } from './adapters/ScopusAdapter.js';
import { isTechnicalClassification } from '../utils/scientificClassification.js';
import { mapOpenReviewNote } from './openReviewService.js';
import { mapHuggingFacePaper } from './huggingFaceService.js';
import { authenticatedWorkerFetch, hasWorkerSession } from './workerApiClient.js';
import { withRequestDeadline } from '../utils/requestDeadline.js';
import { settleWithin } from '../utils/asyncTiming.js';
import { mapEuropePmcRecord } from '../utils/europePmcRecord.js';

const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const REQUEST_TIMEOUT_MS = 10_000;
// Per source, and deliberately under the 4 s render budget every caller wraps
// this whole branch in: the inner cut has to win that race, or the outer one
// discards the sources that already answered along with the one that stalled.
// It matches `OPTIONAL_SOURCE_RENDER_BUDGET_MS` in the feed for the same reason.
const DOMAIN_SOURCE_BUDGET_MS = 3_500;

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

const INSPIRE_PHYSICS_CATEGORIES = new Set([
  'hep-th',
  'hep-ph',
  'hep-ex',
  'hep-lat',
  'gr-qc',
  'nucl-th',
  'nucl-ex',
  'astro-ph.HE',
]);

const HUGGING_FACE_CATEGORIES = new Set([
  'cs.AI',
  'cs.CL',
  'cs.CV',
  'cs.IR',
  'cs.LG',
  'cs.MM',
  'cs.NE',
  'cs.RO',
  'cs.SD',
  'stat.ML',
  'eess.IV',
  'bio.comp',
]);

function isOpenReviewCategory(categoryId) {
  return /^(?:cs\.|stat\.(?:ML|CO)$|eess\.(?:IV|SY)$)/i.test(categoryId);
}

function isPhysicsCategory(categoryId) {
  return /^(?:astro-ph(?:\.|$)|cond-mat(?:\.|$)|gr-qc$|hep-|math-ph$|nucl-|physics\.|quant-ph$|nlin\.)/i.test(categoryId);
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

// The payload is read by `mapEuropePmcRecord`, shared with the enrichment path;
// what belongs here is the Paper built on top of it.
export function mapEuropePmcSearchResult(raw, requestedCategories = []) {
  const record = mapEuropePmcRecord(raw);
  const { pmid, providerId } = record;
  if ((!providerId && !pmid) || !raw?.title) return null;
  const doi = normalizeDoi(raw.doi);
  const terms = record.terms.slice(0, 12);
  const published = raw.firstPublicationDate || raw.electronicPublicationDate || raw.dateOfCreation || '';
  const paper = PaperBuilder.create({
    id: pmid ? `pmid:${pmid}` : `europepmc:${raw.source || 'EPMC'}:${providerId}`,
    pmid: pmid || undefined,
    pmcid: record.pmcid || undefined,
    doi: doi || undefined,
    sources: { primary: 'europepmc', enrichedBy: [] },
    title: normalizeText(raw.title),
    abstract: record.abstract,
    authors: authorObjects(raw.authorList?.author || String(raw.authorString || '').split(',')),
    journal: normalizeText(raw.journalInfo?.journal?.title),
    year: safeYear(published || `${raw.journalInfo?.yearOfPublication || ''}-01-01`),
    published,
    publicationType: 'article',
    publicationStatus: 'published',
    openAccess: record.openAccess,
    landingPageUrl: record.europePmcUrl
      || `https://europepmc.org/article/${encodeURIComponent(raw.source || 'MED')}/${encodeURIComponent(providerId || pmid)}`,
    pdfUrl: record.pdfUrl || undefined,
    openAccessPdfUrl: record.pdfUrl || undefined,
    europePmcUrl: record.htmlUrl || undefined,
    license: record.license,
    citationCount: record.citationCount,
    concepts: terms.map((term, index) => ({ id: `europepmc:${providerId || pmid}:${index}`, display_name: term, level: 2 })),
    categories: terms,
    keywords: terms,
    biomedicalTerms: terms,
    hasReferences: record.hasReferences,
    hasData: record.hasData,
    hasSupplement: record.hasSupplement,
    accessSource: record.openAccess ? 'europepmc' : undefined,
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

function extractAdsArxivId(raw) {
  const identifiers = Array.isArray(raw?.identifier) ? raw.identifier : [raw?.identifier];
  for (const value of identifiers) {
    const match = String(value || '').match(/(?:arxiv:|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}|[a-z][a-z.-]+\/\d{7})(?:v\d+)?/i);
    if (match) return match[1];
  }
  return '';
}

export function mapAdsPaper(raw, requestedCategories = []) {
  const bibcode = normalizeText(raw?.bibcode);
  const title = normalizeText(Array.isArray(raw?.title) ? raw.title[0] : raw?.title);
  if (!bibcode || !title) return null;
  const doi = normalizeDoi(Array.isArray(raw.doi) ? raw.doi[0] : raw.doi);
  const arxivId = extractAdsArxivId(raw);
  const properties = (raw.property || []).map(value => String(value).toUpperCase());
  const rawKeywords = (Array.isArray(raw.keyword) ? raw.keyword : [raw.keyword])
    .map(normalizeText)
    .filter(Boolean);
  const arxivCategories = (Array.isArray(raw.arxiv_class) ? raw.arxiv_class : [raw.arxiv_class])
    .map(normalizeText)
    .filter(Boolean);
  const terms = [...new Set([
    ...rawKeywords.filter(keyword => !isTechnicalClassification(keyword)),
    ...arxivCategories,
  ])].slice(0, 12);
  const keywords = [...new Set([...rawKeywords, ...arxivCategories])].slice(0, 20);
  const refereed = properties.includes('REFEREED');
  const isPreprint = String(raw.doctype || '').toLowerCase() === 'eprint' && !refereed;
  const openAccess = Boolean(arxivId)
    || properties.some(value => value.includes('OPENACCESS'))
    || (raw.esources || []).some(value => /eprint_pdf|openaccess/i.test(value));
  const citationCount = Number(raw.citation_count);
  const published = normalizeText(raw.pubdate) || `${Number(raw.year) || new Date().getUTCFullYear()}-01-01`;
  const paper = PaperBuilder.create({
    id: `ads:${bibcode}`,
    doi: doi || undefined,
    arxivId: arxivId || undefined,
    adsBibcode: bibcode,
    adsUrl: `https://ui.adsabs.harvard.edu/abs/${encodeURIComponent(bibcode)}/abstract`,
    sources: { primary: 'nasa-ads', enrichedBy: [] },
    title,
    abstract: normalizeText(raw.abstract),
    authors: authorObjects(raw.author),
    year: Number(raw.year) || safeYear(published),
    published,
    journal: normalizeText(raw.pub),
    publicationType: isPreprint ? 'preprint' : normalizeText(raw.doctype) || 'article',
    publicationStatus: isPreprint ? 'preprint' : 'published',
    peerReviewed: refereed,
    openAccess,
    pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined,
    landingPageUrl: `https://ui.adsabs.harvard.edu/abs/${encodeURIComponent(bibcode)}/abstract`,
    citationCount: Number.isFinite(citationCount) ? citationCount : 0,
    citationCountKnown: Number.isFinite(citationCount),
    referenceCount: Number(raw.reference_count) || (Array.isArray(raw.reference) ? raw.reference.length : 0),
    concepts: terms.map((term, index) => ({ id: `ads:${bibcode}:term:${index}`, display_name: term, level: 2 })),
    categories: terms,
    keywords,
    hasReferences: (Number(raw.reference_count) || raw.reference?.length || 0) > 0,
    hasData: Boolean(raw.has_data || (Array.isArray(raw.data) && raw.data.length > 0)),
    provider: 'nasa-ads',
  });
  return withRequestedCategory(paper, requestedCategories, terms.join(' '));
}

export function mapInspirePaper(hit, requestedCategories = []) {
  const raw = hit?.metadata || hit;
  const controlNumber = String(raw?.control_number || hit?.id || '').trim();
  const title = normalizeText(raw?.titles?.[0]?.title || raw?.title);
  if (!controlNumber || !title) return null;
  const doi = normalizeDoi(raw.dois?.[0]?.value || raw.doi);
  const arxivId = normalizeText(raw.arxiv_eprints?.[0]?.value).replace(/v\d+$/i, '');
  const documentTypes = (raw.document_type || []).map(value => String(value).toLowerCase());
  const journal = normalizeText(raw.publication_info?.[0]?.journal_title);
  const isPublished = Boolean(journal || doi) && !documentTypes.includes('thesis');
  const documents = Array.isArray(raw.documents) ? raw.documents : [];
  const pdfUrl = safeUrl(documents.find(document => /pdf/i.test(document?.key || document?.url || ''))?.url);
  const terms = [...new Set([
    ...(raw.keywords || []).map(keyword => keyword?.value || keyword),
    ...(raw.inspire_categories || []).map(category => category?.term || category),
    ...(Array.isArray(raw.primary_arxiv_category)
      ? raw.primary_arxiv_category
      : [raw.primary_arxiv_category?.value]),
  ].map(normalizeText).filter(Boolean))].slice(0, 12);
  const citationCount = Number(raw.citation_count);
  const published = normalizeText(raw.earliest_date || raw.imprints?.[0]?.date || raw.publication_info?.[0]?.year);
  const paper = PaperBuilder.create({
    id: `inspire:${controlNumber}`,
    doi: doi || undefined,
    arxivId: arxivId || undefined,
    inspireId: controlNumber,
    inspireUrl: `https://inspirehep.net/literature/${encodeURIComponent(controlNumber)}`,
    sources: { primary: 'inspire', enrichedBy: [] },
    title,
    abstract: normalizeText(raw.abstracts?.[0]?.value),
    authors: authorObjects(raw.authors?.map(author => author?.full_name || author?.raw_name)),
    year: Number(String(published).slice(0, 4)) || new Date().getUTCFullYear(),
    published,
    journal,
    publicationType: documentTypes[0] || (isPublished ? 'article' : 'preprint'),
    publicationStatus: isPublished ? 'published' : 'preprint',
    peerReviewed: isPublished,
    openAccess: Boolean(pdfUrl || arxivId),
    pdfUrl: pdfUrl || (arxivId ? `https://arxiv.org/pdf/${arxivId}` : undefined),
    landingPageUrl: `https://inspirehep.net/literature/${encodeURIComponent(controlNumber)}`,
    citationCount: Number.isFinite(citationCount) ? citationCount : 0,
    citationCountKnown: Number.isFinite(citationCount),
    referenceCount: Number(raw.reference_count) || (Array.isArray(raw.references) ? raw.references.length : 0),
    concepts: terms.map((term, index) => ({ id: `inspire:${controlNumber}:term:${index}`, display_name: term, level: 2 })),
    categories: terms,
    keywords: terms,
    hasReferences: (Number(raw.reference_count) || raw.references?.length || 0) > 0,
    provider: 'inspire',
  });
  return withRequestedCategory(paper, requestedCategories, terms.join(' '));
}

// The Worker guards these three with an ID token; the client has to know which
// they are before it decides to spend a request on one.
export const DOMAIN_SOURCE_PATHS = Object.freeze({
  scopus: '/sources/scopus',
  biorxiv: '/sources/biorxiv',
  europepmc: '/sources/europepmc',
  core: '/sources/core',
  osti: '/sources/osti',
  nasa: '/sources/nasa',
  physics: '/sources/physics',
  openreview: '/sources/openreview',
  huggingface: '/sources/huggingface',
});
export const PROTECTED_SOURCE_PATHS = Object.freeze(new Set([
  DOMAIN_SOURCE_PATHS.core,
  DOMAIN_SOURCE_PATHS.physics,
  DOMAIN_SOURCE_PATHS.scopus,
]));

/**
 * The error a source route's refusal becomes.
 *
 * The Worker answers a failed upstream with a body -- `code` for a refusal or a
 * stall, `upstreamStatus` for the code the upstream itself returned -- and
 * `${path} returned 502` threw all of it away. A 400 we caused and an outage they
 * had reached the console as the same line; NCBI's 429 and the ledger's too. The
 * body travels on the error instead, where `reportDomainSourceFailures` already
 * looks for `code`, and the message carries it for anyone reading a log.
 */
export function sourceResponseError(path, status, body = null) {
  const code = typeof body?.code === 'string' ? body.code : '';
  const upstreamStatus = Number.isInteger(body?.upstreamStatus) ? body.upstreamStatus : 0;
  const detail = [code, upstreamStatus ? `upstream ${upstreamStatus}` : ''].filter(Boolean).join(', ');
  const error = new Error(`${path} returned ${status}${detail ? ` (${detail})` : ''}`);
  error.status = status;
  if (code) error.code = code;
  if (upstreamStatus) error.upstreamStatus = upstreamStatus;
  return error;
}

async function fetchJson(path, params) {
  if (!PAPER_API_BASE) return null;
  const url = new URL(`${PAPER_API_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  // One deadline for headers and body alike. These calls run inside the
  // `Promise.allSettled` of `fetchDomainPapers`, so a single source that answers
  // its headers and then stops used to hold the whole feed behind it.
  const options = withRequestDeadline({ headers: { accept: 'application/json' } }, REQUEST_TIMEOUT_MS);
  const response = PROTECTED_SOURCE_PATHS.has(path)
    ? await authenticatedWorkerFetch(url, options)
    : await fetch(url, options);
  if (!response.ok) {
    // Read under the same deadline as the headers (`withRequestDeadline` keeps
    // the signal armed for the body); a body that is not JSON is simply no body.
    const body = await response.json().catch(() => null);
    throw sourceResponseError(path, response.status, body);
  }
  return response.json();
}

function sourceQuery(categories) {
  return categories.map(categoryLabel).map(label => `"${label}"`).join(' OR ');
}

export function getDomainSourcePlan(categories = []) {
  const unique = [...new Set(categories)].filter(Boolean);
  const biology = unique.filter(category => category.startsWith('bio.'));
  const engineering = unique.filter(category => /^(?:eess|mech|civil|chemeng)\./.test(category));
  const physics = unique.filter(isPhysicsCategory);
  return {
    biology,
    engineering,
    physics,
    inspirePhysics: physics.filter(category => INSPIRE_PHYSICS_CATEGORIES.has(category)),
    scopus: [...new Set([...biology, ...engineering])],
    biorxivCategory: biology.map(category => BIORXIV_CATEGORIES[category]).find(Boolean) || '',
    osti: engineering.filter(category => OSTI_CATEGORIES.has(category)),
    nasa: engineering.filter(category => NASA_CATEGORIES.has(category)),
    openReview: unique.filter(isOpenReviewCategory),
    huggingFace: unique.filter(category => HUGGING_FACE_CATEGORIES.has(category)),
  };
}

// Which branches of the plan may actually issue a request right now. A branch
// that cannot succeed must not run: the three protected paths need an ID token,
// and without one `authenticatedWorkerFetch` throws inside the browser, the
// `allSettled` below swallows it, and a source that never had a chance is
// indistinguishable from one with no results. That is how every guest load
// asked for physics it was never going to be shown.
//
// `isScopusEnabled()` already refuses without a session, so the `hasSession`
// term on Scopus is redundant at run time -- it is here so the rule reads the
// same for all three, and so a test can hold the whole invariant at once.
export function getEligibleDomainSources(plan, { hasSession = false, scopusEnabled = false } = {}) {
  return {
    scopus: plan.scopus.length > 0 && scopusEnabled && hasSession,
    biorxiv: Boolean(plan.biorxivCategory),
    europepmc: plan.biology.length > 0,
    core: plan.engineering.length > 0 && hasSession,
    osti: plan.osti.length > 0,
    nasa: plan.nasa.length > 0,
    physics: plan.physics.length > 0 && hasSession,
    openreview: plan.openReview.length > 0,
    huggingface: plan.huggingFace.length > 0,
  };
}

// `Promise.allSettled` used to drop its rejections on the floor, so a systematic
// 401, a quota 429 and a source that is simply down all reached the feed as the
// same thing: nothing. It is what kept the failing physics branch invisible.
export function reportDomainSourceFailures(settled, entries, logger = console.warn) {
  settled.forEach((result, index) => {
    const path = entries[index]?.path || 'unknown';
    // A source cut at its budget is not a rejection and used to leave no trace at
    // all -- the same silence that once hid the failing physics branch, in the
    // one shape `allSettled` cannot produce.
    if (result.status === 'timed_out') {
      logger(`Domain source ${path} failed: timed out`);
      return;
    }
    if (result.status !== 'rejected') return;
    const reason = result.reason;
    // `code` first (it is the discriminant: UPSTREAM_RATE_LIMITED vs
    // PROVIDER_RATE_LIMITED vs UPSTREAM_TIMEOUT), then the message, which since
    // `sourceResponseError` carries the upstream status. The bare status came
    // before the message here, and hid exactly that detail.
    const detail = reason?.code || reason?.message || reason?.status || String(reason);
    logger(`Domain source ${path} failed: ${detail}`, reason);
  });
}

/**
 * Settles every domain source under its own budget instead of one shared with
 * the slowest of them. `Promise.allSettled` resolves only when its last member
 * does, and each caller then wraps this branch in a single render budget -- so
 * an upstream that stalls past that budget used to take the papers its siblings
 * had already returned down with it. bioRxiv hangs outright on about a quarter
 * of calls (measured 2026-09-01), which made that the common case, not the edge.
 */
export async function settleDomainSources(requests, sourceBudgetMs = DOMAIN_SOURCE_BUDGET_MS, logger = console.warn) {
  const settled = await Promise.all(
    requests.map(entry => settleWithin(entry.promise, sourceBudgetMs)),
  );
  reportDomainSourceFailures(settled, requests, logger);
  return settled;
}

export async function fetchDomainPapers(categories, page = 1, limit = 8, queryMode = 'recent', { sourceBudgetMs = DOMAIN_SOURCE_BUDGET_MS } = {}) {
  const plan = getDomainSourcePlan(categories);
  const eligible = getEligibleDomainSources(plan, {
    hasSession: hasWorkerSession(),
    scopusEnabled: isScopusEnabled(),
  });
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 8));
  const requests = [];
  const request = (path, promise) => requests.push({ path, promise });

  if (eligible.scopus) {
    const scopusAdapter = new ScopusAdapter();
    request(DOMAIN_SOURCE_PATHS.scopus, scopusAdapter.search(sourceQuery(plan.scopus.slice(0, 4)), safePage, {
      internalCategories: plan.scopus,
      limit: safeLimit,
      sort: queryMode,
    }).then(result => result.papers || []));
  }

  if (eligible.biorxiv) {
    request(DOMAIN_SOURCE_PATHS.biorxiv, fetchJson('/sources/biorxiv', {
      category: plan.biorxivCategory,
      page: safePage,
      limit: safeLimit,
    }).then(data => (data?.collection || []).slice(0, safeLimit).map(item => mapBioRxivPaper(item, plan.biology))));
  }

  if (eligible.europepmc) {
    request(DOMAIN_SOURCE_PATHS.europepmc, fetchJson('/sources/europepmc', {
      q: sourceQuery(plan.biology.slice(0, 3)),
      page: safePage,
      limit: safeLimit,
      sort: queryMode,
    }).then(data => (data?.resultList?.result || []).map(item => mapEuropePmcSearchResult(item, plan.biology))));
  }

  if (eligible.core) {
    request(DOMAIN_SOURCE_PATHS.core, fetchJson('/sources/core', {
      q: sourceQuery(plan.engineering.slice(0, 4)),
      page: safePage,
      limit: safeLimit,
    }).then(data => (data?.results || []).map(item => mapCoreWork(item, plan.engineering))));
  }

  if (eligible.osti) {
    request(DOMAIN_SOURCE_PATHS.osti, fetchJson('/sources/osti', {
      q: sourceQuery(plan.osti.slice(0, 3)),
      page: safePage,
      limit: Math.min(6, safeLimit),
      sort: queryMode,
    }).then(data => (Array.isArray(data) ? data : []).map(item => mapOstiRecord(item, plan.osti))));
  }

  if (eligible.nasa) {
    request(DOMAIN_SOURCE_PATHS.nasa, fetchJson('/sources/nasa', {
      q: sourceQuery(plan.nasa.slice(0, 3)),
      page: safePage,
      limit: Math.min(6, safeLimit),
      sort: queryMode,
    }).then(data => (data?.results || []).map(item => mapNasaRecord(item, plan.nasa))));
  }

  if (eligible.physics) {
    request(DOMAIN_SOURCE_PATHS.physics, fetchJson('/sources/physics', {
      q: sourceQuery(plan.physics.slice(0, 4)),
      fallback_q: plan.inspirePhysics.length > 0 ? sourceQuery(plan.inspirePhysics.slice(0, 4)) : '',
      page: safePage,
      limit: safeLimit,
      sort: queryMode,
    }).then(data => {
      const source = data?._papertok?.source;
      if (source === 'nasa-ads') {
        return (data?.response?.docs || []).map(item => mapAdsPaper(item, plan.physics));
      }
      return (data?.hits?.hits || []).map(item => mapInspirePaper(item, plan.physics));
    }));
  }

  if (eligible.openreview) {
    const selectedCategory = plan.openReview[(safePage - 1) % plan.openReview.length];
    request(DOMAIN_SOURCE_PATHS.openreview, fetchJson('/sources/openreview', {
      q: categoryLabel(selectedCategory),
      page: safePage,
      limit: safeLimit,
      sort: queryMode,
    }).then(data => (data?.notes || []).map(item => mapOpenReviewNote(item, [selectedCategory]))));
  }

  if (eligible.huggingface) {
    const selectedCategory = plan.huggingFace[(safePage - 1) % plan.huggingFace.length];
    request(DOMAIN_SOURCE_PATHS.huggingface, fetchJson('/sources/huggingface', {
      q: categoryLabel(selectedCategory),
      page: safePage,
      limit: safeLimit,
      sort: queryMode,
    }).then(data => (data?.papers || []).map(item => mapHuggingFacePaper(item, [selectedCategory]))));
  }

  if (requests.length === 0) return [];
  const settled = await settleDomainSources(requests, sourceBudgetMs);
  return PaperBuilder.deduplicate(
    settled.flatMap(result => result.status === 'fulfilled' ? result.value.filter(Boolean) : [])
  ).slice(0, safeLimit * 2);
}
