// Reached lazily, so a unit test of this module never loads the arXiv client.
const readArxivPapers = async (ids) => {
  const { fetchPapersByIds } = await import('./arxivService.ts');
  return fetchPapersByIds(ids);
};

/**
 * Some liked and saved papers are keyed by ids with a slash
 * (`hep-th/0603001`, `doi:10.1103/...`). Since the write side encodes document
 * names (utils/interactionDocId.js) those have a record like any other — but
 * the ones made BEFORE that fix never got one, and the lists still have to
 * name them. Only the legacy arXiv ids no document answered for go to arXiv.
 */
const LEGACY_ARXIV_ID = /^(?:arxiv:)?[a-z][a-z-]*(?:\.[a-z-]+)?\/\d{7}(?:v\d+)?$/i;

export function isLegacyArxivId(id) {
  return typeof id === 'string' && LEGACY_ARXIV_ID.test(id);
}

const arxivKey = value => String(value || '')
  .replace(/^arxiv:/i, '')
  .replace(/v\d+$/i, '')
  .toLowerCase();

/**
 * Names, from arXiv, the legacy-id papers no document could answer for: the
 * likes and saves made before document names were encoded never got one.
 * Returns records in the library shape, and `failed` when arXiv did not
 * answer, so the caller can leave those ids askable.
 */
export async function hydrateLegacyArxivPapers(ids, { fetchArxivPapers = readArxivPapers } = {}) {
  const legacy = (Array.isArray(ids) ? ids : []).filter(isLegacyArxivId);
  if (legacy.length === 0) return { records: [], failed: false };

  let papers;
  try {
    papers = (await fetchArxivPapers(legacy.map(id => id.replace(/^arxiv:/i, '')))) || [];
  } catch {
    return { records: [], failed: true };
  }

  const byKey = new Map();
  for (const paper of papers) {
    for (const key of [paper?.arxivId, paper?.id]) {
      if (key) byKey.set(arxivKey(key), paper);
    }
  }
  const records = [];
  for (const id of legacy) {
    const paper = byKey.get(arxivKey(id));
    if (!paper) continue;
    records.push({ id, data: { paper, paperTitle: paper.title, paperAuthors: paper.authors } });
  }
  return { records, failed: false };
}
