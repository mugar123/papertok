import type { PointerEvent } from 'react';
import type { ReaderCopy } from './PaperReader.tsx';
import type { PassageAnnotation } from '../../hooks/usePassageAnnotations.ts';
type RailAnnotation = PassageAnnotation;
interface AnnotationRailProps {
  surface?: 'rail' | 'sheet'; hidden?: boolean; expanded?: boolean; onToggle: () => void;
  annotations: RailAnnotation[]; pins?: ReadonlyMap<string, { number: number }>; answerAt?: number | null;
  counts: { all: number; mine: number; ai: number }; filter: string; onFilter: (filter: string) => void;
  thinking: boolean;
  onFocus: (annotation: RailAnnotation) => void; onRemove: (id: string) => void;
  labelFor: (annotation: RailAnnotation) => string; copy: ReaderCopy;
}
import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Copy, DotsThree, Sparkle, Trash, User } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { annotationMarkdown } from '../../utils/annotationMarkdown.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.tsx';
import { ANNOTATION_FILTERS } from '../../utils/annotationOrder.ts';
import { revealScrollDelta } from '../../utils/railReveal.ts';
import { SHEET_DRAG_SLOP, sheetDragOffset, shouldSettleOpen } from '../../utils/sheetDrag.ts';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.tsx';
import ScientificText from '../ScientificText.ts';
import ThinkingDots from './ThinkingDots.tsx';
import Petri from '../Onboarding/Petri.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { EASE_IN_OUT, EASE_OUT, EASE_OUT_EXPO, EASE_OUT_QUAD } from '../../utils/motionCurves.ts';

/**
 * The margin, kept as a margin.
 *
 * Reads top to bottom in document order, so its shape matches the paper beside
 * it rather than the order things were made. Everything that is not the note
 * itself is deliberately absent — no avatars, no timestamps — because each of
 * those turns a margin into a feed, and a feed is not something you read a
 * paper next to.
 *
 * On a narrow screen there is no margin to be, so the same component becomes a
 * sheet: pinned to the bottom, peeking by its grab bar, pulled up when wanted. The cards
 * are the same cards — only the container and its header change, which is the
 * whole reason this is one component and not two.
 */
