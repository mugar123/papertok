export type DrawOutcome = 'drawn' | 'failed' | 'cancelled';

/** Distinct pages that must fail, with none drawn, before the PDF is handed off. */
const FAILED_PAGES_BEFORE_HAND_OFF = 3;

/**
 * Counts the page draws of one PDF to decide when it cannot be shown here.
 * Several pages start drawing together, so one page failing says nothing while
 * another is still drawing. Only the pages near the screen start drawing, which
 * on a phone in landscape is page 1 alone, so failures are not judged from them:
 * once every draw in flight has failed and none has been drawn, the next page
 * not yet failed is tried, and the PDF is handed off only when three distinct
 * pages (or all of them, if fewer) have failed.
 */
export function createPageDraws() {
  let inFlight = 0;
  let drawn = false;
  const failed = new Set<number>();
  return {
    start() {
      inFlight += 1;
    },
    /**
     * Records how page `number` of `count` ended a started draw. Returns
     * 'hand-off' when the PDF should be handed off, the number of a page to
     * draw even off screen, or null when nothing needs to happen. A cancelled
     * draw decides nothing: it is a page scrolled away or a viewer closing.
     */
    settle(number: number, count: number, outcome: DrawOutcome): 'hand-off' | number | null {
      inFlight -= 1;
      if (outcome === 'cancelled') return null;
      if (outcome === 'drawn') drawn = true;
      if (outcome === 'failed') failed.add(number);
      if (drawn || failed.size === 0 || inFlight > 0) return null;
      if (failed.size >= Math.min(count, FAILED_PAGES_BEFORE_HAND_OFF)) return 'hand-off';
      let next = 1;
      while (failed.has(next)) next += 1;
      return next;
    },
  };
}
