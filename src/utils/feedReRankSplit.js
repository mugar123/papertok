/**
 * Where a re-rank may start shuffling.
 *
 * A re-rank locks the cards the reader is on or about to reach and shuffles
 * the rest. The lock used to start at the paper the interaction named, or at
 * index 0 when there was none — which assumed the reader was at the top.
 * Since a reload puts the reader back on the card they left (586b827,
 * 2026-09-03), that place is usually deeper, and the profile load's anchorless
 * re-rank (ade641a) shuffled the very card under the viewport 1–3 s after the
 * reload (reported 2026-09-04). The split now takes every anchor it is given
 * — the interacted paper, the visible paper — and locks through the deepest.
 */
export const RERANK_LOOKAHEAD = 3;

export function splitFeedForReRank(papers, { anchorPaperIds = [], lookahead = RERANK_LOOKAHEAD } = {}) {
  const list = Array.isArray(papers) ? papers : [];
  let anchorIndex = 0;
  for (const id of anchorPaperIds) {
    if (!id) continue;
    const found = list.findIndex(paper => paper?.id === id);
    if (found > anchorIndex) anchorIndex = found;
  }
  const safeSplit = Math.min(anchorIndex + lookahead, list.length);
  return {
    anchorIndex,
    locked: list.slice(0, safeSplit),
    queue: list.slice(safeSplit),
  };
}
