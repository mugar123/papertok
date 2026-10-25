import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { AnimatePresence, MotionConfig, animate, motion, useReducedMotion } from 'framer-motion';
import { EASE_IN_OUT, EASE_OUT, MOTION_BASE_S, MOTION_SHEET_S } from '../../utils/motion-curves.ts';
import type { CareerStop, LineSlot } from './career-stops.ts';
import { foldYears, isCurrent, lineStops, stopWidth, stopYears } from './career-stops.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';
import './career-timeline.css';

type Side = 'below' | 'above';
type Offsets = Map<number, { x: number; y: number }>;

const offsetTo = (from: DOMRect, to: DOMRect) => ({ x: to.left - from.left, y: to.top - from.top });

const KIND_LABEL = { study: 'Studies', work: 'Work' } as const;

const MOVE = { duration: MOTION_SHEET_S, ease: EASE_IN_OUT };
// Travelling records show text only near where they rest, so it never piles up.
const FADE_AWAY = { duration: MOTION_SHEET_S / 3, ease: EASE_OUT };
const FADE_IN_LATE = { duration: MOTION_SHEET_S / 3, delay: (MOTION_SHEET_S * 2) / 3, ease: EASE_OUT };

// Match `.career-line` in career-timeline.css.
const STOP_MIN_PX = 86;
const STOP_GAP_PX = 20;

function Dot({ kind, current, layoutId }: { kind: CareerStop['kind']; current?: boolean; layoutId?: string }) {
  return <motion.span layoutId={layoutId} className="career-dot" data-kind={kind} data-current={current || undefined} />;
}

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

// popLayout measures a leaving record through `ref`.
function Station({ ref, id, stop, at, side, column, onOrganization }: {
  ref?: Ref<HTMLLIElement>; id: string; stop: CareerStop; at: number; side: Side; column: number; onOrganization: (stop: CareerStop) => void;
}) {
  const span = stopYears(stop);
  const current = isCurrent(stop);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const onTooltipOpenChange = (next: boolean) => {
    const clamped = [...(textRef.current?.querySelectorAll<HTMLElement>('.career-clamp') ?? [])];
    setTooltipOpen(next && clamped.some((node) => node.scrollHeight > node.clientHeight));
  };
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
    >
      <span className="career-axis" aria-hidden="true">
        <Dot kind={stop.kind} current={current} layoutId={`${id}-dot-${at}`} />
      </span>
      <motion.div layout="position" className="career-body">
        <span className="career-years">
          <span className="visually-hidden">{`${KIND_LABEL[stop.kind]}, `}</span>
          {span ?? 'Dates not given'}
        </span>
        <div ref={textRef} className="career-text">
          <Tooltip open={tooltipOpen} onOpenChange={onTooltipOpenChange}>
            <TooltipTrigger render={<button type="button" className="career-org" onClick={() => onOrganization(stop)} />}>
              <span className="career-clamp">{stop.organization}</span>
            </TooltipTrigger>
            <TooltipContent>{[stop.organization, stop.role, span].filter(Boolean).join(' · ')}</TooltipContent>
          </Tooltip>
          {stop.role && <span className="career-role career-clamp">{stop.role}</span>}
        </div>
      </motion.div>
    </motion.li>
  );
}

function Fold({ ref, hidden, side, column }: {
  ref?: Ref<HTMLLIElement>; hidden: CareerStop[]; side: Side; column: number;
}) {
  const span = foldYears(hidden);
  return (
    <motion.li ref={ref} initial={false} exit={{ opacity: 0, transition: FADE_AWAY }} className="career-stop" data-side={side} style={{ gridColumn: column }}>
      <motion.div layout="position" className="career-body">
        <span className="visually-hidden">{`${hidden.length} more records${span ? ',' : ''} `}</span>
        {span && <span className="career-years">{span}</span>}
      </motion.div>
    </motion.li>
  );
}

// scaleX rather than a transform string: the layout projection composes it.
function Segment({ dashed, column }: { dashed: boolean; column: number }) {
  const reduce = useReducedMotion();
  const hidden = reduce ? { opacity: 0 } : { scaleX: 0 };
  const shown = reduce ? { opacity: 1 } : { scaleX: 1 };
  return (
    <motion.span
      layout
      className={`career-rail${dashed ? ' is-dashed' : ''}`}
      aria-hidden="true"
      style={{ gridColumn: `${column} / span 1`, originX: 0 }}
      initial={hidden}
      animate={{ ...shown, transition: { duration: MOTION_BASE_S, ease: EASE_OUT, delay: reduce ? 0 : MOTION_SHEET_S } }}
      exit={{ ...hidden, transition: { duration: MOTION_BASE_S / 2, ease: EASE_OUT } }}
    />
  );
}

