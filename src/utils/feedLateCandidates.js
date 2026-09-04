import { PaperBuilder } from '../services/PaperBuilder.js';
import { fulfilledPaperLists } from './asyncTiming.js';

/**
 * What the slower sources returned after the page had already painted.
 *
 * `settleSourcesForFirstPaint` resolves `first` as soon as one source has a
 * page's worth of papers; the others keep running and their answers used to
 * be thrown away (measured 2026-09-02: with arXiv answering first, PubMed,
 * OpenAlex and the domain sources of that page never reached a card). These
 * are kept for the NEXT page's candidate pool instead of being appended under
 * the reader — nothing on screen moves, nothing fetched is wasted.
 */
export function lateSourceCandidates(shownPapers, settledResults) {
  const shown = new Set((shownPapers || []).map(paper => paper?.id).filter(Boolean));
  return PaperBuilder.deduplicate(fulfilledPaperLists(settledResults))
    .filter(paper => paper?.id && !shown.has(paper.id));
}
