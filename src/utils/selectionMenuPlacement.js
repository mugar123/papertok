/**
 * Where the selection menu goes.
 *
 * Its own module for two reasons: a file that exports both a component and a
 * function is not a Fast Refresh boundary, and this is the part of the menu
 * worth testing — every interesting case is a selection at an edge, which is
 * exactly the case that is tedious to reproduce by hand in a browser.
 */

export const MENU_WIDTH = 244;
export const COMPOSE_WIDTH = 348;
/** Sized for the composer; the menu is shorter and clamps the same way. */
export const MENU_HEIGHT = 210;
const EDGE_GAP = 10;
const ANCHOR_GAP = 8;

/**
 * Under the passage when there is room, above it when there is not, and never
 * off the side. Flipping matters most for the composer, which is tall and is
 * usually opened on a paragraph the reader has just finished — that is to say,
 * near the bottom of the screen.
 */
export function placeSelectionMenu(anchor, viewport, composing = false) {
  const width = composing ? COMPOSE_WIDTH : MENU_WIDTH;
  const maxLeft = Math.max(EDGE_GAP, viewport.width - width - EDGE_GAP);
  const left = Math.min(Math.max(EDGE_GAP, anchor.left), maxLeft);

  const below = anchor.bottom + ANCHOR_GAP;
  const fitsBelow = below + MENU_HEIGHT <= viewport.height - EDGE_GAP;
  const top = fitsBelow
    ? below
    : Math.max(EDGE_GAP, anchor.top - MENU_HEIGHT - ANCHOR_GAP);

  return { left, top, width, placement: fitsBelow ? 'below' : 'above' };
}
