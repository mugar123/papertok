import { isFetchableDocumentId } from '../utils/listPaperMetadataPlan.js';

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
 * The Liked tab is keyed by the feed's `paper.id`. For a pre-2007 arXiv paper
 * that id carries a slash (`hep-th/0603001`, `math.GT/0309136`), which no
 * Firestore document can be named by: the like reached the aggregate, the
 * document write threw, and there is nothing in the library to read. Those
 * rows take their title from arXiv itself; every other id goes to the library
 * read as before.
 */
const LEGACY_ARXIV_ID = /^(?:arxiv:)?[a-z][a-z-]*(?:\.[a-z-]+)?\/\d{7}(?:v\d+)?$/i;

const arxivKey = value => String(value || '')
  .replace(/^arxiv:/i, '')
  .replace(/v\d+$/i, '')
  .toLowerCase();

/**
 * Same contract as `fetchLibraryRecords` — `{ records, fromCache }` — plus
 * `authoritative: false` when arXiv did not answer, so the caller leaves those
 * ids askable instead of settling them as "no title".
 */
export async function fetchLikedPaperRecords(userId, paperIds, {
  readRecords = readLibraryRecords,
  fetchArxivPapers = readArxivPapers,
} = {}) {
  const ids = Array.isArray(paperIds) ? paperIds.filter(Boolean) : [];
  const stored = [];
  const legacy = [];
  for (const id of ids) {
    if (isFetchableDocumentId(id)) stored.push(id);
    else if (LEGACY_ARXIV_ID.test(id)) legacy.push(id);
  }

  const [library, arxiv] = await Promise.all([
    stored.length > 0 ? readRecords(userId, stored) : { records: [], fromCache: false },
    legacy.length > 0
      ? fetchArxivPapers(legacy.map(id => id.replace(/^arxiv:/i, '')))
        .then(papers => ({ papers: papers || [], failed: false }))
        .catch(() => ({ papers: [], failed: true }))
      : { papers: [], failed: false },
  ]);

  const byKey = new Map();
  for (const paper of arxiv.papers) {
    for (const key of [paper?.arxivId, paper?.id]) {
      if (key) byKey.set(arxivKey(key), paper);
    }
  }
  const records = [...library.records];
  for (const id of legacy) {
    const paper = byKey.get(arxivKey(id));
    if (!paper) continue;
    records.push({
      id,
      data: { paper, paperTitle: paper.title, paperAuthors: paper.authors },
    });
  }

  return { records, fromCache: library.fromCache, authoritative: !arxiv.failed };
}
