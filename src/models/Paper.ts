import { getArxivArchiveArea } from '../data/categoryTaxonomy.ts';

export interface PaperAuthor {
  name: string;
  id?: string | null;
  orcid?: string;
  fullName?: string;
  affiliation?: string | null;
}

export interface PaperSources {
  primary: string;
  enrichedBy: string[];
  // Written and read only by `PaperBuilder.merge`: the row's answer comes
  // from an arXiv record whose `true` rested on a DOI alone, the record the
  // row began as or one it took its answer from, and no record merged since
  // under the row's DOI (any record, when that DOI is arXiv's own) has said
  // the paper was reviewed on more than such a DOI.
  arxivDoiOnly?: true;
  // Written and read only by `PaperBuilder.merge`: a published record the row
  // is not, such as a working paper on the same eprint, said the paper was
  // not reviewed. A `true` that rests on an arXiv DOI alone then reads
  // unknown, whether it reached the row before that record or after it.
  deniedElsewhere?: true;
  // Written and read only by `PaperBuilder.merge`: by normalized publisher
  // DOI, what a merged record said of itself under it, whatever the row's own
  // answer and the DOI it shows: `true` on more than an arXiv DOI, or an
  // outright `false`, which stands against any `true` under that DOI. A row
  // under one of these DOIs that merges this one reads it as that record's
  // answer.
  peerReviewedByDoi?: Record<string, boolean>;
  // Written and read only by `PaperBuilder.merge`: `peerReviewedByDoi` holds
  // the answer of every record merged into the row. A merged row without it,
  // such as one merged before the map existed, can lack a record's `false`,
  // so a merge with it neither confirms review from a map's `true` nor keeps
  // a row's `true` the way a merge of complete rows does. Code from before
  // the map keeps this mark on a row it merges but files no answer, so a row
  // it merged after the mark was written still reads complete; after a
  // Worker rollback to such code, worker/README.md clears the mark.
  peerReviewedByDoiComplete?: true;
}

export interface PaperSubjectReference {
  id: string;
  display_name: string;
}

// OpenAlex topics also flow through concepts during enrichment.
export interface PaperSubject {
  id: string;
  display_name?: string;
  level?: number;
  score?: number;
  subfield?: PaperSubjectReference;
  field?: PaperSubjectReference;
  domain?: PaperSubjectReference;
}

export interface PaperInstitution {
  id?: string;
  ror?: string | null;
  displayName?: string;
  display_name?: string;
}

export interface PaperICiteMetrics {
  relativeCitationRatio?: number | null;
  nihPercentile?: number | null;
  approximatePotentialToTranslate?: number | null;
  isClinical?: boolean | null;
  provisional?: boolean | null;
}

export interface PaperResearchResource {
  id: string;
  kind: string;
  title: string;
  url: string;
  downloads?: number;
  likes?: number;
}

export interface PaperFollowMatch {
  type: 'author' | 'topic' | 'institution' | 'project';
  canonicalId: string;
  displayName: string;
  source?: string;
  externalIds?: Record<string, string | null | undefined>;
  metadata?: Record<string, unknown>;
}

export interface PaperRecommendationScore {
  total: number;
  affinity: number;
  preference: number;
  recency: number;
  classicBoost: number;
  semantic: number;
  learnedAuthor: number;
  sessionInterest: number;
  citations: number;
  graphBoost: number;
  personalBoost: number;
  followBoost: number;
  missingAbstract: number;
  diversityBoost: number;
  authorBoost: number;
  followedEntityMatches: Record<PaperFollowMatch['type'], boolean>;
  isExploration: boolean;
  explanation: string;
}

/**
 * Shared by provider normalization, PaperBuilder and stored papers.
 * Optional and nullable fields preserve missing source data. This is a type
 * contract, not validation of provider responses or persisted records.
 */
export interface Paper {
  id: string;
  sources: PaperSources;
  title: string;
  abstract: string;
  language?: string;
  // The builder preserves older name-only arrays; enrichment must accept both.
  authors: Array<PaperAuthor | string>;
  year?: number | null;

  doi?: string | null;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  openAlexId?: string;
  semanticScholarId?: string;
  scopusId?: string;
  scopusUrl?: string;
  scopusCitedByUrl?: string;
  scopusCitationCount?: number;
  adsBibcode?: string;
  adsUrl?: string;
  inspireId?: string;
  inspireUrl?: string;
  openReviewId?: string;
  openReviewUrl?: string;
  openReviewVenueId?: string;
  huggingFaceId?: string;
  huggingFaceUrl?: string;
  huggingFaceUpvotes?: number;

