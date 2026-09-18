/**
 * The deck's index, and nothing else: which paper is on the sheet, what Skip
 * does at the end (goes on to the clone of the first, which the DOM driver
 * then swaps for the real first without travel), and what the counter says.
 * Pure, so it is tested without a DOM; the driver in motion.js (armDeck)
 * owns the transition, the keys and the focus.
 *
 * Imported by motion.js, not pasted into it: motion.js is a real ES module
 * (see its own file header), so nothing stops it importing this directly —
 * only a from-scratch IIFE would need the copy the brief describes, and a
 * pasted copy here would be the exact verbatim duplication this codebase's
 * own conventions elsewhere (shouldAnimate, armLevels) exist to avoid.
 *
 * next() and prev() BOTH return `{ jumpTo, index }` — decision (B)
 * overrides the brief, which gave the two functions different return
 * shapes for no reason. `jumpTo` is the slide to teleport to before
 * travelling, or null. Forward motion never needs a pre-travel teleport —
 * the reel always has a clone sitting right after the last real paper to
 * travel onto normally — so next()'s jumpTo is always null; only prev()
 * from the first paper needs one, onto that same clone, so the trip back
 * to the last paper is a short, real one instead of a jump across the
 * whole reel.
 */
export function createDeck({ count, index = 0 } = {}) {
  let i = index;
  const label = () => `${(i % count) + 1} / ${count}`;
  return {
    index: () => i,
    label,
    /* i === count is the clone, appended once after the last real paper. */
    atClone: () => i === count,
    /* Forward, or nothing while the clone is still travelling: i is
       already pinned at count, and this simply repeats it — see settle()
       below for why nothing here auto-settles that on its own. */
    next() {
      if (i < count) i += 1;
      return { jumpTo: null, index: i };
    },
    /* Backward; from the first, the driver jumps to the clone first (no
       travel) and then travels back to the last. */
    prev() {
      if (i === 0) { i = count - 1; return { jumpTo: count, index: i }; }
      i -= 1;
      return { jumpTo: null, index: i };
    },
    /* Once the clone has visually arrived, the real first takes its
       place. Called by the driver on its own transitionend (or, under
       reduced motion, immediately — there is no transition to wait for),
       never by next() itself: next() only advances the index, it has no
       way to know whether the CSS transition it triggered has actually
       finished landing on the clone. */
    settle() {
      if (i === count) i = 0;
      return i;
    },
  };
}
