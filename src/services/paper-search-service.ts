import type { Paper } from '../models/paper.ts';
import type { PaperSearchFilters } from './adapters/index.ts';

import { OPENALEX_SEARCH_TYPES, OpenAlexAdapter } from './adapters/open-alex-adapter.ts';
import { searchPapers as searchArxivPapers } from './arxiv-service.ts';
import { PaperBuilder } from './paper-builder.ts';
import { rankPaperSearchResults, scorePaperSearchMatch, normalizeSearchText } from '../utils/search-relevance.ts';
import { getPaperKey } from '../utils/public-navigation.ts';
import { settleWithin } from '../utils/async-timing.ts';

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
  searchOpenAlex: (query: string, options: PaperSearchFilters) => openAlexAdapter.search(query, 1, { ...options, types: OPENALEX_SEARCH_TYPES, typeahead: true }),
  searchArxiv: (query: string, limit: number) => searchArxivPapers(query, 0, limit),
});

interface PaperSearchProviders {
  searchOpenAlex(query: string, options: PaperSearchFilters): Promise<Paper[] | { papers: Paper[] } | void>;
  searchArxiv(query: string, limit: number): Promise<Paper[] | { papers: Paper[] } | void>;
}

function papersFrom(value: Paper[] | { papers: Paper[] } | void) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.papers) ? value.papers : [];
}

export async function searchPapersAcrossSources(query: unknown, {
  signal,
  providers = DEFAULT_PAPER_SEARCH_PROVIDERS,
  arxivTimeoutMs = ARXIV_SEARCH_TIMEOUT_MS,
  openAlexTimeoutMs = 5_000,
  arxivLimit = ARXIV_SEARCH_LIMIT,
  limit = PAPER_SEARCH_LIMIT,
}: { signal?: AbortSignal; providers?: PaperSearchProviders; arxivTimeoutMs?: number; openAlexTimeoutMs?: number; arxivLimit?: number; limit?: number } = {}) {
  const term = String(query || '').trim();
  if (!term) return [];

  const openAlexController = new AbortController();
  const openAlexSignal = signal ? AbortSignal.any([signal, openAlexController.signal]) : openAlexController.signal;
  const [openAlex, arxiv] = await Promise.all([
    settleWithin(Promise.resolve().then(() => providers.searchOpenAlex(term, { signal: openAlexSignal, priority: true })), openAlexTimeoutMs)
      .then(result => {
        if (result.status === 'timed_out') openAlexController.abort(new DOMException('Paper search timed out', 'TimeoutError'));
        return result;
      }),
    settleWithin(Promise.resolve().then(() => providers.searchArxiv(term, arxivLimit)), arxivTimeoutMs),
  ]);

  const openAlexPapers = openAlex.status === 'fulfilled' ? papersFrom(openAlex.value) : [];
  const arxivPapers = arxiv.status === 'fulfilled' ? papersFrom(arxiv.value) : [];
  if (openAlex.status === 'rejected' && arxivPapers.length === 0) throw openAlex.reason;
  if (openAlex.status === 'timed_out' && arxivPapers.length === 0) throw new DOMException('Paper search timed out', 'TimeoutError');

  // OpenAlex first: `deduplicate` keeps the position of the first record of a
  // group, so a paper both sources found stays where OpenAlex ranked it and
  // only the arXiv-only papers are appended, before the title ranking runs.
  const merged = PaperBuilder.deduplicate([...openAlexPapers, ...arxivPapers]);
  const comparableTitle = normalizeSearchText(term) && !getPaperKey(term);
  return rankPaperSearchResults(term, merged)
    .filter(paper => !comparableTitle || scorePaperSearchMatch(term, paper) >= 80)
    .slice(0, limit);
}
