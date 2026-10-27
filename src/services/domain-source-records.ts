import type { Paper } from '../models/paper.ts';
import type { EuropePmcRecord } from '../utils/europe-pmc-record.ts';
import type { OpenReviewNote } from './open-review-service.ts';
import type { HuggingFaceRecord } from './hugging-face-records.ts';

type ProviderAuthor = string | { name?: string; fullName?: string } | undefined;
interface BioRxivRecord { doi?: string; title?: string; version?: string | number; category?: string; abstract?: string; authors?: string; date?: string; license?: string; }
interface BioRxivResponse { _papertok?: { degraded?: string }; collection?: BioRxivRecord[]; }
interface EuropePmcSearchRecord extends EuropePmcRecord {
  title?: string; doi?: string; firstPublicationDate?: string; electronicPublicationDate?: string; dateOfCreation?: string;
  source?: string; authorString?: string;
  journalInfo?: { journal?: { title?: string; issn?: string; essn?: string; nlmid?: string }; yearOfPublication?: number | string };
}
interface CoreWork {
  id?: string | number; title?: string; doi?: string; publishedDate?: string; acceptedDate?: string; depositedDate?: string;
  downloadUrl?: string; links?: Array<{ type?: string; url?: string }>; fieldOfStudy?: string; documentType?: string;
  arxivId?: string; abstract?: string; authors?: ProviderAuthor[]; yearPublished?: number | string; publisher?: string;
  journals?: Array<{ title?: string }>; citationCount?: number;
}
interface OstiRecord {
  osti_id?: string | number; title?: string; doi?: string; links?: Array<{ rel?: string; href?: string }>;
  subjects?: string[]; description?: string; authors?: ProviderAuthor[]; research_orgs?: string[]; publication_date?: string;
  journal_name?: string; publisher?: string; product_type?: string;
}
interface NasaRecord {
  id?: string | number; title?: string; publications?: Array<{ publicationDate?: string }>;
  distributionDate?: string; submittedDate?: string; downloads?: Array<{ links?: { pdf?: string; original?: string }; mimetype?: string }>;
  subjectCategories?: string[]; keywords?: string[]; abstract?: string;
  authorAffiliations?: Array<{ meta?: { author?: ProviderAuthor; organization?: { name?: string } } }>;
  stiType?: string;
}
interface AdsRecord {
  bibcode?: string; title?: string | string[]; doi?: string | string[]; identifier?: string | string[];
  property?: string[]; keyword?: string | string[]; arxiv_class?: string | string[];
  doctype?: string; esources?: string[]; citation_count?: number | string; pubdate?: string; year?: number | string;
  abstract?: string; author?: string[]; pub?: string; reference_count?: number; reference?: unknown[]; has_data?: boolean; data?: unknown[];
}
interface InspireRecord {
  metadata?: InspireRecord; control_number?: string | number; id?: string; titles?: Array<{ title?: string }>; title?: string;
  dois?: Array<{ value?: string }>; doi?: string; arxiv_eprints?: Array<{ value?: string }>;
  document_type?: string[]; publication_info?: Array<{ journal_title?: string; year?: number | string }>;
  documents?: Array<{ key?: string; url?: string }>; keywords?: Array<string | { value?: string }>;
  inspire_categories?: Array<string | { term?: string }>; primary_arxiv_category?: string[] | { value?: string };
  citation_count?: number | string; earliest_date?: string; imprints?: Array<{ date?: string }>;
  abstracts?: Array<{ value?: string }>; authors?: Array<{ full_name?: string; raw_name?: string }>; reference_count?: number; references?: unknown[];
}
interface PhysicsResponse { _papertok?: { source?: string }; response?: { docs?: AdsRecord[] }; hits?: { hits?: InspireRecord[] }; }

import { CATEGORIES } from '../data/category-taxonomy.ts';
import { PaperBuilder } from './paper-builder.ts';
import { isTechnicalClassification } from '../utils/scientific-classification.ts';
import { mapOpenReviewNote } from './open-review-service.ts';
import { mapHuggingFacePaper } from './hugging-face-records.ts';
import { mapEuropePmcRecord } from '../utils/europe-pmc-record.ts';
import { isAfterToday, isProtocolBookSeries } from '../utils/medline-record.ts';
import { normalizeScientificMarkup } from '../utils/latex.ts';