  journal?: string;
  conference?: string;
  publisher?: string;
  // Providers retain their vocabulary (article, report, thesis, letter, etc.).
  publicationType?: string;
  publicationStatus?: 'preprint' | 'published' | 'accepted' | 'retracted';
  peerReviewed?: boolean;
  // True when the record shows a working paper or report
  // (`openAlexIsWorkingPaper`); absent when it does not say.
  workingPaper?: boolean;
  openAccess?: boolean;
  pdfUrl?: string | null;
  openAccessPdfUrl?: string;
  landingPageUrl?: string | null;
  openUrl?: string | null;
  europePmcUrl?: string;
  accessSource?: string;
  license?: string;

  // A zero with citationCountKnown: false is the builder's unknown sentinel.
  // A confirmed zero needs citationCountKnown: true; absence is also unknown.
  citationCount?: number;
  citationCountKnown?: boolean;
  referenceCount?: number;
  iciteMetrics?: PaperICiteMetrics;
  researchResources?: PaperResearchResource[];
  concepts?: PaperSubject[];
  topics?: PaperSubject[];
  primaryTopic?: PaperSubject | null;
  keywords?: string[];
  biomedicalTerms?: string[];
  categories?: string[];
  allCategories?: string[];
  primaryCategory?: string;
  // Carried by a stored copy: the rules its classification was written under
  // (`CLASSIFICATION_VERSION`). A fetched paper has none.
  classificationVersion?: number;
  institutions?: PaperInstitution[];
  projectIds?: string[];
  hasReferences?: boolean;
  hasData?: boolean;
  hasSupplement?: boolean;
  published?: string;
  summary?: string;
  sourceType?: string;
  provider?: string;
  citationMetadataResolved?: boolean;
  _followedEntityMatches?: Array<PaperFollowMatch | string>;
  // The reader categories a source was asked for when it returned this card.
  // Ranking credit only: it says why the card was fetched, not what the paper
  // is, so it is never shown or stored as the paper's classification.
  _fetchedFor?: string[];
  _type?: 'followed' | 'graph' | 'personal' | 'exploit' | 'exploration';
  _isGraphCandidate?: boolean;
  _isPersonalCandidate?: boolean;
  _dynamicScore?: number;
  _isOpenAlexEnriched?: boolean;
  _debugScore?: Partial<PaperRecommendationScore>;
  updateKey?: string;

  // These aliases still arrive from adapters and older saved records.
  citationsCount?: number;
  publishedDate?: string | null;
  publicationDate?: string;
  primary_topic?: PaperSubject | null;
  sourceName?: string;
  openAlex?: Partial<Paper> & {
    cited_by_count?: number | null;
    related_works?: string[];
  };
  // A retained provider payload remains untrusted at this boundary.
  raw?: unknown;
}

// Storage accepts older keys; normalization preserves an already-sourced record.
type StoredPaperInput = Omit<Partial<Paper>, 'id' | 'sources'> & {
  id?: string | number | null;
  sources?: PaperSources | null;
  source?: string;
  journalRef?: string;
};

const ARXIV_ID_PATTERN = /^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)?\/\d{7})(?:v\d+)?$/i;

/**
 * The arXiv id in a stored value, or nothing: `2401.12345v2`, `hep-th/0603001`,
 * with an `arxiv:` prefix or as an arxiv.org URL. Any other shape — an OpenAlex
 * work id, a PubMed id, a DOI — is not an arXiv id, however it arrived.
 */
export function readArxivId(value: unknown): string {
  const cleaned = String(value || '')
    .trim()
    .replace(/^arxiv:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  return ARXIV_ID_PATTERN.test(cleaned) ? cleaned : '';
}

/**
 * The rules a stored copy's classification (`primaryCategory`, `categories`,
 * `primaryTopic`) was written under. `readStoredClassification` trusts a copy
 * written under these rules and reads any other copy by the rules for old
 * copies. Raise it when the rules that classify a fetched paper change.
 */
const CLASSIFICATION_VERSION = 1;

// The savedPapers rules cap the list at 20; OpenAlex can list more concept names.
const STORED_CATEGORY_CAP = 20;
const STORED_SUBJECT_TEXT_MAX = 300;
const ARXIV_CATEGORY_PATTERN = /^[a-z-]+(?:\.[a-z-]+)?$/i;

function storedSubjectText(value: unknown) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= STORED_SUBJECT_TEXT_MAX ? text : '';
}

