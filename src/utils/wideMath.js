/**
 * Formulas wider than the reading column.
 *
 * The reader's scroll region clips sideways (`.rd-scroll` has to, for the
 * margin that slides out past its edge), so a long display formula used to be
 * cut at the column's edge with no way to see the rest — on a phone and on a
 * desktop alike. A formula that does not fit now scrolls on its own, with a
 * slider under it. These are the decisions behind that, kept out of the
 * component so they run under node.
 */

/** Pointer targets stay at or above WCAG 2.2's 24 CSS px (2.5.8). */
export const MIN_THUMB_PX = 24;

/** How far one arrow key moves the formula: a few glyphs, not one pixel. */
export const KEY_STEP_PX = 40;

/**
 * Whether an inline formula has to leave the line and scroll.
 *
 * KaTeX lets the browser break an inline formula between its `.base` runs (at
 * relations and binary operators), so a long one usually wraps and needs
 * nothing. What cannot wrap is a single run wider than the line — a big
 * fraction, a matrix, an operator-free product — and that is the test. It does
 * not depend on how the formula is laid out, so turning the formula into a
 * scroller cannot flip the answer back (no oscillation under the observer).
 */
export function inlineMathNeedsScroll(baseWidths, availableWidth) {
  if (!(availableWidth > 0)) return false;
  return baseWidths.some(width => width > availableWidth + 0.5);
}

/** Hidden width of a scroller, in whole pixels; 0 when it fits. */
export function hiddenWidth(scrollWidth, clientWidth) {
  const hidden = Math.ceil(scrollWidth - clientWidth);
  // Sub-pixel rounding leaves a 1px "overflow" on formulas that fit.
  return hidden > 1 ? hidden : 0;
}

/**
 * Width of the slider's thumb: the visible share of the formula, the way a
 * scrollbar thumb shows it, never below the minimum target.
 */
export function sliderThumbWidth(trackWidth, clientWidth, scrollWidth) {
  if (!(trackWidth > 0) || !(scrollWidth > 0)) return MIN_THUMB_PX;
  const share = Math.min(1, clientWidth / scrollWidth);
  return Math.max(MIN_THUMB_PX, Math.round(trackWidth * share));
}

/** What a screen reader hears for the slider's position. */
export function sliderValueText(position, hidden) {
  if (!(hidden > 0)) return 'Start of formula';
  const percent = Math.round((Math.min(Math.max(position, 0), hidden) / hidden) * 100);
  if (percent <= 0) return 'Start of formula';
  if (percent >= 100) return 'End of formula';
  return `${percent}% across the formula`;
}

/** The slider's next position for a key, or null for keys it leaves alone. */
export function sliderKeyTarget(key, position, hidden) {
  const clamp = value => Math.min(Math.max(value, 0), hidden);
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(position - KEY_STEP_PX);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(position + KEY_STEP_PX);
    case 'Home':
      return 0;
    case 'End':
      return hidden;
    default:
      return null;
  }
}
