/**
 * Who decides what to do with a selection, and when it is ready to be decided.
 *
 * On a fine pointer nothing changes: `onMouseUp` still fires and the floating
 * menu still opens over the passage. On a coarse pointer that event never
 * arrives — long-pressing text hands the gesture to the OS, which shows its own
 * callout and emits no `mouseup` when the handles are released — so the reader
 * watches `selectionchange` instead and puts the actions in the bottom bar,
 * where they cannot collide with the OS callout sitting over the text.
 */

/** How long the selection must hold still before it counts as a decision.
 *  Capturing on the first `selectionchange` would freeze the first partial
 *  range and destroy the precision that dragging the handles exists to give.
 *  A starting value, to be tuned against a real phone: below this the capture
 *  can fire between two handle adjustments; above it the bar feels sluggish. */
export const SELECTION_SETTLE_MS = 250;

export function pickSelectionRoute({ coarsePointer }) {
  return coarsePointer ? 'bar' : 'menu';
}

export function isUsableSelection({ isCollapsed, rangeCount, text }) {
  if (isCollapsed) return false;
  if (!rangeCount) return false;
  return String(text || '').trim().length > 0;
}