// The specialist sources' requests and records: which source answers which
// categories, what each is asked, and how its records become papers. Free of
// browser modules, so the Worker's paper store asks and maps exactly as the
// browser does (domain-source-service.ts sends the same requests live).

const BIORXIV_CATEGORIES: Record<string, string> = {
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

// The same table read back: the collection bioRxiv files a preprint in, as
// this app's category. Two categories ask for Ecology, which reads as its own.
const BIORXIV_COLLECTION_CATEGORIES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(BIORXIV_CATEGORIES).reverse().map(([categoryId, collection]) => [collection, categoryId]),
);

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

function isOpenReviewCategory(categoryId: string) {
  return /^(?:cs\.|stat\.(?:ML|CO)$|eess\.(?:IV|SY)$)/i.test(categoryId);
}

function isPhysicsCategory(categoryId: string) {
  return /^(?:astro-ph(?:\.|$)|cond-mat(?:\.|$)|gr-qc$|hep-|math-ph$|nucl-|physics\.|quant-ph$|nlin\.)/i.test(categoryId);
}

function normalizeText(value: unknown) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDoi(value: unknown) {
  return String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
}

function safeUrl(value: string | undefined) {
  try {
    const url = new URL(value!);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function safeYear(value: string | null | undefined) {
  if (!value) return undefined;
  const year = new Date(value).getUTCFullYear();
  return Number.isInteger(year) && year > 1800 ? year : undefined;
}

function categoryLabel(categoryId: string) {
  for (const area of Object.values(CATEGORIES)) {
    if (Object.hasOwn(area.subcategories, categoryId)) return area.subcategories[categoryId].label;
  }
  return categoryId.replace(/[.-]/g, ' ');
}

function authorObjects(values: ProviderAuthor[] | undefined) {
  return (values || [])
    .map(value => typeof value === 'string' ? value : value?.name || value?.fullName)
    .map(normalizeText)
    .filter(Boolean)
    .map(name => ({ name }));
}

export function mapBioRxivPaper(raw: BioRxivRecord, requestedCategories: string[] = []): Paper | null {
  const doi = normalizeDoi(raw?.doi);
  if (!doi || !raw?.title) return null;
  const version = String(raw.version || '1').replace(/\D/g, '') || '1';
  const category = normalizeText(raw.category);
  const categoryId = BIORXIV_COLLECTION_CATEGORIES[category.toLowerCase()] || '';
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
    primaryCategory: categoryId,
    categories: [categoryId, category].filter(Boolean),
    keywords: category ? [category] : [],
    _fetchedFor: requestedCategories,
  });
  return paper;
}

// The payload is read by `mapEuropePmcRecord`, shared with the enrichment path;
// what belongs here is the Paper built on top of it.
/**
 * The papers of a `/sources/biorxiv` answer. The Worker answers a bioRxiv
 * outage with an empty collection marked `_papertok.degraded` and caches it
 * briefly; that is a failure of the source, thrown so the feed's source-health
 * log reports it, never an honest "no preprints".
 */
export function readBioRxivResponse(data: BioRxivResponse | null, requestedCategories: string[] = [], limit = 8) {
  const degraded = data?._papertok?.degraded;
  if (degraded) {
    throw Object.assign(new Error(`Specialist source degraded: ${degraded}`), { code: degraded });
  }
  return (data?.collection || []).slice(0, limit).map(item => mapBioRxivPaper(item, requestedCategories));
}

