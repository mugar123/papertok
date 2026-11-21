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
 * The placement for `target`, given the boxes the panel takes at each edge:
 * the edge that leaves it clear, the bottom first; else, when the panel
 * cannot cover it entirely at both, the edge that covers it less (the bottom
 * on a tie); else hidden.
 */
export function choosePlacement({ target, boxes }: { target: ScreenBox; boxes: Record<Edge, ScreenBox> }): Placement {
  const bottom = overlapArea(target, boxes.bottom);
  const top = overlapArea(target, boxes.top);
  if (bottom === 0) return { edge: 'bottom', hidden: false };
  if (top === 0) return { edge: 'top', hidden: false };
  const targetArea = (target.right - target.left) * (target.bottom - target.top);
  if (bottom >= targetArea && top >= targetArea) return { edge: 'bottom', hidden: true };
  return { edge: top < bottom ? 'top' : 'bottom', hidden: false };
}

/** Where keyboard focus is: nowhere that matters, inside the panel, or on a control of the page. */
export type FocusState = { kind: 'none' } | { kind: 'inside' } | { kind: 'control'; box: ScreenBox };

/**
 * The panel's placement over time. `measure` puts the panel at an edge and
 * returns the box it takes, `apply` leaves it in the placement chosen.
 *
 * Two things never move it: focus inside the panel, because pressing its own
 * button must not take it from under the pointer or the reader's finger, and
 * a pointer press, whose click must land where the press began. A change
 * asked for during a press is made when the last pointer is released.
 */
export function createNudgePlacer({ focus, measure, apply }: { focus: () => FocusState; measure: (edge: Edge) => ScreenBox; apply: (placement: Placement) => void }) {
  const pressing = new Set<number>();
  let pending = false;
  const place = () => {
    if (pressing.size > 0) {
      pending = true;
      return;
    }
    const state = focus();
    if (state.kind === 'inside') return;
    if (state.kind === 'none') {
      apply(HOME_PLACEMENT);
      return;
    }
    apply(choosePlacement({ target: state.box, boxes: { bottom: measure('bottom'), top: measure('top') } }));
  };
  /**
   * Forgets every press when \`clear\` is set, for a press whose release never
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
 * window loses focus. Returns what removes it all.
 */
export function bindNudgePlacement(placer: ReturnType<typeof createNudgePlacer>, { doc, win, requestFrame, cancelFrame }: { doc: Listenable; win: Listenable; requestFrame: (callback: () => void) => number; cancelFrame: (frame: number) => void }) {
  let frame = 0;
  let scheduled = false;
  const placeNextFrame = () => {
    if (scheduled) return;
    scheduled = true;
    frame = requestFrame(() => {
      scheduled = false;
      placer.place();
    });
  };
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
  return () => {
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
