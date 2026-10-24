// An author's studies and work as one line of stops, evenly spaced rather
// than to scale, like a metro line. Stops take turns above and below the line;
// long text is clamped to two lines, with the full record in the tooltip. A
// career longer than the card fits keeps its first stop and its most recent
// ones, and folds the middle into a "+N more" stop; the button in the
// card's corner opens it in place and folds it again.
//
// The line is drawn as one segment per pair of neighbouring stops, keyed by
// the stop it starts from, so each segment travels and stretches with its two
// dots (`layout`). A segment the line no longer has shrinks away; a new one
// grows in once the dots have arrived.
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import { AnimatePresence, MotionConfig, animate, motion, useReducedMotion } from 'framer-motion';
import { EASE_IN_OUT, EASE_OUT, MOTION_BASE_S, MOTION_SHEET_S } from '../../utils/motion-curves.ts';
import type { CareerStop, Stop } from './career-stops.ts';
import { foldYears, isCurrent, lineStops, stopYears } from './career-stops.ts';
import './career-timeline.css';

type Side = 'below' | 'above';
type Offsets = Map<number, { x: number; y: number }>;

const KIND_LABEL = { study: 'Studies', work: 'Work' } as const;

// What moves across the card takes --motion-sheet on the ease-in-out.
const MOVE = { duration: MOTION_SHEET_S, ease: EASE_IN_OUT };
// A record the fold takes in or lets out is drawn only where it rests: on
// its way into the fold it is gone within the first third of the move, and
// on its way out it shows only for the last third, so travelling records
// never pile up text on the stops they pass.
const FADE_AWAY = { duration: MOTION_SHEET_S / 3, ease: EASE_OUT };
const FADE_IN_LATE = { duration: MOTION_SHEET_S / 3, delay: (MOTION_SHEET_S * 2) / 3, ease: EASE_OUT };

// The narrowest a stop may be (`.career-line` columns) and the gap between.
const STOP_MIN_PX = 86;
const STOP_GAP_PX = 20;

// One mark for the line and the legend.
function Dot({ kind, current, layoutId }: { kind: CareerStop['kind']; current?: boolean; layoutId?: string }) {
  return <motion.span layoutId={layoutId} className="career-dot" data-kind={kind} data-current={current || undefined} />;
}

// Into the fold: a record that closing the fold takes away leaves through
// AnimatePresence (popLayout, so the rest of the line moves at once). It
// travels to the fold by the offset closing measured for it (the presence's
// `custom`), and its text is gone within the first third of the move.
const intoFold = (at: number) => ({
  exit: (offsets: Offsets | null) => {
    const to = offsets?.get(at);
    return {
      opacity: 0,
      transform: to ? `translate(${to.x}px, ${to.y}px)` : 'translate(0px, 0px)',
      transition: { transform: MOVE, opacity: FADE_AWAY },
    };
  },
});

// `ref` reaches the <li>: popLayout measures a leaving record through it. The
// text moves without resizing (`layout="position"`): it rewraps in its new
// place instead of being stretched there.
function Station({ ref, id, stop, at, side, column, onOrganization }: {
  ref?: Ref<HTMLLIElement>; id: string; stop: CareerStop; at: number; side: Side; column: number; onOrganization: (stop: CareerStop) => void;
}) {
  const span = stopYears(stop);
  const current = isCurrent(stop);
  return (
    <motion.li
      ref={ref}
      initial={false}
      variants={intoFold(at)}
      exit="exit"
      className="career-stop"
      data-at={at}
      data-side={side}
      style={{ gridColumn: column }}
      title={[stop.organization, stop.role, span].filter(Boolean).join(' · ')}
    >
      <span className="career-axis" aria-hidden="true">
        <Dot kind={stop.kind} current={current} layoutId={`${id}-dot-${at}`} />
      </span>
      <motion.div layoutId={`${id}-text-${at}`} layout="position" className="career-body">
        <span className="career-years">
          <span className="visually-hidden">{`${KIND_LABEL[stop.kind]}, `}</span>
          {span ?? 'Dates not given'}
        </span>
        <div className="career-text">
          <button type="button" className="career-org" onClick={() => onOrganization(stop)}>
            <span>{stop.organization}</span>
          </button>
          {stop.role && <span className="career-role">{stop.role}</span>}
        </div>
      </motion.div>
    </motion.li>
  );
}