export default function CareerTimeline({ career, onOrganization }: { career: CareerStop[]; onOrganization: (stop: CareerStop) => void }) {
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  // Only records the reader lets out of the fold start gray.
  const [unfolded, setUnfolded] = useState(false);
  const [lineWidth, setLineWidth] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const reduce = useReducedMotion();
  useLayoutEffect(() => {
    const list = listRef.current;
    const body = bodyRef.current;
    if (!list || !body) return undefined;
    let last: number | null = null;
    const measure = () => {
      const { paddingLeft, paddingRight } = getComputedStyle(list);
      setLineWidth(list.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight));
      const next = list.offsetHeight;
      if (next === last) return;
      if (last === null) body.style.height = `${next}px`;
      else animate(body, { height: `${next}px` }, reduce ? { duration: 0 } : MOVE);
      last = next;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [reduce]);

  const capacity = lineWidth === null ? Infinity : Math.max(3, Math.floor((lineWidth + STOP_GAP_PX) / (STOP_MIN_PX + STOP_GAP_PX)));
  const tooLong = career.length > capacity;
  const openStop = expanded && lineWidth !== null ? stopWidth(career.length, lineWidth, STOP_MIN_PX, STOP_GAP_PX) : null;
  const shown = lineStops(career.length, capacity, expanded);
  // The first folded record shares the fold dot's layoutId and travels on its own.
  const hidden = career.slice(1, career.length - (capacity - 2));
  const foldedAt = hidden.map((_, i) => i + 1);
  const dotOf = (at: number) => listRef.current?.querySelector<HTMLElement>(`li[data-at='${at}'] .career-dot`);

  const opening = useRef<DOMRect | 'fade' | null>(null);
  const [closing, setClosing] = useState<Offsets | null>(null);
  const setFold = (open: boolean) => {
    if (open) {
      opening.current = reduce ? 'fade' : listRef.current?.querySelector('.career-fold-dot')?.getBoundingClientRect() ?? null;
      setExpanded(true);
      setUnfolded(true);
      return;
    }
    if (reduce) {
      setClosing(null);
      setExpanded(false);
      return;
    }
    // Closing a scrolled line would snap its scroll to 0 and jump every stop.
    const list = listRef.current;
    if (list && list.scrollLeft > 0) {
      animate(list.scrollLeft, 0, { ...MOVE, onUpdate: (left) => { list.scrollLeft = left; }, onComplete: () => setFold(false) });
      return;
    }
    const target = dotOf(foldedAt[0])?.getBoundingClientRect();
    setClosing(new Map(foldedAt.slice(1).flatMap((at) => {
      const dot = dotOf(at)?.getBoundingClientRect();
      return dot && target ? [[at, offsetTo(dot, target)] as const] : [];
    })));
    setExpanded(false);
  };
  useLayoutEffect(() => {
    const from = opening.current;
    if (!from) return;
    opening.current = null;
    foldedAt.forEach((at, i) => {
      const dot = dotOf(at);
      const li = dot?.closest('li');
      if (!dot || !li) return;
      if (from === 'fade' || i === 0) {
        animate(li, { opacity: [0, 1] }, MOVE);
        return;
      }
      const { x, y } = offsetTo(dot.getBoundingClientRect(), from);
      animate(li, {
        transform: [`translate(${x}px, ${y}px)`, 'translate(0px, 0px)'],
        opacity: [0, 1],
      }, { transform: MOVE, opacity: FADE_IN_LATE });
    });
  });

  // Sides follow the career index so a stop keeps its side when the fold opens.
  const sideOf = (at: LineSlot, i: number): Side => ((at === 'fold' ? i : at) % 2 === 0 ? 'below' : 'above');
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
        <div ref={bodyRef} className="career-frame">
          <motion.ol layoutScroll ref={listRef} id={`${id}-line`} className="career-line" data-foldable={tooLong || undefined} data-opened={(expanded && unfolded) || undefined} style={openStop === null ? undefined : { '--career-stop': `${openStop}px` }}>
            {capacity !== Infinity && (
              <>
                <AnimatePresence initial={false}>
                  {shown.slice(0, -1).map((at, i) => (
                    <Segment key={`seg-${at}`} dashed={at === 'fold'} column={i + 1} />
                  ))}
                </AnimatePresence>
                {fold >= 0 && (
                  <motion.span
                    layoutId={`${id}-dot-${foldedAt[0]}`}
                    className="career-dot career-fold-dot"
                    aria-hidden="true"
                    style={{ gridColumn: fold + 1 }}
                  />
                )}
                <AnimatePresence initial={false} mode="popLayout" custom={closing}>
                  {shown.map((at, i) => (at === 'fold'
                    ? <Fold key="fold" hidden={hidden} side={sideOf(at, i)} column={i + 1} />
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
