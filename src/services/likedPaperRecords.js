// Both readers are reached lazily: the library read pulls in the Firebase
// client, which has no business being loaded by a unit test of this routing,
// and in the app both modules are already resident by the time a profile
// paints, so the import resolves at once.
const readLibraryRecords = async (userId, ids) => {
  const { fetchLibraryRecords } = await import('./interactionProfileStore.js');
  return fetchLibraryRecords(userId, ids);
};
const readArxivPapers = async (ids) => {
  const { fetchPapersByIds } = await import('./arxivService.js');
  return fetchPapersByIds(ids);
};

/**
 * Some liked papers are keyed by ids with a slash (`hep-th/0603001`,
 * `doi:10.1103/...`). Since the write side encodes document names
 * (utils/interactionDocId.js) those have a record like any other — but the
 * likes made BEFORE that fix never got one, and the Liked tab still has to
 * name them. Firestore is asked for every id; only the legacy arXiv ids it
 * does not answer go to arXiv.
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

/**
 * Same contract as `fetchLibraryRecords` — `{ records, fromCache }` — plus
 * `unsettled`: the ids arXiv failed to answer for, which the caller leaves
 * askable while everything Firestore answered (or confirmed absent) settles.
 */
export async function fetchLikedPaperRecords(userId, paperIds, {
  readRecords = readLibraryRecords,
  fetchArxivPapers = readArxivPapers,
} = {}) {
  const ids = Array.isArray(paperIds) ? paperIds.filter(Boolean) : [];
  const library = ids.length > 0 ? await readRecords(userId, ids) : { records: [], fromCache: false };
  const answered = new Set(library.records.map(record => record.id));
  const legacy = ids.filter(id => !answered.has(id) && isLegacyArxivId(id));
  if (legacy.length === 0) {
    return { records: library.records, fromCache: library.fromCache, authoritative: true, unsettled: [] };
  }

  const arxiv = await hydrateLegacyArxivPapers(legacy, { fetchArxivPapers });
  return {
    records: [...library.records, ...arxiv.records],
    fromCache: library.fromCache,
    authoritative: true,
    unsettled: arxiv.failed ? legacy : [],
  };
}