// The fold shows the years it holds; the card's corner button opens it.
function Fold({ ref, id, hidden, side, column }: {
  ref?: Ref<HTMLLIElement>; id: string; hidden: CareerStop[]; side: Side; column: number;
}) {
  const span = foldYears(hidden);
  return (
    <motion.li ref={ref} initial={false} exit={{ opacity: 0, transition: FADE_AWAY }} className="career-stop" data-side={side} style={{ gridColumn: column }}>
      <motion.div layoutId={`${id}-fold`} layout="position" className="career-body">
        {span && <span className="career-years">{span}</span>}
      </motion.div>
    </motion.li>
  );
}

// A segment of the line, from one stop's dot to the next one's. Kept, it
// moves and stretches with the dots on their clock (`layout`). Otherwise it
// comes and goes through AnimatePresence from its left end: it shrinks back
// into that end as the dots leave and grows out of it once they have arrived
// (after their move, --motion-sheet). With reduced motion it fades instead.
// scaleX rather than a transform string: the layout projection composes it.
function Segment({ dashed, style }: { dashed: boolean; style: CSSProperties }) {
  const reduce = useReducedMotion();
  const hidden = reduce ? { opacity: 0 } : { scaleX: 0 };
  const shown = reduce ? { opacity: 1 } : { scaleX: 1 };
  return (
    <motion.span
      layout
      className={`career-rail${dashed ? ' is-dashed' : ''}`}
      aria-hidden="true"
      style={{ ...style, originX: 0 }}
      initial={hidden}
      animate={{ ...shown, transition: { duration: MOTION_BASE_S, ease: EASE_OUT, delay: reduce ? 0 : MOTION_SHEET_S } }}
      exit={{ ...hidden, transition: { duration: MOTION_BASE_S / 2, ease: EASE_OUT } }}
    />
  );
}

