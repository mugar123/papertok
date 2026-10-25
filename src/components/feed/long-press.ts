/** How long a finger rests on a button before the hold counts, as on iOS. */
export const LONG_PRESS_MS = 500;
// A thumb drifts a few pixels while it rests; more than this is a swipe.
const SLOP_PX = 10;

interface PointerLike {
  pointerType: string;
  clientX: number;
  clientY: number;
}

/**
 * A touch held still on a button for LONG_PRESS_MS. Touch only: a mouse keeps
 * the plain click. While a finger is down, and after a hold, the browser's own
 * long-press menu is held back. The click that ends a hold is reported once
 * (`consumeHold`) so the button does not also run its tap.
 */
export function createLongPress(onLongPress: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin = { x: 0, y: 0 };
  let held = false;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    onPointerDown(event: PointerLike) {
      cancel();
      held = false;
      if (event.pointerType !== 'touch') return;
      origin = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => {
        timer = null;
        held = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove(event: PointerLike) {
      if (timer !== null && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu(event: { preventDefault: () => void }) {
      if (timer !== null || held) event.preventDefault();
    },
    consumeHold() {
      const wasHeld = held;
      held = false;
      return wasHeld;
    },
  };
}
