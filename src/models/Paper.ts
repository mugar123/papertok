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
  const year = legacyPaper.published
    ? new Date(legacyPaper.published).getFullYear()
    : (legacyPaper.year || new Date().getFullYear());

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
    openAccess: legacyPaper.openAccess !== undefined ? legacyPaper.openAccess : true,
    pdfUrl,
    landingPageUrl,
    citationCount: legacyPaper.citationCount || openAlexData.cited_by_count || 0,
    concepts: legacyPaper.concepts || openAlexData.concepts || [],
    // The branch the feed filed the paper under, and every category it
    // carried, survive the round trip: a stored copy keeps `categories` as a
    // list, and it used to be dropped for the primary alone.
    primaryCategory: legacyPaper.primaryCategory || undefined,
    categories: legacyPaper.allCategories
      || (Array.isArray(legacyPaper.categories) && legacyPaper.categories.length > 0
        ? legacyPaper.categories
        : [legacyPaper.primaryCategory].filter(Boolean) as string[]),
    published: legacyPaper.published || undefined,
  };
}
