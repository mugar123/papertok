import type { Paper } from '../models/Paper.ts';

import type { SettledWithin } from './asyncTiming.ts';
import { PaperBuilder } from '../services/PaperBuilder.ts';
import { fulfilledPaperLists } from './asyncTiming.ts';

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
export function lateSourceCandidates(shownPapers: Array<Partial<Paper>> | null | undefined, settledResults: Array<SettledWithin<Array<Partial<Paper>>>>) {
  const shown = new Set((shownPapers || []).map(paper => paper?.id).filter(Boolean));
  return PaperBuilder.deduplicate(fulfilledPaperLists(settledResults))
    .filter(paper => paper?.id && !shown.has(paper.id));
}