export function mapEuropePmcSearchResult(raw: EuropePmcSearchRecord, requestedCategories: string[] = []): Paper | null {
  const record = mapEuropePmcRecord(raw);
  const { pmid, providerId } = record;
  if ((!providerId && !pmid) || !raw?.title) return null;
  const doi = normalizeDoi(raw.doi);
  const terms = record.terms.slice(0, 12);
  const date = raw.firstPublicationDate || raw.electronicPublicationDate || raw.dateOfCreation || '';
  // A date after today is a print date ahead (Methods in Molecular Biology
  // lists next year's volume). Neither that year nor another date is shown.
  const scheduled = isAfterToday(date || raw.journalInfo?.yearOfPublication);
  const published = scheduled ? '' : date;
  const journal = raw.journalInfo?.journal;
  const chapter = isProtocolBookSeries({ issn: journal?.issn, essn: journal?.essn, nlmId: journal?.nlmid });
  // PPR is Europe PMC's preprint source; PubMed also indexes NIH-funded
  // preprints, typed Preprint.
  const preprint = raw.source === 'PPR' || (raw.pubTypeList?.pubType || []).some(type => /^preprint$/i.test(type));
  const paper = PaperBuilder.create({
    id: pmid ? `pmid:${pmid}` : `europepmc:${raw.source || 'EPMC'}:${providerId}`,
    pmid: pmid || undefined,
    pmcid: record.pmcid || undefined,
    doi: doi || undefined,
    sources: { primary: 'europepmc', enrichedBy: [] },
    title: normalizeText(raw.title),
    abstract: record.abstract,
    authors: record.authors.length > 0
      ? record.authors
      : authorObjects(String(raw.authorString || '').split(',')),
    journal: normalizeText(journal?.title),
    year: scheduled ? undefined : safeYear(published || (raw.journalInfo?.yearOfPublication ? `${raw.journalInfo.yearOfPublication}-01-01` : undefined)),
    published,
    // `book-series` is a venue `isFeedPublication` leaves out of the feed.
    publicationType: chapter ? 'book-chapter' : preprint ? 'preprint' : 'article',
    sourceType: chapter ? 'book-series' : undefined,
    publicationStatus: record.retracted ? 'retracted' : preprint ? 'preprint' : 'published',
    openAccess: record.openAccess,
    landingPageUrl: record.europePmcUrl
      || `https://europepmc.org/article/${encodeURIComponent(raw.source || 'MED')}/${encodeURIComponent(providerId || pmid)}`,
    pdfUrl: record.pdfUrl || undefined,
    openAccessPdfUrl: record.pdfUrl || undefined,
    europePmcUrl: record.htmlUrl || undefined,
    license: record.license,
    citationCount: record.citationCount,
    concepts: terms.map((term, index) => ({ id: `europepmc:${providerId || pmid}:${index}`, display_name: term, level: 2 })),
    // MeSH headings and author keywords stay terms. Read as this app's labels
    // they would file a maize root study (PMID 42814353) as Machine Learning.
    categories: terms,
    keywords: terms,
    biomedicalTerms: terms,
    hasReferences: record.hasReferences,
    hasData: record.hasData,
    hasSupplement: record.hasSupplement,
    accessSource: record.openAccess ? 'europepmc' : undefined,
    _fetchedFor: requestedCategories,
  });
  return paper;
}

export function mapCoreWork(raw: CoreWork, requestedCategories: string[] = []): Paper | null {
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
    _fetchedFor: requestedCategories,
  });
  return paper;
}

export function mapOstiRecord(raw: OstiRecord, requestedCategories: string[] = []): Paper | null {
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
    _fetchedFor: requestedCategories,
  });
  return paper;
}

export function mapNasaRecord(raw: NasaRecord, requestedCategories: string[] = []): Paper | null {
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
    _fetchedFor: requestedCategories,
  });
  return paper;
}

function extractAdsArxivId(raw: AdsRecord) {
  const identifiers = Array.isArray(raw?.identifier) ? raw.identifier : [raw?.identifier];
  for (const value of identifiers) {
    const match = String(value || '').match(/(?:arxiv:|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}|[a-z][a-z.-]+\/\d{7})(?:v\d+)?/i);
    if (match) return match[1];
  }
  return '';
}

