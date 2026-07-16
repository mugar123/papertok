/**
 * @typedef {Object} Author
 * @property {string} name
 * @property {string} [id] - OpenAlex ID, Scopus ID, etc.
 * @property {string} [orcid]
 */

/**
 * @typedef {Object} PaperSources
 * @property {string} primary - Proveedor que descubrió el paper originamente (ej. 'arxiv', 'openalex')
 * @property {string[]} enrichedBy - Proveedores que aportaron metadatos adicionales
 */

/**
 * @typedef {Object} Paper
 * @property {string} id - Identificador canónico (DOI si existe, ej. "10.1038/xxx", si no, "arxiv:2401.12345")
 * @property {PaperSources} sources - Trazabilidad de orígenes de datos
 * @property {string} title
 * @property {string} abstract
 * @property {Author[]} authors
 * 
 * @property {string} [doi]
 * @property {string} [pmid]
 * @property {string} [pmcid]
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
 * @property {string} [openAccessPdfUrl] - PDF abierto que debe abrirse externamente
 * @property {string} landingPageUrl - URL oficial de la editorial/fuente
 * 
 * // Metadatos aplanados
 * @property {number} [citationCount]
 * @property {number} [referenceCount]
 * @property {Array<{id: string, display_name: string, level: number}>} [concepts]
 * @property {string[]} [keywords]
 * @property {string[]} [categories] - Legacy/arXiv categories
 */

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

  const arxivId = legacyPaper.arxivId || legacyPaper.id;
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

  const pdfUrl = legacyPaper.pdfUrl || (arxivId ? `https://arxiv.org/pdf/${arxivId.split('/').pop()}.pdf` : undefined);
  const landingPageUrl = arxivId ? `https://arxiv.org/abs/${arxivId.split('/').pop()}` : (doi ? `https://doi.org/${doi}` : '');

  // Extract pure ID for canonical identification
  let canonicalId = doi || (arxivId ? `arxiv:${arxivId.split('/').pop()}` : String(legacyPaper.id || Date.now()));

  return {
    id: canonicalId,
    sources: {
      primary: legacyPaper.source || 'arxiv',
      enrichedBy: legacyPaper.openAlex ? ['openalex'] : []
    },
    title: legacyPaper.title || 'Untitled',
    abstract: legacyPaper.summary || legacyPaper.abstract || 'No abstract available.',
    authors,
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
    categories: legacyPaper.allCategories || [legacyPaper.primaryCategory].filter(Boolean)
  };
}
