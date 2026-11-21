/**
 * Where a nudge panel sits so it does not hide the control that has keyboard
 * focus (WCAG 2.4.11), decided without a browser: NudgePanel measures, this
 * chooses. The panel is fixed and reserves no room, and the feed's cards fill
 * the screen, so it moves instead of taking room from them.
 *
 * Its home is the bottom edge. When the focused control would be under it
 * there, it tries the top edge, under the navbar. With enlarged text on a
 * small screen the panel can be taller than half the screen and cover the
 * control at both edges, so the last resort is a compact form (its title, a
 * Show button and the dismiss button), which is small enough to clear it.
 * Focus is never moved to make room, and the compact form keeps the notice
 * reachable.
 */

export interface ScreenBox { top: number; bottom: number; left: number; right: number }

export type Edge = 'bottom' | 'top';

export interface Placement { edge: Edge; compact: boolean }

export const HOME_PLACEMENT: Placement = { edge: 'bottom', compact: false };

function overlapArea(a: ScreenBox, b: ScreenBox) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/**
 * The placement for `target`. The full panel stays at the bottom, its home,
 * and takes the top edge when that leaves the control clear and the bottom
 * does not. A control the panel cannot cover entirely (one larger than the
 * panel, such as the page container that takes focus after a route change) is
 * never reason to shrink it, so when no edge leaves it clear the full panel
 * goes where it covers least, the bottom on a tie. The compact form is for the
 * control both full placements hide completely: it takes the edge that leaves
 * it clear, or else where it covers least.
 */
export function choosePlacement({ target, boxes }: { target: ScreenBox; boxes: { full: Record<Edge, ScreenBox>; compact: Record<Edge, ScreenBox> } }): Placement {
  const targetArea = (target.right - target.left) * (target.bottom - target.top);
  const overlap = (kind: 'full' | 'compact', edge: Edge) => overlapArea(target, boxes[kind][edge]);
  const covered = (edge: Edge) => targetArea > 0 && overlap('full', edge) >= targetArea;
  for (const edge of ['bottom', 'top'] as const) {
    if (overlap('full', edge) === 0) return { edge, compact: false };
  }
  if (!(covered('bottom') && covered('top'))) {
    return { edge: overlap('full', 'top') < overlap('full', 'bottom') ? 'top' : 'bottom', compact: false };
  }
  for (const edge of ['bottom', 'top'] as const) {
    if (overlap('compact', edge) === 0) return { edge, compact: true };
  }
  return { edge: overlap('compact', 'top') < overlap('compact', 'bottom') ? 'top' : 'bottom', compact: true };
}

/** Where keyboard focus is: nowhere that matters, inside the panel, or on a control of the page. */
export type FocusState = { kind: 'none' } | { kind: 'inside' } | { kind: 'control'; box: ScreenBox };

/**
 * The panel's placement over time. `measure` puts the panel in a placement and
 * returns the box it takes, `apply` leaves it in the one chosen.
 *
 * Two things never move it: focus inside the panel, because pressing its own
 * button must not take it from under the pointer or the reader's finger, and
 * a pointer press, whose click must land where the press began. A change
 * asked for during a press is made when it is released.
 */
export function createNudgePlacer({ focus, measure, apply }: { focus: () => FocusState; measure: (placement: Placement) => ScreenBox; apply: (placement: Placement) => void }) {
  let current = HOME_PLACEMENT;
  const pressing = new Set<number>();
  let pending = false;
  const settle = (placement: Placement) => {
    current = placement;
    apply(placement);
  };
  const place = () => {
    if (pressing.size > 0) {
      pending = true;
      return;
    }
    const state = focus();
    if (state.kind === 'inside') return;
    if (state.kind === 'none') {
      settle(HOME_PLACEMENT);
      return;
    }
    const boxes = {
      full: { bottom: measure({ edge: 'bottom', compact: false }), top: measure({ edge: 'top', compact: false }) },
      compact: { bottom: measure({ edge: 'bottom', compact: true }), top: measure({ edge: 'top', compact: true }) },
    };
    settle(choosePlacement({ target: state.box, boxes }));
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
    pointerDown(pointerId: number) {
      pressing.add(pointerId);
    },
    /** One pointer lifted. The panel is held until every pointer is. */
    pointerUp(pointerId: number) {
      pressing.delete(pointerId);
      releaseAll(false);
    },
    releaseAll,
    /** The reader asked for the full panel from its compact form: the same edge, in full. */
    expand() {
      settle({ ...current, compact: false });
    },
  };
}