function storedSubjectReference(reference: Partial<PaperSubjectReference> | null | undefined): PaperSubjectReference | undefined {
  const id = storedSubjectText(reference?.id);
  const name = storedSubjectText(reference?.display_name);
  return id && name ? { id, display_name: name } : undefined;
}

/**
 * OpenAlex's primary topic as a copy keeps it: the topic, its subfield, field
 * and domain, by id and name. The score ranks; it does not classify.
 */
function storedPrimaryTopic(topic: PaperSubject | null | undefined): PaperSubject | undefined {
  const id = storedSubjectText(topic?.id);
  if (!id) return undefined;
  const name = storedSubjectText(topic?.display_name);
  const subfield = storedSubjectReference(topic?.subfield);
  const field = storedSubjectReference(topic?.field);
  const domain = storedSubjectReference(topic?.domain);
  return {
    id,
    ...(name && { display_name: name }),
    ...(subfield && { subfield }),
    ...(field && { field }),
    ...(domain && { domain }),
  };
}

/**
 * What a stored copy keeps of a paper's classification: the values
 * `areaAccent.ts` reads its field from.
 */
export function storedClassification(paper: Partial<Paper>) {
  const primaryTopic = storedPrimaryTopic(paper.primaryTopic);
  const categories = (paper.categories || (paper.primaryCategory ? [paper.primaryCategory] : []))
    .filter(category => typeof category === 'string' && category.trim() !== '')
    .slice(0, STORED_CATEGORY_CAP);
  return {
    primaryCategory: paper.primaryCategory || '',
    categories,
    ...(primaryTopic && { primaryTopic }),
    classificationVersion: CLASSIFICATION_VERSION,
  };
}

const isArxivCategory = (value: string) => ARXIV_CATEGORY_PATTERN.test(value) && getArxivArchiveArea(value) !== null;

/**
 * The classification a stored copy can show, decided on the copy as it was
 * stored, before anything fills in fields it lacks.
 *
 * Old copies dropped OpenAlex's topic and kept the category their card showed,
 * which was often the category the feed had asked for: arXiv's cross-list in
 * place of the primary (PAP-64), the reader's first choice on Hugging Face,
 * Europe PMC, PubMed and the other specialist cards, a concept name on
 * OpenAlex's (PAP-60). Only an old copy stored under a bare arXiv id with a
 * list of arXiv categories is still evidence: the list is arXiv's own, primary
 * first. Every other old copy has no field until the paper page asks a
 * provider (`hydrateSeededPaper`).
 */
export function readStoredClassification(copy: Omit<StoredPaperInput, 'sources'>) {
  // Only OpenAlex fills a topic, so it was never a requested category.
  const primaryTopic = storedPrimaryTopic(copy.primaryTopic);
  const categories = Array.isArray(copy.categories)
    ? copy.categories.filter((category): category is string => typeof category === 'string' && category.trim() !== '')
    : [];
  if (copy.classificationVersion === CLASSIFICATION_VERSION) {
    const primaryCategory = typeof copy.primaryCategory === 'string' ? copy.primaryCategory : '';
    return { primaryCategory, categories, primaryTopic, classificationVersion: CLASSIFICATION_VERSION };
  }
  const id = String(copy.id ?? '').trim();
  const arxivCopy = id !== '' && readArxivId(id) === id && categories.length > 0 && categories.every(isArxivCategory);
  return {
    primaryCategory: arxivCopy ? categories[0] : '',
    categories: arxivCopy ? categories : [],
    primaryTopic,
    classificationVersion: CLASSIFICATION_VERSION,
  };
}

/**
 * Adapts older localStorage/Firebase records. A sources object bypasses
 * normalization, so a partial stored record is not guaranteed to be a Paper.
 */
