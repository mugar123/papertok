import { fetchPapersByIds } from './arxivService.js';
import { fetchPapersByDois, fetchPapersByOpenAlexIds } from './openAlexService.js';
import { classifyInteractionPaperId } from '../utils/interactionPaperId.js';
import { isFetchableDocumentId } from '../utils/listPaperMetadataPlan.js';
import { isPlaceholderPaperTitle, resolvedPaperTitle } from '../utils/paperDisplayTitle.js';

const ARXIV_CHUNK = 20;
const OPENALEX_CHUNK = 20;
const DOI_CHUNK = 20;

function chunk(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function remember(map, requestedId, paper) {
  if (!paper) return;
  const title = resolvedPaperTitle(paper.title, requestedId);
  if (!title || isPlaceholderPaperTitle(title, requestedId)) return;
  map.set(requestedId, { ...paper, id: requestedId, title });
}

function indexByPossibleId(papers) {
  const byId = new Map();
  for (const paper of papers || []) {
    if (!paper) continue;
    const keys = [
      paper.id,
      paper.arxivId,
      paper.openAlexId,
      paper.doi,
      paper.id ? `openalex:${paper.id}` : '',
      paper.arxivId ? `arxiv:${paper.arxivId}` : '',
      paper.doi ? `doi:${paper.doi}` : '',
    ];
    for (const key of keys) {
      if (key) byId.set(String(key), paper);
    }
  }
  return byId;
}

/**
 * Fill in papers the interaction documents never stored a real title for.
 *
 * Firestore cannot even be asked for some of those ids (`hep-th/0603001`
 * rejects the whole `in` query). Others exist but stand the document id in
 * for `paperTitle`. Either way the Liked tab used to wait forever, or paint
 * the id. This asks arXiv / OpenAlex for the missing names, keyed back to
 * the interaction id the row already has.
 */
export async function hydrateInteractionPapers(ids, {
  fetchArxivByIds = fetchPapersByIds,
  fetchOpenAlexByIds = fetchPapersByOpenAlexIds,
  fetchDois = fetchPapersByDois,
} = {}) {
  const list = Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : [];
  if (list.length === 0) return new Map();

  const arxiv = [];
  const openalex = [];
  const dois = [];
  for (const id of list) {
    const classified = classifyInteractionPaperId(id);
    if (classified.kind === 'arxiv') arxiv.push({ id, value: classified.value });
    else if (classified.kind === 'openalex') openalex.push({ id, value: classified.value });
    else if (classified.kind === 'doi') dois.push({ id, value: classified.value });
  }

  const found = new Map();

  const loadChunks = async (entries, size, fetchValues) => {
    if (entries.length === 0) return;
    for (const group of chunk(entries, size)) {
      let papers = [];
      try {
        papers = await fetchValues(group.map(entry => entry.value));
      } catch (error) {
        console.warn('Could not hydrate liked-paper titles', error);
        continue;
      }
      const byId = indexByPossibleId(papers);
      for (const entry of group) {
        remember(
          found,
          entry.id,
          byId.get(entry.value)
            || byId.get(entry.id)
            || byId.get(`openalex:${entry.value}`)
            || byId.get(`arxiv:${entry.value}`)
            || byId.get(`doi:${entry.value}`),
        );
      }
    }
  };

  await loadChunks(arxiv, ARXIV_CHUNK, fetchArxivByIds);
  await loadChunks(openalex, OPENALEX_CHUNK, fetchOpenAlexByIds);
  await loadChunks(dois, DOI_CHUNK, fetchDois);

  return found;
}

async function defaultReadRecords(userId, paperIds) {
  const { fetchLibraryRecords } = await import('./interactionProfileStore.js');
  return fetchLibraryRecords(userId, paperIds);
}

function libraryRecordsResult(records, fromCache, ids) {
  // Firestore never stored slash-bearing ids, so an empty server answer is
  // not "this paper does not exist". Leave those ids retryable until a
  // provider actually names them; otherwise Liked latches a network blip.
  const answered = new Set(records.map(row => row.id));
  const unfilledIllegalIds = ids.some(id => !isFetchableDocumentId(id) && !answered.has(id));
  return { records, fromCache, authoritative: !unfilledIllegalIds };
}

/**
 * Interaction documents plus provider titles for ids Firestore cannot name.
 *
 * Callers that used `fetchLibraryRecords` alone lost every paper in a batch
 * that contained one pre-2007 arXiv id, then waited forever on Liked. This
 * drops those ids from the query and fills the gaps from arXiv / OpenAlex.
 */
export async function fetchLibraryRecordsHydrated(userId, paperIds, {
  readRecords = defaultReadRecords,
  hydrate = hydrateInteractionPapers,
} = {}) {
  const ids = Array.isArray(paperIds) ? paperIds.filter(Boolean) : [];
  const { records, fromCache } = await readRecords(userId, ids);
  const titled = new Set();
  for (const { id, data } of records) {
    const title = resolvedPaperTitle(data?.paper?.title || data?.paperTitle || '', id);
    if (title) titled.add(id);
  }
  const missing = ids.filter(id => !titled.has(id));
  if (missing.length === 0) return libraryRecordsResult(records, fromCache, ids);

  const hydrated = await hydrate(missing);
  if (hydrated.size === 0) return libraryRecordsResult(records, fromCache, ids);

  const merged = records.map(row => {
    const paper = hydrated.get(row.id);
    if (!paper) return row;
    return {
      id: row.id,
      data: {
        ...row.data,
        paper,
        paperTitle: paper.title,
        paperAuthors: paper.authors,
      },
    };
  });
  hydrated.forEach((paper, id) => {
    if (titled.has(id) || merged.some(row => row.id === id)) return;
    merged.push({
      id,
      data: { paper, paperTitle: paper.title, paperAuthors: paper.authors },
    });
  });
  return libraryRecordsResult(merged, fromCache, ids);
}
