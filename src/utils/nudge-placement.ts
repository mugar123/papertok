/**
 * Where a nudge panel sits so it never hides the control that has keyboard
 * focus (WCAG 2.4.11), decided without a browser: NudgePanel measures and
 * applies, this chooses and listens. The panel is fixed and reserves no room,
 * and the feed's cards fill the screen, so it moves instead of taking room
 * from them.
 *
 * One rule. Its home is the bottom edge. When the focused control would be
 * under it there it takes the top edge, under the navbar. When the control
 * would be entirely under it at both edges, as with enlarged text on a small
 * screen where the notice is taller than half the screen, the panel is hidden
 * (and inert, so nothing in it can take focus) until focus moves to a control
 * it does not cover. Hiding never moves focus and never dismisses the notice:
 * it comes back by itself. A control larger than the panel, such as the page
 * container that takes focus after a route change, cannot be entirely covered
 * and never hides it.
 *
 * The panel is also hidden when it cannot fit on screen at all: taller than the
 * room between the top edge and the bottom edge, as with enlarged text on a
 * very short window. It has no height limit and no scrolling of its own, so
 * controls of it that sit off screen could not be reached, and the notice is
 * optional (ORCID connects in My profile, email is set in Settings). It comes
 * back when the window grows.
 */

export interface ScreenBox { top: number; bottom: number; left: number; right: number }

export type Edge = 'bottom' | 'top';

export interface Placement { edge: Edge; hidden: boolean }

export const HOME_PLACEMENT: Placement = { edge: 'bottom', hidden: false };

/** The part of `box` inside a viewport of this size: what the reader can actually see of it. */
export function clipToViewport(box: ScreenBox, viewport: { width: number; height: number }): ScreenBox {
  return { left: Math.max(0, box.left), top: Math.max(0, box.top), right: Math.min(viewport.width, box.right), bottom: Math.min(viewport.height, box.bottom) };
}

function overlapArea(a: ScreenBox, b: ScreenBox) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/**
 * Whether the panel fits on screen: its height is no more than the room from
 * where the top edge starts (under the navbar) to where the bottom edge ends.
 * Both come from the boxes it takes at each edge.
 */
// The panel's height cancels out of this: it is the same as the bottom edge's box starting
// at or below where the top edge's starts. That is also why a panel still animating in (scaled,
// shifted) does not flicker between fitting and not: both boxes move together.
export function fitsOnScreen(boxes: Record<Edge, ScreenBox>) {
  return boxes.bottom.bottom - boxes.bottom.top <= boxes.bottom.bottom - boxes.top.top;
}

/**
 * The placement for `target`, given the boxes the panel takes at each edge:
 * hidden when it does not fit on screen; else the edge that leaves the control
 * clear, the bottom first; else, when the panel cannot cover it entirely at
 * both, the edge that covers it less (the bottom on a tie); else hidden.
 */
export function choosePlacement({ target, boxes }: { target: ScreenBox; boxes: Record<Edge, ScreenBox> }): Placement {
  if (!fitsOnScreen(boxes)) return { edge: 'bottom', hidden: true };
  const bottom = overlapArea(target, boxes.bottom);
  const top = overlapArea(target, boxes.top);
  if (bottom === 0) return { edge: 'bottom', hidden: false };
  if (top === 0) return { edge: 'top', hidden: false };
  const targetArea = (target.right - target.left) * (target.bottom - target.top);
  if (bottom >= targetArea && top >= targetArea) return { edge: 'bottom', hidden: true };
  return { edge: top < bottom ? 'top' : 'bottom', hidden: false };
}

/** Where keyboard focus is: nowhere that matters, inside the panel, or on a control of the page. */
// `ref` is whatever lets the page find the control again (its element), which the placer hands back to restoreFocus.
export type FocusState = { kind: 'none' } | { kind: 'inside' } | { kind: 'control'; box: ScreenBox; ref?: unknown };