export function mapAdsPaper(raw: AdsRecord, requestedCategories: string[] = []): Paper | null {
  const bibcode = normalizeText(raw?.bibcode);
  // ADS markup means something: `<tex-math>` carries a formula and
  // `<SUB>`/`<SUP>` are scripts, some of them inside that formula. Flattening
  // every tag to a space erased them before anything could read them
  // (`T<SUB>c</SUB>` became `T c`), so title and abstract go through the
  // markup-aware normalizer instead.
  const title = normalizeScientificMarkup(Array.isArray(raw?.title) ? raw.title[0] : raw?.title);
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
  // `arxiv_class` is arXiv's classification as ADS copies it: it leads the
  // terms, and its first class files the paper.
  const terms = [...new Set([
    ...arxivCategories,
    ...rawKeywords.filter(keyword => !isTechnicalClassification(keyword)),
  ])].slice(0, 12);
  const keywords = [...new Set([...rawKeywords, ...arxivCategories])].slice(0, 20);
  const refereed = properties.includes('REFEREED');
  const isPreprint = String(raw.doctype || '').toLowerCase() === 'eprint' && !refereed;
  const openAccess = Boolean(arxivId)
    || properties.some(value => value.includes('OPENACCESS'))
    || (raw.esources || []).some(value => /eprint_pdf|openaccess/i.test(value));
  const citationCount = Number(raw.citation_count);
  // ADS writes an unknown day or month as 00 (2018-03-00), which no date
  // parser reads; the month or year it names stays, read as its first day.
  const published = normalizeText(raw.pubdate).replace(/(?:-00)+$/, '') || (Number(raw.year) ? `${Number(raw.year)}-01-01` : '');
  const paper = PaperBuilder.create({
    id: `ads:${bibcode}`,
    doi: doi || undefined,
    arxivId: arxivId || undefined,
    adsBibcode: bibcode,
    adsUrl: `https://ui.adsabs.harvard.edu/abs/${encodeURIComponent(bibcode)}/abstract`,
    sources: { primary: 'nasa-ads', enrichedBy: [] },
    title,
    abstract: normalizeScientificMarkup(raw.abstract!),
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
    primaryCategory: arxivCategories[0],
    categories: terms,
    keywords,
    hasReferences: (Number(raw.reference_count) || raw.reference?.length || 0) > 0,
    hasData: Boolean(raw.has_data || (Array.isArray(raw.data) && raw.data.length > 0)),
    provider: 'nasa-ads',
    _fetchedFor: requestedCategories,
  });
  return paper;
}

