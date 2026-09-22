import { OPENALEX_SEARCH_TYPES, OpenAlexAdapter } from './adapters/OpenAlexAdapter.js';
import { searchPapers as searchArxivPapers } from './arxivService.js';
import { PaperBuilder } from './PaperBuilder.js';
import { rankPaperSearchResults } from '../utils/searchRelevance.js';
import { settleWithin } from '../utils/asyncTiming.js';

/**
 * The papers section of the search page and the palette: two sources, one list.
 *
 * OpenAlex alone used to answer it, and OpenAlex alone cannot: its record for
 * arXiv 2307.09288 (W4384918448) carries somebody else's title, so no query
 * for "llama 2" can surface the Llama 2 paper through it, however the results
 * are ranked. arXiv answers `all:"llama 2"` with the paper in third place. So
 * arXiv is asked alongside, its answer merged through `PaperBuilder.deduplicate`
 * -- the same record from both sides becomes one paper, DOI or arXiv id first,
 * title-and-author last -- and the merged list is ranked by title match
 * (`rankPaperSearchResults`) before the slice.
 *
 * Failure stays graceful in both directions. arXiv is bounded by its own
 * deadline and never blocks the OpenAlex answer; a dead OpenAlex still leaves
 * whatever arXiv found. The call rejects only when OpenAlex failed AND arXiv
 * had nothing, and it rejects with OpenAlex's own error so the page can still
 * tell a rate limit from a timeout.
 *
 * arXiv's cost is real -- the Worker keeps one request every three seconds for
 * the whole app -- and this adds at most one per debounced search, deduplicated
 * in flight by the tab's lane and cached an hour at the edge.
 */
export const PAPER_SEARCH_LIMIT = 10;
export const ARXIV_SEARCH_LIMIT = 10;
// Measured 2026-09-22 through the Worker: 0.9 s warm, 5 s on a cold relevance
// query. Under the 6 s the callers give the whole papers section.
export const ARXIV_SEARCH_TIMEOUT_MS = 5_000;

const openAlexAdapter = new OpenAlexAdapter();

export const DEFAULT_PAPER_SEARCH_PROVIDERS = Object.freeze({
  searchOpenAlex: (query, options) => openAlexAdapter.search(query, 1, { ...options, types: OPENALEX_SEARCH_TYPES }),
  searchArxiv: (query, limit) => searchArxivPapers(query, 0, limit),
});

function papersFrom(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.papers) ? value.papers : [];
}

function settle(promise) {
  return Promise.resolve()
    .then(() => promise())
    .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
}

export async function searchPapersAcrossSources(query, {
  signal,
  providers = DEFAULT_PAPER_SEARCH_PROVIDERS,
  arxivTimeoutMs = ARXIV_SEARCH_TIMEOUT_MS,
  arxivLimit = ARXIV_SEARCH_LIMIT,
  limit = PAPER_SEARCH_LIMIT,
} = {}) {
  const term = String(query || '').trim();
  if (!term) return [];

  const [openAlex, arxiv] = await Promise.all([
    settle(() => providers.searchOpenAlex(term, { signal })),
    settleWithin(Promise.resolve().then(() => providers.searchArxiv(term, arxivLimit)), arxivTimeoutMs),
  ]);

  const openAlexPapers = openAlex.status === 'fulfilled' ? papersFrom(openAlex.value) : [];
  const arxivPapers = arxiv.status === 'fulfilled' ? papersFrom(arxiv.value) : [];
  if (openAlex.status === 'rejected' && arxivPapers.length === 0) throw openAlex.reason;

  // OpenAlex first: `deduplicate` keeps the position of the first record of a
  // group, so a paper both sources found stays where OpenAlex ranked it and
  // only the arXiv-only papers are appended, before the title ranking runs.
  const merged = PaperBuilder.deduplicate([...openAlexPapers, ...arxivPapers]);
  return rankPaperSearchResults(term, merged).slice(0, limit);
}
