import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useReducer, useRef } from 'react';
import type { PassageSelection } from './passage-range.ts';
import { passageFromRange, passageRange } from './passage-range.ts';
import { HIGHLIGHT_MIN_QUOTE_LENGTH } from '../../utils/text-highlights.ts';

type Passage = { sectionId: string; quote: string; occurrence?: number };
type Edge = 'start' | 'end';

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/**
 * Two handles flush with the pending passage's edges: a stem the height of the line, with a
 * dot above the first character and below the last. Dragging one moves that end
 * of the passage, a character at a time, within its paragraph; `onMove` gets each step and
 * `onEnd` the passage it settles on (null when it never moved).
 */
export function PassageHandles({ root, passage, onMove, onEnd }: {
  root: HTMLElement;
  passage: Passage;
  onMove: (passage: PassageSelection) => void;
  onEnd: (passage: PassageSelection | null) => void;
}) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const drag = useRef<{ fixed: readonly [Node, number]; dx: number; dy: number; last: PassageSelection | null } | null>(null);
  useEffect(() => {
    root.addEventListener('scroll', redraw, { passive: true });
    window.addEventListener('resize', redraw);
    return () => {
      root.removeEventListener('scroll', redraw);
      window.removeEventListener('resize', redraw);
    };
  }, [root]);

  const block = root.querySelector<HTMLElement>(`[data-passage="${CSS.escape(passage.sectionId)}"]`);
  const range = block && passageRange(block, passage.quote, passage.occurrence);
  const stage = root.parentElement;
  if (!block || !range || !stage) return null;
  const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
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
    const fixed = edge === 'start' ? [range.endContainer, range.endOffset] as const : [range.startContainer, range.startOffset] as const;
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
    const picked = passageFromRange(root, next);
    if (!picked || picked.quote.length < HIGHLIGHT_MIN_QUOTE_LENGTH || picked.quote === passage.quote) return;
    state.last = picked;
    onMove(picked);
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