export default function AnnotationRail({
  surface = 'rail',
  hidden = false,
  expanded = true,
  onToggle,
  annotations,
  pins,
  answerAt = null,
  counts,
  filter,
  onFilter,
  thinking,
  onFocus,
  onRemove,
  labelFor,
  copy,
}: AnnotationRailProps) {
  const prefersReducedMotion = useReducedMotion();

  const isSheet = surface === 'sheet';

  /* ── Keeping the wheel only while there is something to scroll ──
     `overscroll-behavior: contain` (Annotations.css) is keyed on this flag:
     Chrome cuts the scroll chain at a scroll container even when it has
     nothing to scroll, so over a margin whose notes fit, the wheel moved
     neither the list nor the paper. The list's own box changes whenever its
     content crosses the cap, which is what the observer hears; the measure
     after every render covers content that grows under a list already capped. */
  const listRef = useRef<HTMLDivElement | null>(null);
  const measureOverflowRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = () => {
      const scrollable = list.scrollHeight > list.clientHeight + 1;
      if (scrollable) list.dataset.scrollable = '';
      else delete list.dataset.scrollable;
      list.toggleAttribute('data-more-above', scrollable && list.scrollTop > 1);
      list.toggleAttribute('data-more-below', scrollable && list.scrollTop + list.clientHeight < list.scrollHeight - 1);
    };
    measureOverflowRef.current = measure;
    measure();
    list.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(list);
    return () => {
      list.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, []);
  useEffect(() => {
    measureOverflowRef.current?.();
  });

  /* ── Bringing an answer into view ──
     "Explain this" writes into the margin, and the margin may be scrolled
     anywhere: the card that says the model is reading and the answer that
     takes its place each come into view as they appear. Only the list
     scrolls — the paper stays where the reader left it. */
  const freshAnswer = annotations.find(item => item.fresh && item.kind === 'ai')?.id ?? null;
  const revealKey = thinking ? 'thinking' : freshAnswer;
  useEffect(() => {
    const list = listRef.current;
    if (!revealKey || !list) return;
    const card = [...list.querySelectorAll<HTMLElement>('[data-reveal]')]
      .find(node => node.dataset.reveal === revealKey);
    if (!card) return;
    const delta = revealScrollDelta(list.getBoundingClientRect(), card.getBoundingClientRect());
    if (Math.abs(delta) >= 1) {
      list.scrollBy({ top: delta, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    }
  }, [prefersReducedMotion, revealKey]);

  /* ── Dragging the sheet by its header ──
     The header was already the whole handle, and a handle you can only operate
     by tapping is a handle for a mouse. Pointer events rather than framer: the
     resting states are a CSS `translateY` and a 260ms transition that already
     work, and framer writes an inline transform that would replace the
     stylesheet's wholesale. Here the inline transform exists only while a
     finger is down, and clearing it hands the sheet back to the CSS.

     The gesture is only ever read on the header, so it can never be confused
     with a scroll of the notes underneath. */
  const railRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; lastY: number; lastTime: number; velocity: number; moved: number; travel: number } | null>(null);
  const suppressClickRef = useRef(false);

  /* Read from the DOM rather than tracked in state: the sheet's height depends
     on how many notes are in it, and a stale number would settle the gesture
     against a travel the sheet no longer has. */
  const measureTravel = (element: HTMLElement) => {
    const peek = Number.parseFloat(
      getComputedStyle(element).getPropertyValue('--rd-sheet-peek'),
    ) || 0;
    return Math.max(0, element.offsetHeight - peek);
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!isSheet || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const element = railRef.current;
    if (!element) return;
    // Armed by the end of a drag and disarmed by the click that follows it —
    // except that a drag does not always produce one. A `pointercancel` never
    // does, and left standing the flag would eat the next tap instead, which
    // reads as a header that has stopped responding. Every gesture starts clean.
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
      moved: 0,
      travel: measureTravel(element),
    };
    // Capture keeps a drag with the header once the finger has left it, which
    // is most of a drag. It throws `NotFoundError` if the pointer is already
    // gone — a tap fast enough that `pointerup` arrived first — and losing
    // capture is not worth losing the gesture over: touch pointers are captured
    // implicitly anyway, so only a mouse drag off the header degrades.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No capture, still a drag.
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const deltaY = event.clientY - drag.startY;
    drag.moved = Math.max(drag.moved, Math.abs(deltaY));

    // Instantaneous rather than averaged over the gesture: what decides a flick
    // is how fast the finger was going when it left, not how fast it went.
    const elapsed = event.timeStamp - drag.lastTime;
    if (elapsed > 0) drag.velocity = (event.clientY - drag.lastY) / elapsed;
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;

    // Under the slop it is still a tap, and a tap must not leave a transform
    // behind or the header twitches every time it is pressed.
    if (drag.moved < SHEET_DRAG_SLOP) return;
    const element = railRef.current;
    element!.dataset.dragging = '';
    element!.style.transform = `translateY(${sheetDragOffset({ expanded, deltaY, travel: drag.travel })}px)`;
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>, { cancelled = false } = {}) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;

    const element = railRef.current;
    if (element) {
      delete element.dataset.dragging;
      element.style.transform = '';
    }

    // A tap: leave it to the click handler, which is also what a keyboard press
    // arrives as.
    if (drag.moved < SHEET_DRAG_SLOP) return;
    // Anything longer is a drag, and the click that follows `pointerup` would
    // toggle a second time.
    suppressClickRef.current = true;
    if (cancelled) return;

    const settled = shouldSettleOpen({
      expanded,
      deltaY: event.clientY - drag.startY,
      travel: drag.travel,
      velocity: drag.velocity,
    });
    if (settled !== expanded) onToggle();
  };

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onToggle();
  };
  // `hidden` covers the rail sliding out of the margin and the sheet leaving
  // the screen while the notes toggle is off.
  const inert = hidden;

  const listShape = annotations.length + (thinking ? 1 : 0);
  const cards = annotations.map(annotation => (
    <motion.div
      key={annotation.id}
      className="rd-note"
      data-kind={annotation.kind === 'ai' ? 'ai' : 'user'}
      data-reveal={annotation.fresh && annotation.kind === 'ai' ? annotation.id : undefined}
      layout={prefersReducedMotion ? false : 'position'}
      layoutDependency={listShape}
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, transition: { duration: 0.15, ease: EASE_OUT } }}
      transition={prefersReducedMotion
        ? { duration: 0.12 }
        : { duration: 0.2, ease: EASE_OUT, layout: { duration: 0.22, ease: EASE_IN_OUT } }}
    >
      <div className="rd-note-head">
        <span className="rd-note-origin" title={annotation.kind === 'ai' ? copy.originAi : copy.originMine}>
          {annotation.kind === 'ai' ? <Sparkle size={14} aria-hidden="true" /> : <User size={14} aria-hidden="true" />}
          <span className="visually-hidden">{annotation.kind === 'ai' ? copy.originAi : copy.originMine}</span>
        </span>
        {pins?.has(annotation.id) && <span className="rd-note-pin">{pins.get(annotation.id)!.number}</span>}
        {/* The anchor doubles as the way back to the passage. */}
        <button
          type="button"
          className="rd-note-where"
          onClick={() => onFocus(annotation)}
          title={copy.goToPassage}
        >
          {labelFor(annotation)}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button type="button" className="rd-note-actions" aria-label={copy.noteActions} title={copy.noteActions} />}
          >
            <DotsThree size={16} weight="bold" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label={copy.noteActions}>
            <DropdownMenuItem
              onClick={() => {
                navigator.clipboard.writeText(annotationMarkdown(annotation))
                  .then(() => toast.success(copy.noteCopied))
                  .catch(() => toast.error(copy.noteCopyFailed));
              }}
            >
              <Copy size={15} aria-hidden="true" />
              {copy.copyNote}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRemove(annotation.id)}>
              <Trash size={15} aria-hidden="true" />
              {copy.removeAnnotation}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* The passage as the paper sets it: a quote is stored as source text,
          so a highlight across a formula keeps its `$…$`, and printed as prose
          that LaTeX showed raw in the margin. It is in the language the
          rewrite was in when it was marked, which is not always the page's —
          the margin keeps notes from both. */}
      <p className="rd-note-quote" lang={annotation.language}>
        <ScientificText>{annotation.quote}</ScientificText>
      </p>
      {annotation.note && (
        /* The model answers in the rewrite's language; your own note is in
           whatever you typed, so it claims none. */
        <p
          className="rd-note-body"
          data-fresh={annotation.fresh && annotation.kind === 'ai' ? '' : undefined}
          lang={annotation.kind === 'ai' ? annotation.language : undefined}
        >
          {annotation.note}
        </p>
      )}
    </motion.div>
  ));

  /* The card that stands in for an answer while the model reads waits in the
     slot the answer will be filed into (`answerAt`), so the list moves to one
     place, once, and the answer writes itself in where it is going to stay.
     Without a slot it sits at the top. */
  const waiting = [
    thinking && (
      <motion.div
        key="thinking"
        className="rd-note rd-note--ai rd-note--thinking"
        data-reveal="thinking"
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        layout={prefersReducedMotion ? false : 'position'}
        layoutDependency={listShape}
        exit={prefersReducedMotion
          ? { opacity: 0, transition: { duration: 0.12 } }
          : { opacity: 0, scale: 0.97, transition: { duration: 0.18, ease: EASE_OUT } }}
        transition={{ duration: prefersReducedMotion ? 0.12 : 0.22, ease: EASE_OUT_EXPO }}
      >
        <span className="rd-note-origin">
          <ThinkingDots />
          {copy.reading}
        </span>
        <span className="rd-note-bar" />
        <span className="rd-note-bar rd-note-bar--short" />
      </motion.div>
    ),
  ].filter(Boolean);
  const slot = answerAt == null ? 0 : Math.max(0, Math.min(answerAt, cards.length));

  return (
    <aside
      ref={railRef}
      className="rd-rail"
      data-surface={surface}
      data-hidden={hidden ? '' : undefined}
      data-expanded={isSheet && expanded ? '' : undefined}
      /* The rail stays mounted while it is away so it can travel back rather
         than be rebuilt; `inert` is what actually takes it out of reach, and
         it applies immediately while `visibility` waits out the slide. */
      inert={inert}
      aria-hidden={inert ? 'true' : undefined}
      aria-label={copy.annotations}
    >
      {isSheet ? (
        // The whole header is the handle, and it is a handle in both senses: a
        // grabber you can only grab by a 4px bar is a grabber for a mouse, and
        // a handle you can only tap is a handle for a mouse too. Drag it and
        // the sheet follows; tap it and it toggles, as it always did.
        <button
          type="button"
          className="rd-rail-grab"
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={event => endDrag(event, { cancelled: true })}
          aria-expanded={expanded}
          aria-label={copy.annotations}
        >
          <span className="rd-rail-grabber" aria-hidden="true" />
        </button>
      ) : null}

      {/* One filter at a time, and always one: a single-select group
          reports `[]` when the pressed chip is pressed again, and that
          is the one answer the margin refuses — "all" is the resting
          state, not "none". */}
      <ToggleGroup
        className="rd-rail-filters"
        size="sm"
        value={[filter]}
        onValueChange={([next]) => { if (next) onFilter(next); }}
        aria-label={copy.annotations}
      >
        {ANNOTATION_FILTERS.map(value => (
          <ToggleGroupItem key={value} value={value} className="rd-rail-filter">
            {filter === value && (
              <motion.span
                layoutId="rd-filter-chip"
                className="rd-rail-filter-chip"
                aria-hidden="true"
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT_QUAD }}
              />
            )}
            <span className="rd-rail-filter-label">{copy.filters[value as keyof ReaderCopy['filters']]}</span>
            <span className="rd-rail-filter-count">{counts[value as keyof typeof counts]}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <motion.div ref={listRef} className="rd-rail-list" layoutScroll>
        <AnimatePresence key={filter} initial={false} mode="popLayout">
          {[...cards.slice(0, slot), ...waiting, ...cards.slice(slot)]}
        </AnimatePresence>

        {annotations.length === 0 && !thinking && (
          <EmptyState
            as="h3"
            className="rd-rail-empty"
            art={<Petri pose="blankPage" className="rd-rail-empty-petri" />}
            title={copy.emptyAllTitle}
          >
            {copy.emptyAll}
          </EmptyState>
        )}
      </motion.div>
    </aside>
  );
}