export function mapInspirePaper(hit: InspireRecord, requestedCategories: string[] = []): Paper | null {
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
  // INSPIRE names the arXiv primary outright; it files the paper and leads the terms.
  const [primaryArxivCategory = ''] = (Array.isArray(raw.primary_arxiv_category)
    ? raw.primary_arxiv_category
    : [raw.primary_arxiv_category?.value]).map(normalizeText).filter(Boolean);
  const terms = [...new Set([
    primaryArxivCategory,
    ...(raw.keywords || []).map(keyword => (keyword as { value?: string })?.value || keyword),
    ...(raw.inspire_categories || []).map(category => (category as { term?: string })?.term || category),
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
    year: Number(String(published).slice(0, 4)) || undefined,
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
    primaryCategory: primaryArxivCategory,
    categories: terms,
    keywords: terms,
    hasReferences: (Number(raw.reference_count) || raw.references?.length || 0) > 0,
    provider: 'inspire',
    _fetchedFor: requestedCategories,
  });
  return paper;
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
export const PROTECTED_SOURCE_PATHS = Object.freeze(new Set<string>([
  DOMAIN_SOURCE_PATHS.core,
  DOMAIN_SOURCE_PATHS.physics,
  DOMAIN_SOURCE_PATHS.scopus,
]));

export function sourceQuery(categories: readonly string[]) {
  return categories.map(categoryLabel).map(label => `"${label}"`).join(' OR ');
}

/**
 * The Europe PMC query for a reader's biology categories. Each label is
 * searched in title, abstract and keywords: in every field `"Molecular
 * Biology"` also matched the journal Methods in Molecular Biology. Only records
 * first published by today (UTC) come back, so a recent-first page is not
 * filled with chapters printed next year.
 */
export function europePmcQuery(categories: readonly string[]) {
  const today = new Date().toISOString().slice(0, 10);
  return `${europePmcLabelQuery(categories)} AND FIRST_PDATE:[1800-01-01 TO ${today}]`;
}

/** The categories' labels where a paper states its subject: title, abstract and keywords. */
export function europePmcLabelQuery(categories: readonly string[]) {
  const labels = categories.map(categoryLabel).map(label => `TITLE_ABS:"${label}" OR KW:"${label}"`);
  return `(${labels.join(' OR ')})`;
}

export function getDomainSourcePlan(categories: readonly string[] = []) {
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
export function getEligibleDomainSources(plan: ReturnType<typeof getDomainSourcePlan>, { hasSession = false, scopusEnabled = false } = {}) {
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

type DomainSourceKey = Exclude<keyof typeof DOMAIN_SOURCE_PATHS, 'scopus'>;
export interface DomainSourceRequest {
  source: DomainSourceKey;
  path: string;
  params: Record<string, string | number>;
  read: (data: unknown) => Array<Paper | null>;
}

/**
 * The request each eligible source answers for one page of the plan, and how
 * its answer becomes papers. The browser sends these to the Worker's
 * `/sources/*` routes; the Worker's paper store issues the same ones once a day.
 * Scopus is not here: its adapter builds its own query.
 */
export function domainSourceRequests(
  plan: ReturnType<typeof getDomainSourcePlan>,
  eligible: ReturnType<typeof getEligibleDomainSources>,
  page: number,
  limit: number,
  queryMode: string,
): DomainSourceRequest[] {
  const requests: DomainSourceRequest[] = [];
  const request = (source: DomainSourceKey, params: DomainSourceRequest['params'], read: DomainSourceRequest['read']) => (
    requests.push({ source, path: DOMAIN_SOURCE_PATHS[source], params, read })
  );

  if (eligible.biorxiv) {
    request('biorxiv', { category: plan.biorxivCategory, page, limit }, data => readBioRxivResponse(data as BioRxivResponse | null, plan.biology, limit));
  }

  if (eligible.europepmc) {
    request('europepmc', { q: europePmcQuery(plan.biology.slice(0, 3)), page, limit, sort: queryMode }, data => (
      ((data as { resultList?: { result?: EuropePmcSearchRecord[] } } | null)?.resultList?.result || []).map(item => mapEuropePmcSearchResult(item, plan.biology))
    ));
  }

  if (eligible.core) {
    request('core', { q: sourceQuery(plan.engineering.slice(0, 4)), page, limit }, data => (
      ((data as { results?: CoreWork[] } | null)?.results || []).map(item => mapCoreWork(item, plan.engineering))
    ));
  }

  if (eligible.osti) {
    request('osti', { q: sourceQuery(plan.osti.slice(0, 3)), page, limit: Math.min(6, limit), sort: queryMode }, data => (
      (Array.isArray(data) ? data as OstiRecord[] : []).map(item => mapOstiRecord(item, plan.osti))
    ));
  }

  if (eligible.nasa) {
    request('nasa', { q: sourceQuery(plan.nasa.slice(0, 3)), page, limit: Math.min(6, limit), sort: queryMode }, data => (
      ((data as { results?: NasaRecord[] } | null)?.results || []).map(item => mapNasaRecord(item, plan.nasa))
    ));
  }

  if (eligible.physics) {
    request('physics', {
      q: sourceQuery(plan.physics.slice(0, 4)),
      fallback_q: plan.inspirePhysics.length > 0 ? sourceQuery(plan.inspirePhysics.slice(0, 4)) : '',
      page,
      limit,
      sort: queryMode,
    }, (raw) => {
      const data = raw as PhysicsResponse | null;
      if (data?._papertok?.source === 'nasa-ads') {
        return (data?.response?.docs || []).map(item => mapAdsPaper(item, plan.physics));
      }
      return (data?.hits?.hits || []).map(item => mapInspirePaper(item, plan.physics));
    });
  }

  if (eligible.openreview) {
    const selectedCategory = plan.openReview[(page - 1) % plan.openReview.length];
    request('openreview', { q: categoryLabel(selectedCategory), page, limit, sort: queryMode }, data => (
      ((data as { notes?: OpenReviewNote[] } | null)?.notes || []).map(item => mapOpenReviewNote(item, [selectedCategory]))
    ));
  }

  if (eligible.huggingface) {
    const selectedCategory = plan.huggingFace[(page - 1) % plan.huggingFace.length];
    request('huggingface', { q: categoryLabel(selectedCategory), page, limit, sort: queryMode }, data => (
      ((data as { papers?: HuggingFaceRecord[] } | null)?.papers || []).map(item => mapHuggingFacePaper(item, [selectedCategory]))
    ));
  }

  return requests;
}