/**
 * The panel's placement over time. `measure` puts the panel at an edge and
 * returns the box it takes, `apply` leaves it in the placement chosen; every
 * decision ends in `apply`, so a measurement never leaves the panel at the
 * edge it was measured at.
 *
 * Two things never move it: focus inside the panel, because pressing its own
 * button must not take it from under the pointer or the reader's finger, and
 * a pointer press, whose click must land where the press began. A change
 * asked for during a press is made when the last pointer is released. Focus
 * inside the panel keeps its edge, but not a panel that no longer fits on
 * screen (the window was made smaller): its controls would be off screen, so
 * it is hidden. Hiding a panel that holds focus would drop focus to the page
 * body with no indicator and send the next Tab to the top of the page
 * (WCAG 2.4.3, 2.4.7), so before it is hidden `restoreFocus` is given the
 * control of the page that focus last came from (its `ref`, or undefined when
 * there was none, as after a click into the panel) and puts focus back there.
 */
export function createNudgePlacer({ focus, measure, apply, restoreFocus }: { focus: () => FocusState; measure: (edge: Edge) => ScreenBox; apply: (placement: Placement) => void; restoreFocus: (origin: unknown) => void }) {
  const pressing = new Set<number>();
  let pending = false;
  let deciding = false;
  let current = HOME_PLACEMENT;
  // The control of the page that had focus before it entered the panel.
  let origin: unknown;
  const settle = (placement: Placement) => {
    current = placement;
    apply(placement);
  };
  const decide = () => {
    const state = focus();
    // Focus that left the page controls (a click on plain text) is no origin: a click into the panel after it has none.
    if (state.kind === 'control') origin = state.ref;
    else if (state.kind === 'none') origin = undefined;
    const boxes = { bottom: measure('bottom'), top: measure('top') };
    if (!fitsOnScreen(boxes)) {
      // Focus first: an inert panel that still holds it would drop it to the page body.
      if (state.kind === 'inside') restoreFocus(origin);
      settle({ edge: state.kind === 'inside' ? current.edge : 'bottom', hidden: true });
    } else if (state.kind === 'inside') {
      settle({ edge: current.edge, hidden: false });
    } else if (state.kind === 'none') {
      settle(HOME_PLACEMENT);
    } else {
      settle(choosePlacement({ target: state.box, boxes }));
    }
  };
  const place = () => {
    if (pressing.size > 0) {
      pending = true;
      return;
    }
    // Putting focus back sends a focusin, which asks to place again in the middle of this decision.
    if (deciding) return;
    deciding = true;
    try {
      decide();
    } finally {
      deciding = false;
    }
  };
  /**
   * Forgets every press when `clear` is set, for a press whose release never
   * arrives (a context menu, the window losing focus), so the panel is not held
   * for good. Once none is held, a change asked for meanwhile is made.
   */
  const releaseAll = (clear = true) => {
    if (clear) pressing.clear();
    if (pressing.size > 0 || !pending) return;
    pending = false;
    place();
  };
  return {
    place,
    /**
     * For a notice that content changed, which can only matter to a control of the
     * page that has focus: with nothing focused, or focus inside the panel, the
     * decision depends on the panel's size and the window, which the size notices
     * report, so nothing is measured. Keeps a page that animates all the time from
     * costing two layouts a frame.
     */
    placeForContent() {
      if (focus().kind === 'control') place();
    },
    pointerDown(pointerId: number) {
      pressing.add(pointerId);
    },
    /** One pointer lifted. The panel is held until every pointer is. */
    pointerUp(pointerId: number) {
      pressing.delete(pointerId);
      releaseAll(false);
    },
    releaseAll,
  };
}

