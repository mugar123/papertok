/**
 * The canonical spelling of a paper's DOI and arXiv id, so the same paper
 * reached through different providers matches itself:
 *
 *   - a DOI is lowercased, with its `doi:` prefix and doi.org resolver
 *     stripped
 *   - an arXiv id is lowercased, without its `arXiv:` prefix, its abs/pdf URL
 *     or its version suffix, so `2401.12345v3` and `2401.12345` are one paper
 *
 * interactionAliases.js builds its alias table from these, so a like or a
 * save made under one provider's id still finds the paper under another.
 *
 * This is deliberately NOT `encodePaperKey` from `publicNavigation.js`. That
 * one addresses share URLs and keeps the arXiv version, because a shared link
 * points at what the sharer saw.
 */

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;
const ARXIV_PATTERN = /^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)?\/\d{7})(?:v\d+)?$/i;

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  const hasControlCharacter = [...text].some(character => {
    const codePoint = character.charCodeAt(0);
    return codePoint < 32 || codePoint === 127;
  });
  return hasControlCharacter ? '' : text;
}

function normalizeDoi(value) {
  const doi = cleanText(value)
    .replace(/^doi:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '');
  if (!DOI_PATTERN.test(doi)) return '';
  return doi.toLowerCase();
}

/** Lowercased and versionless: `2401.12345v3` and `2401.12345` are one paper. */
function normalizeArxivId(value) {
  const arxivId = cleanText(value)
    .replace(/^arxiv:\s*/i, '')
    .replace(/^(?:https?:\/\/)?(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  if (!ARXIV_PATTERN.test(arxivId)) return '';
  return arxivId.toLowerCase().replace(/v\d+$/, '');
}

function doiOf(paper) {
  return normalizeDoi(paper?.doi || paper?.externalIds?.DOI);
}

function arxivIdOf(paper) {
  return normalizeArxivId(paper?.arxivId || paper?.externalIds?.ArXiv);
}

/**
 * The DOI in canonical spelling, or null. Accepts a paper object (its `doi`,
 * then `externalIds.DOI`) or a bare identifier string.
 */
export function canonicalDoiOf(paper) {
  return (paper && typeof paper === 'object' ? doiOf(paper) : normalizeDoi(paper)) || null;
}

/** The arXiv id in canonical spelling, or null; same inputs as canonicalDoiOf. */
export function canonicalArxivIdOf(paper) {
  return (paper && typeof paper === 'object' ? arxivIdOf(paper) : normalizeArxivId(paper)) || null;
}
