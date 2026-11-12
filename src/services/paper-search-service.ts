import type { Paper } from '../models/paper.ts';
import type { PaperSearchFilters } from './adapters/index.ts';

import { OpenAlexAdapter } from './adapters/open-alex-adapter.ts';
import { OPENALEX_SEARCH_TYPES } from '../utils/open-alex-work.ts';
import type { OpenReviewNote } from './open-review-service.ts';
import { searchPapers as searchArxivPapers } from './arxiv-service.ts';
import { mapOpenReviewNote } from './open-review-service.ts';
import { fetchWorkerSourceJson } from './worker-api-client.ts';
import { mergeRankedPapers } from './paper-search-merge.ts';
import { fetchOpenReviewPaper } from './paper-lookup.ts';
import { normalizeSearchText } from '../utils/search-relevance.ts';
import { getPaperKey, normalizeOpenReviewId } from '../utils/public-navigation.ts';
import { settleWithin } from '../utils/async-timing.ts';

/**
 * The papers section of the search page and the palette: three sources, one list.
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
 * whatever the others found. The call rejects only when OpenAlex failed AND
 * the others had nothing, and it rejects with OpenAlex's own error so the page
 * can still tell a rate limit from a timeout.
 *
 * arXiv's cost is real -- the Worker keeps one request every three seconds for
 * the whole app -- and this adds at most one per debounced search, deduplicated
 * in flight by the tab's lane and cached an hour at the edge.
 *
 * OpenReview is the third source because a workshop paper or a submission with
 * no arXiv copy exists nowhere else: "Position: AI Development Should
 * Prioritize Cognitive Security" (ICLR 2026 AIWILD, forum 5pShDP8LSm) is in
 * neither OpenAlex nor arXiv. It is asked like arXiv, under its own deadline,
 * and its failure costs only its own papers. An identifier is not sent to it:
 * its search matches text, and a DOI or an arXiv id names a paper the other
 * two resolve.
 *
 * A pasted OpenReview link or `openreview:` id is the reverse case: it names
 * one submission that only OpenReview can answer for, so it is looked up by
 * id and the other two are not asked, since they would match its text against
 * titles. Its failure rejects, as there is nothing else to show, and names
 * OpenReview as the provider that failed.
 */
export const PAPER_SEARCH_LIMIT = 10;
export const ARXIV_SEARCH_LIMIT = 10;
// Measured 2026-09-22 through the Worker: 0.9 s warm, 5 s on a cold relevance
// query. Under the 6 s the callers give the whole papers section.
export const ARXIV_SEARCH_TIMEOUT_MS = 5_000;
const OPENREVIEW_SEARCH_LIMIT = 10;
// Measured 2026-11-10 through the Worker: 0.8 to 1.0 s on uncached queries.
export const OPENREVIEW_SEARCH_TIMEOUT_MS = 5_000;

const openAlexAdapter = new OpenAlexAdapter();

/**
 * The notes of an OpenReview answer worth showing as search results.
 *
 * `OpenReview.net/Archive` is where a profile owner files papers published
 * elsewhere, often under the owner's name alone: "Llama 2" came back twice,
 * under Sharan Narang and under Amjad Almahairi, beside the OpenAlex record
 * with the real author list, and the title-and-author deduplication cannot
 * join records whose first authors differ. A paper filed only there is not
 * found; whether one exists was not established.
 *
 * The Worker cuts to the limit before this runs, so a query whose first notes
 * are archive copies gets fewer than the limit. Dropping them in the Worker
 * (`isOpenReviewSubmission`) would also change what the feed harvests, which
 * is a decision of its own.
 */
export function openReviewSearchPapers(notes: OpenReviewNote[]) {
  return notes
    .filter(note => !String(note?.domain || '').toLowerCase().startsWith('openreview.net/archive'))
    .map(note => mapOpenReviewNote(note))
    .filter(paper => paper !== null);
}

