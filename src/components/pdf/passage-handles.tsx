import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useReducer, useRef } from 'react';
import { HIGHLIGHT_MIN_QUOTE_LENGTH } from '../../utils/text-highlights.ts';

type Edge = 'start' | 'end';
const words = (range: Range) => range.toString().replace(/\s+/g, ' ').trim();

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/**
 * Two handles flush with the pending passage's edges: a stem the height of the line, with a
 * dot above the first character and below the last. Dragging one moves that end
 * of the passage, a character at a time, within its block (`[data-passage]`); `onMove` gets
 * each step and `onEnd` the range it settles on (null when it never moved). Ranges in and
 * out, so the viewer and the reader each turn them into their own passage.
 */
export function PassageHandles({ root, range, onMove, onEnd }: {
  root: HTMLElement;
  /** Read at each render, so the handles follow the text as it scrolls or reflows. */
  range: () => Range | null;
  onMove: (range: Range) => void;
  onEnd: (range: Range | null) => void;
}) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const drag = useRef<{ fixed: readonly [Node, number]; dx: number; dy: number; last: Range | null } | null>(null);
  // Read once more after the first paint: a passage drawn in the same render as the handles
  // (the reader's provisional marks) is not in the page until then.
  useEffect(() => {
    const frame = requestAnimationFrame(redraw);
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    root.addEventListener('scroll', redraw, { passive: true });
    window.addEventListener('resize', redraw);
    return () => {
      root.removeEventListener('scroll', redraw);
      window.removeEventListener('resize', redraw);
    };
  }, [root]);

  const current = range();
  const start = current?.startContainer;
  const block = (start instanceof Element ? start : start?.parentElement)?.closest<HTMLElement>('[data-passage]');
  const stage = root.parentElement;
  // A passage across blocks (the reader's, over paragraphs) has no handle to move within one.
  if (!current || !block || !stage || !block.contains(current.endContainer)) return null;
  const rects = [...current.getClientRects()].filter(rect => rect.width > 0);
  if (!rects.length) return null;
  const view = root.getBoundingClientRect();
  const origin = stage.getBoundingClientRect();
  const first = rects[0];
  const last = rects[rects.length - 1];
  const points: Record<Edge, { x: number; top: number; bottom: number }> = {
    start: { x: first.left, top: first.top, bottom: first.bottom },
    end: { x: last.right, top: last.top, bottom: last.bottom },
  };

  const down = (edge: Edge) => (event: ReactPointerEvent<HTMLDivElement>) => {
    // No focus change and no text selection: the editor stays open while the passage is adjusted.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = points[edge];
    // The other end stays put for the whole drag, even when the dragged end crosses it.
    const fixed = edge === 'start' ? [current.endContainer, current.endOffset] as const : [current.startContainer, current.startOffset] as const;
    drag.current = { fixed, dx: point.x - event.clientX, dy: (point.top + point.bottom) / 2 - event.clientY, last: null };
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    // The handle's stem sits on the text's edge, so it steps aside while the caret is found.
    const handle = event.currentTarget;
    handle.style.pointerEvents = 'none';
    const caret = caretAt(event.clientX + state.dx, event.clientY + state.dy);
    handle.style.pointerEvents = '';
    if (!caret || !block.contains(caret.node)) return;
    const { fixed } = state;
    const next = document.createRange();
    next.setStart(caret.node, caret.offset);
    next.setEnd(caret.node, caret.offset);
    if (next.comparePoint(fixed[0], fixed[1]) >= 0) next.setEnd(fixed[0], fixed[1]);
    else next.setStart(fixed[0], fixed[1]);
    const quote = words(next);
    if (quote.length < HIGHLIGHT_MIN_QUOTE_LENGTH || quote === words(current)) return;
    state.last = next;
    onMove(next);
  };
  const up = () => {
    const state = drag.current;
    drag.current = null;
    if (state) onEnd(state.last);
  };

  return (['start', 'end'] as const).map((edge) => {
    const point = points[edge];
    if (point.bottom < view.top || point.top > view.bottom) return null;
    return (
      <div
        key={edge}
        aria-hidden="true"
        className="vn-handle"
        data-edge={edge}
        style={{ left: point.x - origin.left, top: point.top - origin.top, height: point.bottom - point.top }}
        onPointerDown={down(edge)}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
    );
  });
}
