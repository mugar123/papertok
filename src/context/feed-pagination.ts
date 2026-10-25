import type { Paper } from '../models/paper.ts';

import { feedSeenIds } from '../utils/seen-paper-filter.ts';

/** A page of papers shown before, carried by a load that skipped past it. */
type SeenFallback = { page: number; papers: Paper[] };

// The papers a page of the feed asks the corpus for.
export const PAGE_SIZE = 15;

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
 * Whether a page has no paper the feed can show (`available`). Notable cards
 * alone count as none: they take only their places among other cards
 * (joinNotablePage), and the corpus sends them unseen even when the reader saw
 * every other paper on the page.
 */
export function showsNoPaper(available: Paper[]) {
  return available.every(paper => paper._notable);
}

/**
 * Whether the reader has seen every paper of their ranking, from the main
 * page's answer. A Worker that skips seen papers (`skipsSeen`, PAP-103) sends
 * seen ones only when the ranking has no other, so no later page has a paper
 * the reader has not seen. A notable card says nothing of the ranking: the
 * corpus sends them unseen. From a Worker that pages by number, the app
 * cannot know, and goes one page on as before. `seen` lists the papers the
 * request was sent oldest first; its filter holds only the 2,000 most recent
 * (`feedSeenIds`), so the Worker sends an older one as unseen.
 */
export function hasSeenRanking({ papers, skipsSeen }: { papers: Paper[]; skipsSeen: boolean }, seen: ReadonlySet<string>) {
  if (!skipsSeen) return false;
  const held = new Set(feedSeenIds(seen));
  return papers.some(paper => !paper._notable && held.has(paper.id));
}

/**
 * A page none of whose papers can be shown. An entirely excluded page still
 * proves the corpus has results, so the load goes one page on (not more: the
 * corpus ranks the same way on every load, so a longer move would pass over
 * papers not yet shown), unless the reader has seen their whole ranking
 * (`rankingSeen`): no later page has a paper they have not. It carries the
 * first page of papers shown before but never liked, saved, read or dismissed
 * (`shownBeforeHere` on this page), which is shown again when no later page
 * has an unseen paper: the feed is never empty because everything was seen. A
 * notable card is never shown twice, so the carried papers leave them out;
 * this page's unseen notable cards (`notableHere`) take their places among
 * the papers shown again.
 */
export function planUnshowablePage({ candidateCount, currentPage, seenFallback, shownBeforeHere, notableHere = [], reset = false, excludedCount = 0, rankingSeen = false }: {
  candidateCount: number;
  currentPage: number;
  seenFallback: SeenFallback | undefined;
  shownBeforeHere: Paper[];
  notableHere?: Paper[];
  reset?: boolean;
  excludedCount?: number;
  rankingSeen?: boolean;
}) {
  const seenHere = shownBeforeHere.filter(paper => !paper._notable);
  const shownBefore = seenFallback ?? (seenHere.length > 0 ? { page: currentPage, papers: seenHere } : undefined);
  // The server cannot see the client's full curated sets or Bloom filter.
  // Restart once without soft exclusions when they leave no usable fallback.
  if (reset && excludedCount > 0 && !shownBefore) return { kind: 'relax-exclusions', page: 0 } as const;
  if (canFetchNextPage(candidateCount, currentPage) && !rankingSeen) {
    return { kind: 'next-page', page: currentPage + 1, seenFallback: shownBefore } as const;
  }
  if (shownBefore) {
    const papers = [...shownBefore.papers, ...notableHere];
    return { kind: 'show-seen', papers } as const;
  }
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