export const DEFAULT_PAPER_SEARCH_PROVIDERS = Object.freeze({
  searchOpenAlex: (query: string, options: PaperSearchFilters) => openAlexAdapter.search(query, 1, { ...options, types: OPENALEX_SEARCH_TYPES, typeahead: true }),
  searchArxiv: (query: string, limit: number) => searchArxivPapers(query, 0, limit),
  searchOpenReview: async (query: string, limit: number) => {
    const data = await fetchWorkerSourceJson<{ notes?: OpenReviewNote[] }>('/sources/openreview', { q: query, limit }, { timeoutMs: OPENREVIEW_SEARCH_TIMEOUT_MS });
    return openReviewSearchPapers(data?.notes || []);
  },
  findOpenReviewPaper: (id: string) => fetchOpenReviewPaper(id, { timeoutMs: OPENREVIEW_SEARCH_TIMEOUT_MS }),
});

interface PaperSearchProviders {
  searchOpenAlex(query: string, options: PaperSearchFilters): Promise<Paper[] | { papers: Paper[] } | void>;
  searchArxiv(query: string, limit: number): Promise<Paper[] | { papers: Paper[] } | void>;
  // Optional so a caller that injects its own two sources asks nobody else.
  searchOpenReview?(query: string, limit: number): Promise<Paper[] | void>;
  findOpenReviewPaper?(id: string): Promise<Paper | null>;
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
  openReviewTimeoutMs = OPENREVIEW_SEARCH_TIMEOUT_MS,
  arxivLimit = ARXIV_SEARCH_LIMIT,
  limit = PAPER_SEARCH_LIMIT,
}: { signal?: AbortSignal; providers?: PaperSearchProviders; arxivTimeoutMs?: number; openAlexTimeoutMs?: number; openReviewTimeoutMs?: number; arxivLimit?: number; limit?: number } = {}) {
  const term = String(query || '').trim();
  if (!term) return [];

  const openReviewId = normalizeOpenReviewId(term);
  if (openReviewId) {
    const paper = await Promise.resolve(providers.findOpenReviewPaper?.(openReviewId)).catch((error: unknown) => {
      // The papers section is OpenAlex's in the outage notice (search-outage.ts);
      // this answer was OpenReview's alone, and the notice has to say so.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { searchSource: 'openreview' });
    });
    return paper ? [paper] : [];
  }

  const openAlexController = new AbortController();
  const openAlexSignal = signal ? AbortSignal.any([signal, openAlexController.signal]) : openAlexController.signal;
  const comparableTitle = Boolean(normalizeSearchText(term)) && !getPaperKey(term);
  const [openAlex, arxiv, openReview] = await Promise.all([
    settleWithin(Promise.resolve().then(() => providers.searchOpenAlex(term, { signal: openAlexSignal, priority: true })), openAlexTimeoutMs)
      .then(result => {
        if (result.status === 'timed_out') openAlexController.abort(new DOMException('Paper search timed out', 'TimeoutError'));
        return result;
      }),
    settleWithin(Promise.resolve().then(() => providers.searchArxiv(term, arxivLimit)), arxivTimeoutMs),
    settleWithin(Promise.resolve().then(() => (comparableTitle ? providers.searchOpenReview?.(term, OPENREVIEW_SEARCH_LIMIT) : undefined)), openReviewTimeoutMs),
  ]);

  const openAlexPapers = openAlex.status === 'fulfilled' ? papersFrom(openAlex.value) : [];
  // arXiv before OpenReview: a submission both hold keeps arXiv's record.
  const otherPapers = [
    ...(arxiv.status === 'fulfilled' ? papersFrom(arxiv.value) : []),
    ...(openReview.status === 'fulfilled' ? papersFrom(openReview.value) : []),
  ];
  if (openAlex.status === 'rejected' && otherPapers.length === 0) throw openAlex.reason;
  if (openAlex.status === 'timed_out' && otherPapers.length === 0) throw new DOMException('Paper search timed out', 'TimeoutError');

  return mergeRankedPapers(term, openAlexPapers, otherPapers, { limit, minimumTitleScore: comparableTitle ? 80 : 0 });
}
