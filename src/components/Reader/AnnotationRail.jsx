import { useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertCircle, ChevronUp, PenLine, Sparkles, Trash2 } from 'lucide-react';
import { ANNOTATION_FILTERS } from '../../utils/annotationOrder.js';
import { SHEET_DRAG_SLOP, sheetDragOffset, shouldSettleOpen } from '../../utils/sheetDrag.js';
import ThinkingDots from './ThinkingDots.jsx';

/**
 * The margin, kept as a margin.
 *
 * Reads top to bottom in document order, so its shape matches the paper beside
 * it rather than the order things were made. Everything that is not the note
 * itself is deliberately absent — no avatars, no timestamps, no character
 * counts, no status icons — because each of those turns a margin into a feed,
 * and a feed is not something you read a paper next to.
 *
 * Origin is carried by one 3px rule down the inner edge: the brand yellow when
 * you wrote it, ink when the model did. It is the only place the difference is
 * stated, and it is legible without reading a word.
 *
 * On a phone there is no margin to be, so the same component becomes a sheet:
 * pinned to the bottom, peeking by its header, pulled up when wanted. The cards
 * are the same cards — only the container and its header change, which is the
 * whole reason this is one component and not two.
 */
export default function AnnotationRail({
  surface = 'rail',
  hidden = false,
  expanded = true,
  onToggle,
  annotations,
  counts,
  filter,
  onFilter,
  thinking,
  error,
  errorText,
  onFocus,
  onRemove,
  onSettle,
  labelFor,
  copy,
}) {
  const prefersReducedMotion = useReducedMotion();

  const isSheet = surface === 'sheet';

  /* ── Dragging the sheet by its header ──
     The header was already the whole handle, and a handle you can only operate
     by tapping is a handle for a mouse. Pointer events rather than framer: the
     resting states are a CSS `translateY` and a 260ms transition that already
     work, and framer writes an inline transform that would replace the
     stylesheet's wholesale. Here the inline transform exists only while a
     finger is down, and clearing it hands the sheet back to the CSS.

     The gesture is only ever read on the header, so it can never be confused
     with a scroll of the notes underneath. */
  const railRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);

  /* Read from the DOM rather than tracked in state: the sheet's height depends
     on how many notes are in it, and a stale number would settle the gesture
     against a travel the sheet no longer has. */
  const measureTravel = element => {
    const peek = Number.parseFloat(
      getComputedStyle(element).getPropertyValue('--rd-sheet-peek'),
    ) || 0;
    return Math.max(0, element.offsetHeight - peek);
  };

  const handlePointerDown = event => {
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

  const handlePointerMove = event => {
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
    element.dataset.dragging = '';
    element.style.transform = `translateY(${sheetDragOffset({ expanded, deltaY, travel: drag.travel })}px)`;
  };

  const endDrag = (event, { cancelled = false } = {}) => {
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
  // `hidden` covers the desktop rail sliding out of the margin; a collapsed
  // mouse-narrow sheet still peeks by its header and stays reachable, so it
  // is never `hidden`. (The fully-offscreen touch sheet this used to also
  // cover no longer exists — the touch route mounts no rail at all.)
  const inert = hidden;
  const head = (
    <>
      <span className="rd-rail-title">
        <PenLine size={12} />
        {copy.annotations}
      </span>
      <span className="rd-rail-count">{copy.countLine(counts)}</span>
    </>
  );

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
          className="rd-rail-head rd-rail-grab"
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={event => endDrag(event, { cancelled: true })}
          aria-expanded={expanded}
        >
          <span className="rd-rail-grabber" aria-hidden="true" />
          <span className="rd-rail-headline">
            {head}
            <ChevronUp size={16} className="rd-rail-chevron" />
          </span>
        </button>
      ) : (
        <div className="rd-rail-head">{head}</div>
      )}

          <div className="rd-rail-filters" role="group" aria-label={copy.annotations}>
            {ANNOTATION_FILTERS.map(value => (
              <button
                key={value}
                type="button"
                className="rd-rail-filter"
                data-on={filter === value ? '' : undefined}
                aria-pressed={filter === value}
                onClick={() => onFilter(value)}
              >
                {copy.filters[value]}
              </button>
            ))}
          </div>

          <div className="rd-rail-list">
            <AnimatePresence initial={false}>
              {thinking && (
                <motion.div
                  key="thinking"
                  className="rd-note rd-note--ai rd-note--thinking"
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion
                    ? { opacity: 0, transition: { duration: 0.12 } }
                    : { opacity: 0, y: -4, transition: { duration: 0.18, ease: 'easeIn' } }}
                  transition={{ duration: prefersReducedMotion ? 0.12 : 0.22, ease: [0.16, 1, 0.3, 1] }}
                >
                  <span className="rd-note-origin">
                    <ThinkingDots />
                    {copy.reading}
                  </span>
                  <span className="rd-note-bar" />
                  <span className="rd-note-bar rd-note-bar--short" />
                </motion.div>
              )}

              {error && (
                <motion.p
                  key="error"
                  className="rd-note rd-note--failed"
                  role="alert"
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                >
                  <AlertCircle size={13} />
                  {errorText}
                </motion.p>
              )}

              {annotations.map(annotation => (
                <motion.div
                  key={annotation.id}
                  /* No `layout` here on purpose. It reads every card's box on every
                     render of the reader, and a forced layout on this page costs
                     milliseconds — while buying nothing the exit does not already
                     give: a removed card animates its own height to zero, so the
                     cards below slide up on that same curve. */
                  className="rd-note"
                  data-kind={annotation.kind === 'ai' ? 'ai' : 'user'}
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={prefersReducedMotion
                    ? { opacity: 0, transition: { duration: 0.12 } }
                    : { opacity: 0, x: -8, height: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, transition: { duration: 0.18, ease: 'easeIn' } }}
                  transition={{ duration: prefersReducedMotion ? 0.12 : 0.22, ease: [0.16, 1, 0.3, 1] }}
                  onAnimationComplete={() => { if (annotation.fresh) onSettle(annotation.id); }}
                >
                  <div className="rd-note-head">
                    <span className="rd-note-origin">
                      {annotation.kind === 'ai' && <Sparkles size={10} />}
                      {annotation.kind === 'ai' ? copy.originAi : copy.originMine}
                    </span>
                    {/* The anchor doubles as the way back to the passage. */}
                    <button
                      type="button"
                      className="rd-note-where"
                      onClick={() => onFocus(annotation)}
                      title={copy.goToPassage}
                    >
                      {labelFor(annotation)}
                    </button>
                    <button
                      type="button"
                      className="rd-note-remove"
                      onClick={() => onRemove(annotation.id)}
                      aria-label={copy.removeAnnotation}
                      title={copy.removeAnnotation}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <p className="rd-note-quote">{annotation.quote}</p>
                  {annotation.note && (
                    <p className="rd-note-body" data-fresh={annotation.fresh && annotation.kind === 'ai' ? '' : undefined}>
                      {annotation.note}
                    </p>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>

            {annotations.length === 0 && !thinking && !error && (
              <p className="rd-rail-empty">
                {filter === 'all' ? copy.emptyAll : copy.emptyFiltered}
              </p>
            )}
          </div>

    </aside>
  );
}