export function paperLegacyAdapter<T extends StoredPaperInput & { sources: PaperSources | null }>(legacyPaper: T): T;
export function paperLegacyAdapter(legacyPaper: StoredPaperInput & { sources?: undefined }): Paper;
export function paperLegacyAdapter(legacyPaper: Partial<Paper>): Partial<Paper>;
export function paperLegacyAdapter(legacyPaper: StoredPaperInput): Paper | StoredPaperInput;
export function paperLegacyAdapter(legacyPaper: StoredPaperInput): Paper | StoredPaperInput {
  // If it already looks like a new Paper (has sources object), return as is
  if (legacyPaper && typeof legacyPaper.sources === 'object') {
    return legacyPaper;
  }

  // Only an id that IS an arXiv id counts as one. This used to take any bare
  // `id` for an arXiv id, so a stored copy of an OpenAlex or PubMed paper
  // (`openalex:W…`, `pmid:…`) came out with `https://arxiv.org/pdf/W….pdf` as
  // its PDF, an arXiv landing page nobody served, and a canonical id of
  // `arxiv:openalex:W…` that no public paper key could read — which is how a
  // click on such a paper in a list opened a broken arXiv PDF instead of the
  // paper page.
  const arxivId = readArxivId(legacyPaper.arxivId) || readArxivId(legacyPaper.id);
  // The year is read from the date's text. A date-only `2026-01-01` read as a
  // Date is midnight UTC, which is still 2025 west of Greenwich.
  const year = Number(String(legacyPaper.published || '').slice(0, 4)) || legacyPaper.year || undefined;

  const authors = Array.isArray(legacyPaper.authors)
    ? legacyPaper.authors.map(a => typeof a === 'string' ? { name: a } : a)
    : [];

  const openAlexData = legacyPaper.openAlex || {};

  let doi = legacyPaper.doi || openAlexData.doi || '';
  if (doi && doi.startsWith('https://doi.org/')) {
    doi = doi.replace('https://doi.org/', '');
  }

  const journal = legacyPaper.journalRef || openAlexData.journal || '';

  // arXiv links are derived only for an arXiv paper; anything else keeps the
  // links it was stored with, or the DOI resolver, or nothing.
  const pdfUrl = legacyPaper.pdfUrl || (arxivId ? `https://arxiv.org/pdf/${arxivId.split('/').pop()}.pdf` : undefined);
  const landingPageUrl = legacyPaper.landingPageUrl
    || (arxivId ? `https://arxiv.org/abs/${arxivId.split('/').pop()}` : (doi ? `https://doi.org/${doi}` : ''));

  // The id a copy was stored under is the key its interactions live under —
  // the like, the read mark, the list it sits in — so it is kept as it is. A
  // copy used to be re-keyed by its DOI (or `arxiv:…`) here, and the paper
  // page opened from a list then looked for the read mark under the DOI
  // while it sat under `openalex:W…`: the paper the reader had just marked
  // read came up unread. The DOI and the arXiv id keep their own fields and
  // still drive the public key; only a copy with no id at all is keyed by them.
  const storedId = legacyPaper.id === undefined || legacyPaper.id === null ? '' : String(legacyPaper.id).trim();
  const canonicalId = storedId || doi || (arxivId ? `arxiv:${arxivId.split('/').pop()}` : String(Date.now()));
  const classification = readStoredClassification(legacyPaper);

  return {
    id: canonicalId,
    sources: {
      primary: legacyPaper.source || (arxivId ? 'arxiv' : 'stored'),
      enrichedBy: legacyPaper.openAlex ? ['openalex'] : []
    },
    title: legacyPaper.title || 'Untitled',
    abstract: legacyPaper.summary || legacyPaper.abstract || 'No abstract available.',
    authors,
    arxivId: arxivId || undefined,
    doi: doi || undefined,
    journal: journal || undefined,
    year,
    publicationType: legacyPaper.publicationType || 'preprint',
    publicationStatus: legacyPaper.publicationStatus || 'preprint',
    peerReviewed: legacyPaper.peerReviewed || (journal ? true : false),
    openAccess: legacyPaper.openAccess,
    pdfUrl,
    landingPageUrl,
    citationCount: legacyPaper.citationCount || openAlexData.cited_by_count || 0,
    concepts: legacyPaper.concepts || openAlexData.concepts || [],
    // The branch the feed filed the paper under, every category it carried
    // and OpenAlex's topic survive the round trip, as far as the copy can
    // show them. The list used to be dropped for the primary alone, and the
    // topic dropped outright, which is how a Genetics paper came back Physics.
    primaryCategory: classification.primaryCategory || undefined,
    categories: classification.categories.length > 0
      ? classification.categories
      : [classification.primaryCategory].filter(Boolean),
    primaryTopic: classification.primaryTopic ?? null,
    classificationVersion: classification.classificationVersion,
    published: legacyPaper.published || undefined,
  };
}
