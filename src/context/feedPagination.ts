import type { Paper } from '../models/Paper.ts';

/** A page of papers shown before, carried by a load that skipped past it. */
type SeenFallback = { page: number; papers: Paper[] };

// Limits the automatic fetch depth, so a load cannot walk the corpus forever.
const AUTO_FETCH_PAGE_CEILING = 10;

/**
 * Whether a load may go on to the next page by itself: the page it got had
 * papers, so the corpus has results, and the automatic depth is not spent.
 */
export function canFetchNextPage(candidateCount: number, currentPage: number) {
  return candidateCount > 0 && currentPage < AUTO_FETCH_PAGE_CEILING;
}

/**
 * A page none of whose papers can be shown. An entirely excluded page still
 * proves the corpus has results, so the load goes one page on (not more: the
 * corpus ranks the same way on every load, so a longer move would pass over
 * papers not yet shown). It carries the first page of papers shown before but
 * never liked, saved, read or dismissed (`shownBeforeHere` on this page), which
 * is shown again when no later page has an unseen paper: the feed is never
 * empty because everything was seen.
 */
export function planUnshowablePage({ candidateCount, currentPage, seenFallback, shownBeforeHere }: {
  candidateCount: number;
  currentPage: number;
  seenFallback: SeenFallback | undefined;
  shownBeforeHere: Paper[];
}) {
  const shownBefore = seenFallback ?? (shownBeforeHere.length > 0 ? { page: currentPage, papers: shownBeforeHere } : undefined);
  if (canFetchNextPage(candidateCount, currentPage)) {
    return { kind: 'next-page', page: currentPage + 1, seenFallback: shownBefore } as const;
  }
  if (shownBefore) return { kind: 'show-seen', papers: shownBefore.papers } as const;
  return { kind: 'show-none' } as const;
}

/**
 * An empty first page is not the end of the feed: a corpus with nothing for
 * these interests is not ready, which is an error with a retry.
 */
export function isEmptyFirstPage(reset: boolean, candidateCount: number, seenFallback: SeenFallback | undefined) {
  return reset && candidateCount === 0 && !seenFallback;
}

/**
 * Where the feed goes on after a load. When an empty or failed page left the
 * load showing the seen papers it carried, the feed goes on from the page
 * after theirs: the pages this load skipped past may hold papers the reader
 * has not seen. An empty later page with nothing carried is the end.
 */
export function pageAfterLoad(candidateCount: number, currentPage: number, seenFallback: SeenFallback | undefined) {
  const resumeAfter = candidateCount === 0 ? seenFallback?.page : undefined;
  return {
    nextPage: (resumeAfter ?? currentPage) + 1,
    hasMore: candidateCount > 0 || resumeAfter !== undefined,
  };
}