interface Listenable {
  addEventListener(type: string, listener: (event: Event) => void, options?: boolean | { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: boolean | { capture?: boolean }): void;
}

/**
 * Connects a placer to the page. It places when focus arrives and again a
 * frame later (focusin fires before the browser scrolls the control into
 * view), when the screen is resized, when anything scrolls and a frame after
 * focus leaves a control. A scroll does not bubble, so it is heard in the
 * capture phase, which also covers the feed's own scrolling container; scrolls
 * and focus changes place at most once a frame. Focus can fall back to the page
 * with no focusin after it (a click on plain text), and a panel hidden for the
 * control it covered must come back then. A press is held from pointerdown to
 * pointerup or pointercancel, and forgotten at a context menu or when the
 * window loses focus.
 *
 * Layout can also change under a control that keeps focus, with no focus,
 * scroll or resize event: content above it grows, an image loads, a panel
 * opens, a transition ends. `observeLayout` is told when the page's layout may
 * have changed (the page connects whatever it can observe cheaply) and the
 * panel is placed again a frame later, once however many were reported. A
 * change of size (the window, the panel) always asks for a decision; a change
 * of content only when a control of the page has focus.
 * Returns what removes it all.
 */
export function bindNudgePlacement(placer: ReturnType<typeof createNudgePlacer>, { doc, win, requestFrame, cancelFrame, observeLayout }: { doc: Listenable; win: Listenable; requestFrame: (callback: () => void) => number; cancelFrame: (frame: number) => void; observeLayout: (notify: { size: () => void; content: () => void }) => () => void }) {
  let frame = 0;
  let scheduled = false;
  let full = false;
  // `full` asks for a decision whatever has focus; otherwise only a control of the page has one made.
  const schedule = (wantsFull: boolean) => {
    full ||= wantsFull;
    if (scheduled) return;
    scheduled = true;
    frame = requestFrame(() => {
      scheduled = false;
      const wasFull = full;
      full = false;
      if (wasFull) placer.place();
      else placer.placeForContent();
    });
  };
  const placeNextFrame = () => schedule(true);
  const pointerId = (event: Event) => (event as Event & { pointerId?: number }).pointerId ?? 0;
  const onFocus = () => {
    placer.place();
    placeNextFrame();
  };
  const onPlace = () => placer.place();
  const onDown = (event: Event) => placer.pointerDown(pointerId(event));
  const onUp = (event: Event) => placer.pointerUp(pointerId(event));
  const onReleaseAll = () => placer.releaseAll();
  doc.addEventListener('focusin', onFocus);
  doc.addEventListener('focusout', placeNextFrame);
  doc.addEventListener('scroll', placeNextFrame, { capture: true, passive: true });
  doc.addEventListener('pointerdown', onDown, true);
  doc.addEventListener('pointerup', onUp, true);
  doc.addEventListener('pointercancel', onUp, true);
  doc.addEventListener('contextmenu', onReleaseAll, true);
  win.addEventListener('resize', onPlace);
  win.addEventListener('blur', onReleaseAll);
  const stopObserving = observeLayout({ size: placeNextFrame, content: () => schedule(false) });
  return () => {
    stopObserving();
    if (scheduled) cancelFrame(frame);
    scheduled = false;
    doc.removeEventListener('focusin', onFocus);
    doc.removeEventListener('focusout', placeNextFrame);
    doc.removeEventListener('scroll', placeNextFrame, { capture: true });
    doc.removeEventListener('pointerdown', onDown, true);
    doc.removeEventListener('pointerup', onUp, true);
    doc.removeEventListener('pointercancel', onUp, true);
    doc.removeEventListener('contextmenu', onReleaseAll, true);
    win.removeEventListener('resize', onPlace);
    win.removeEventListener('blur', onReleaseAll);
  };
}

/**
 * Where focus goes when the panel is hidden with focus inside it: the control
 * of the page it came from while that is still on the page, else the page
 * container `fallback` names, where a route change leaves focus. Null when
 * neither exists, and focus is then left to the browser.
 */
export function restoreTarget<T>(origin: T | undefined, { usable, fallback }: { usable: (origin: T) => boolean; fallback: () => T | null }): T | null {
  return origin !== undefined && usable(origin) ? origin : fallback();
}
