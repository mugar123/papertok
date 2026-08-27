/**
 * When the reader's floating control panel is on screen.
 *
 * Pulled out of the component so the rule can be read and tested on its own:
 * the two paths that matter most — a keyboard user tabbing into a hidden panel,
 * and a touch screen with no way to summon one — are the two hardest to
 * reproduce in a browser harness, and the easiest to get wrong.
 */

/** How far up from the bottom edge the pointer wakes the panel. Taller than the
 *  panel itself, so the controls meet you on the way down rather than having to
 *  be hit. */
export const PANEL_REVEAL_ZONE_PX = 140;

/** Grace before it retreats: enough that the boundary cannot flicker, and that
 *  the trip from the text down to the panel is not a race. */
export const PANEL_HIDE_DELAY_MS = 300;

/** Whether a pointer at this height is inside the strip that summons the panel. */
export function pointerWakesPanel(clientY, viewportHeight) {
  if (!Number.isFinite(clientY) || !Number.isFinite(viewportHeight)) return false;
  return clientY >= viewportHeight - PANEL_REVEAL_ZONE_PX;
}

/**
 * Any one of these puts the panel on screen:
 *
 * - `canHover` false — a touch screen has no hover to ask with, so the panel
 *   never hides there and the document keeps reserving room for it.
 * - `hasScrolled` false — it is up when the reader opens, which is what makes it
 *   discoverable at all; starting to read is what puts it away.
 * - `nearBottom` — the pointer is in the strip.
 * - `holdsFocus` — something inside it has keyboard focus. Without this, tabbing
 *   would move the focus ring into a panel nobody can see.
 */
export function panelShouldShow({
  canHover = true,
  hasScrolled = false,
  nearBottom = false,
  holdsFocus = false,
} = {}) {
  return !canHover || !hasScrolled || nearBottom || holdsFocus;
}
