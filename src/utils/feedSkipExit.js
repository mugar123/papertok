/**
 * Skip's exit: where the card that is leaving has to be pinned while it goes.
 *
 * Pressing Skip used to be the one action on the card with no answer at all.
 * The paper left `papers` and the next one was in its place in the same frame
 * — no travel, nothing to follow, and on a feed where every card fills the
 * screen that reads as a glitch rather than as a dismissal.
 *
 * The card leaves by being taken OUT OF FLOW, not by being animated in place:
 * the moment it goes absolute the list reflows and the successor occupies the
 * slot exactly as it does today, while the card that was skipped travels away
 * on top of it. That keeps the reveal instant, keeps the scroll position and
 * the snap points out of the animation entirely, and leaves the exit itself
 * on `transform` and `opacity`, which cost the compositor nothing.
 *
 * Pinning it needs the slot it occupied. Every snap item is exactly one
 * container tall (`height: 100%`, `contain-intrinsic-size: 0 100%` in
 * FeedContainer.css), so that slot is the card's index times the container's
 * own height — no DOM query, and no escaping the paper ids that carry slashes
 * and colons (see utils/firestoreDocId.js for what those ids look like).
 */

/**
 * How long the card takes to leave. The removal is deferred by this much, so
 * it is also the longest a skip can be pending.
 *
 * 300ms is the top of the range for a UI exit, and this one earns it: what is
 * leaving is a card the height and width of the screen, which is drawer scale,
 * not dropdown scale. The first cut was 260ms on the house expo and measured
 * beautifully while being invisible — 74% of the distance inside three
 * frames, and the rest a sliver creeping off-screen. Expo brakes at the end,
 * and the end of a departure happens where nobody is looking.
 */
export const SKIP_EXIT_MS = 300;

/**
 * The slot to pin the leaving card in, or `null` when there is nothing to
 * animate — an id the list does not have, or a container that has not been
 * measured yet. A null is not a failure: the caller removes the card at once,
 * which is what happened before this existed.
 */
export function skipExitSlot({ papers, paperId, cardHeight } = {}) {
  if (!paperId || !Array.isArray(papers)) return null;
  if (!Number.isFinite(cardHeight) || cardHeight <= 0) return null;
  const index = papers.findIndex(paper => paper?.id === paperId);
  if (index < 0) return null;
  return { id: paperId, top: index * cardHeight, height: cardHeight };
}
