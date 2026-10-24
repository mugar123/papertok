// An author's studies and work as one line of stops, evenly spaced rather
// than to scale, like a metro line. Stops take turns above and below the line
// and long text is clamped to two lines. A career wider than the card scrolls
// across, and the card's edge cuts the next stop through so that it shows.
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CareerStop } from './career-stops.ts';
import { isCurrent, stopWidth, stopYears } from './career-stops.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';
import './career-timeline.css';

const KIND_LABEL = { study: 'Studies', work: 'Work' } as const;

// The narrowest a stop may be and the gap between stops (`.career-line`).
const STOP_MIN_PX = 86;
const STOP_GAP_PX = 20;

function Dot({ kind, current }: { kind: CareerStop['kind']; current?: boolean }) {
  return <span className="career-dot" data-kind={kind} data-current={current || undefined} />;
}

// The organisation and the role are clamped separately, so the tooltip with
// the whole record opens when either of them is cut.
function Station({ stop, column, onOrganization }: { stop: CareerStop; column: number; onOrganization: (stop: CareerStop) => void }) {
  const span = stopYears(stop);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const onOpenChange = (next: boolean) => {
    const clamped = [...(textRef.current?.querySelectorAll<HTMLElement>('.career-clamp') ?? [])];
    setOpen(next && clamped.some((node) => node.scrollHeight > node.clientHeight));
  };
  return (
    <li className="career-stop" data-side={column % 2 === 0 ? 'above' : 'below'} style={{ gridColumn: column }}>
      <span className="career-axis" aria-hidden="true">
        <Dot kind={stop.kind} current={isCurrent(stop)} />
      </span>
      <div className="career-body">
        <span className="career-years">
          <span className="visually-hidden">{`${KIND_LABEL[stop.kind]}, `}</span>
          {span ?? 'Dates not given'}
        </span>
        <div ref={textRef} className="career-text">
          <Tooltip open={open} onOpenChange={onOpenChange}>
            <TooltipTrigger render={<button type="button" className="career-org" onClick={() => onOrganization(stop)} />}>
              <span className="career-clamp">{stop.organization}</span>
            </TooltipTrigger>
            <TooltipContent>{[stop.organization, stop.role, span].filter(Boolean).join(' · ')}</TooltipContent>
          </Tooltip>
          {stop.role && <span className="career-role career-clamp">{stop.role}</span>}
        </div>
      </div>
    </li>
  );
}

export default function CareerTimeline({ career, onOrganization }: { career: CareerStop[]; onOrganization: (stop: CareerStop) => void }) {
  const id = useId();
  const listRef = useRef<HTMLOListElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = () => {
      const { paddingLeft, paddingRight } = getComputedStyle(list);
      setWidth(list.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  const stop = width === null ? null : stopWidth(career.length, width, STOP_MIN_PX, STOP_GAP_PX);
  const kinds = new Set(career.map((record) => record.kind));

  return (
    <section className="career" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="career-title">Career</h2>
      <ol
        ref={listRef}
        className="career-line"
        style={stop === null ? undefined : { '--career-stop': `${stop}px` }}
      >
        {career.map((record, i) => (
          <Station key={i} stop={record} column={i + 1} onOrganization={onOrganization} />
        ))}
      </ol>
      <ul className="career-legend" aria-label="Legend">
        {[...kinds].map((kind) => (
          <li key={kind}><span className="career-legend-mark" aria-hidden="true"><Dot kind={kind} /></span>{KIND_LABEL[kind]}</li>
        ))}
        {career.some(isCurrent) && (
          <li><span className="career-legend-mark" aria-hidden="true"><Dot kind="work" current /></span>Present</li>
        )}
      </ul>
    </section>
  );
}