export default function CareerTimeline({ career, onOrganization }: { career: CareerStop[]; onOrganization: (stop: CareerStop) => void }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [capacity, setCapacity] = useState(Infinity);
  const listRef = useRef<HTMLOListElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion();
  // The list changes height at once when the fold opens or closes; the card
  // follows it on the dots' clock, so its edge and what is below move with
  // the dots instead of jumping. The first size is taken as it is.
  useLayoutEffect(() => {
    const list = listRef.current;
    const body = bodyRef.current;
    if (!list || !body) return undefined;
    let last: number | null = null;
    const observer = new ResizeObserver(() => {
      const next = list.offsetHeight;
      if (next === last) return;
      if (last === null) body.style.height = `${next}px`;
      else animate(body, { height: `${next}px` }, reduce ? { duration: 0 } : MOVE);
      last = next;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [reduce]);
  // How many stops fit across: the line folds only when they do not.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = () => {
      const { paddingLeft, paddingRight } = getComputedStyle(list);
      const width = list.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight);
      setCapacity(Math.max(3, Math.floor((width + STOP_GAP_PX) / (STOP_MIN_PX + STOP_GAP_PX))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const tooLong = career.length > capacity;
  const shown = lineStops(career.length, capacity, expanded);
  // What the fold holds when closed, open or not. The first of them is the
  // fold's gray dot (a shared layoutId), so that one travels on its own.
  const hidden = career.slice(1, career.length - (capacity - 2));
  const folded = hidden.map((_, i) => i + 1);
  const dotOf = (at: number) => listRef.current?.querySelector<HTMLElement>(`li[data-at='${at}'] .career-dot`);

  // Opening: each record the fold lets out starts where the fold's dot is and
  // travels to its own place; the segments between them grow once they
  // arrive.
  const opening = useRef<DOMRect | null>(null);
  const [closing, setClosing] = useState<Offsets | null>(null);
  const setFold = (open: boolean) => {
    if (open) {
      if (!reduce) opening.current = listRef.current?.querySelector('.career-fold-dot')?.getBoundingClientRect() ?? null;
      setExpanded(true);
      return;
    }
    if (reduce) {
      setClosing(null);
      setExpanded(false);
      return;
    }
    // A line scrolled across travels back to its start first: closing it
    // where it is would snap the scroll to 0 as the line shrinks, and every
    // stop would jump by that much in one frame.
    const list = listRef.current;
    if (list && list.scrollLeft > 0) {
      animate(list.scrollLeft, 0, { ...MOVE, onUpdate: (left) => { list.scrollLeft = left; }, onComplete: () => setFold(false) });
      return;
    }
    // Back into the fold: each record measures how far it is from where the
    // fold will stand (its first hidden record), then the fold closes and the
    // records leave by that offset (`intoFold`).
    const target = dotOf(folded[0])?.getBoundingClientRect();
    const offsets: Offsets = new Map();
    for (const at of folded.slice(1)) {
      const dot = dotOf(at)?.getBoundingClientRect();
      if (dot && target) offsets.set(at, { x: target.left - dot.left, y: target.top - dot.top });
    }
    setClosing(offsets);
    setExpanded(false);
  };
  useLayoutEffect(() => {
    const from = opening.current;
    if (!from) return;
    opening.current = null;
    folded.forEach((at, i) => {
      const li = dotOf(at)?.closest('li');
      if (!li) return;
      // The gray dot carries the first record itself; its text fades in.
      if (i === 0) {
        animate(li, { opacity: [0, 1] }, MOVE);
        return;
      }
      const to = dotOf(at)!.getBoundingClientRect();
      animate(li, {
        transform: [`translate(${from.left - to.left}px, ${from.top - to.top}px)`, 'translate(0px, 0px)'],
        opacity: [0, 1],
      }, { transform: MOVE, opacity: FADE_IN_LATE });
    });
  });

  // Stops take turns above and below the line by place in the career, so a
  // stop keeps its side when the fold opens around it.
  const sideOf = (at: Stop, i: number): Side => ((at === 'fold' ? i : at) % 2 === 0 ? 'below' : 'above');
  const fold = shown.indexOf('fold');
  const kinds = new Set(career.map((stop) => stop.kind));

  return (
    <MotionConfig transition={MOVE} reducedMotion="user">
      <section className="career" aria-labelledby={`${id}-title`}>
        <header className="career-head">
          <h2 id={`${id}-title`} className="career-title">Career</h2>
          {tooLong && (
            <button type="button" className="career-toggle" aria-expanded={expanded} aria-controls={`${id}-line`} onClick={() => setFold(!expanded)}>
              {expanded ? 'Show fewer' : `+${hidden.length} more`}
            </button>
          )}
        </header>
        {/* Stops render once the width is known, before the first paint, so a
            long career starts folded. */}
        <div ref={bodyRef} className="career-frame">
          <motion.ol layoutScroll ref={listRef} id={`${id}-line`} className="career-line" data-foldable={tooLong || undefined} data-opened={expanded || undefined}>
            {capacity !== Infinity && (
              <>
                <AnimatePresence initial={false}>
                  {/* Next to the fold a segment is dashed: the one after it
                      stands for the records it hides. */}
                  {shown.slice(0, -1).map((at, i) => (
                    <Segment key={`seg-${at}`} dashed={at === 'fold'} style={{ gridColumn: `${i + 1} / span 1` }} />
                  ))}
                </AnimatePresence>
                {fold >= 0 && (
                  <motion.span
                    layoutId={`${id}-dot-${folded[0]}`}
                    className="career-dot career-fold-dot"
                    aria-hidden="true"
                    style={{ gridColumn: fold + 1 }}
                  />
                )}
                <AnimatePresence initial={false} mode="popLayout" custom={closing}>
                  {shown.map((at, i) => (at === 'fold'
                    ? <Fold key="fold" id={id} hidden={hidden} side={sideOf(at, i)} column={i + 1} />
                    : <Station key={at} id={id} stop={career[at]} at={at} side={sideOf(at, i)} column={i + 1} onOrganization={onOrganization} />))}
                </AnimatePresence>
              </>
            )}
          </motion.ol>
        </div>
        <ul className="career-legend" aria-label="Legend">
          {[...kinds].map((kind) => (
            <li key={kind}><span className="career-legend-mark" aria-hidden="true"><Dot kind={kind} /></span>{KIND_LABEL[kind]}</li>
          ))}
          {career.some(isCurrent) && (
            <li><span className="career-legend-mark" aria-hidden="true"><Dot kind="work" current /></span>Present</li>
          )}
        </ul>
      </section>
    </MotionConfig>
  );
}
