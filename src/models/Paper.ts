/**
 * @typedef {Object} Author
 * @property {string} name
 * @property {string} [id] - OpenAlex ID, Scopus ID, etc.
 * @property {string} [orcid]
 */

/**
 * @typedef {Object} PaperSources
 * @property {string} primary - Provider that originally discovered the paper (for example, 'arxiv' or 'openalex')
 * @property {string[]} enrichedBy - Providers that contributed additional metadata
 */

/**
 * @typedef {Object} Paper
 * @property {string} id - Canonical identifier (DOI when available, for example "10.1038/xxx"; otherwise "arxiv:2401.12345")
 * @property {PaperSources} sources - Data-source provenance
 * @property {string} title
 * @property {string} abstract
 * @property {Author[]} authors
 * 
 * @property {string} [doi]
 * @property {string} [pmid]
 * @property {string} [pmcid]
 * @property {string} [openReviewId]
 * @property {string} [huggingFaceId]
 * @property {string} [journal]
 * @property {string} [conference]
 * @property {number} year
 * @property {string} [publisher]
 * 
 * @property {"preprint" | "journal" | "conference" | "book"} publicationType
 * @property {"preprint" | "published" | "accepted" | "retracted"} publicationStatus
 * @property {boolean} peerReviewed - Computado como (publicationType !== "preprint")
 * @property {boolean} openAccess
 * 
 * @property {string} [pdfUrl] - Enlace directo al PDF si existe y es Open Access
 * @property {string} [openAccessPdfUrl] - Open-access PDF URL to open externally
 * @property {string} landingPageUrl - URL oficial de la editorial/fuente
 * 
 * // Metadatos aplanados
 * @property {number} [citationCount]
 * @property {number} [referenceCount]
 * @property {{relativeCitationRatio: number|null, nihPercentile: number|null, approximatePotentialToTranslate: number|null}} [iciteMetrics]
 * @property {Array<{id: string, kind: string, title: string, url: string}>} [researchResources]
 * @property {Array<{id: string, display_name: string, level: number}>} [concepts]
 * @property {string[]} [keywords]
 * @property {string[]} [categories] - Legacy/arXiv categories
 */

const ARXIV_ID_PATTERN = /^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)?\/\d{7})(?:v\d+)?$/i;

/**
 * The arXiv id in a stored value, or nothing: `2401.12345v2`, `hep-th/0603001`,
 * with an `arxiv:` prefix or as an arxiv.org URL. Any other shape — an OpenAlex
 * work id, a PubMed id, a DOI — is not an arXiv id, however it arrived.
 */
export function readArxivId(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^arxiv:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  return ARXIV_ID_PATTERN.test(cleaned) ? cleaned : '';
}

/**
 * Convierte un paper antiguo almacenado en localStorage/Firebase al nuevo formato Paper unificado.
 * Esto evita romper la app al leer colecciones guardadas previamente.
 * 
 * @param {Object} legacyPaper - El paper antiguo.
 * @returns {Paper} El paper convertido.
 */
export function paperLegacyAdapter(legacyPaper) {
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
        : [legacyPaper.primaryCategory].filter(Boolean)),
    published: legacyPaper.published || undefined,
  };
}
