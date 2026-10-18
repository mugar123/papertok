import { useId, useLayoutEffect, useRef, useState } from 'react';
import { CaretDown, Note } from '@phosphor-icons/react';
import { useReducedMotion } from 'framer-motion';
import { EASE_OUT, animateSize } from '../../utils/motionCurves.ts';

export default function ListNote({ note }: { note: string }) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const fromHeight = useRef<number | null>(null);
  const textId = useId();
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return undefined;
    const measure = () => {
      if (!text.isConnected || open) return;
      setClipped(text.scrollHeight > text.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [note, open]);

  useLayoutEffect(() => {
    const from = fromHeight.current;
    fromHeight.current = null;
    if (from == null || reduceMotion || !boxRef.current) return;
    animateSize(boxRef.current, 'height', from, 200, EASE_OUT, { overflow: 'hidden' });
  }, [open, reduceMotion]);

  const expandable = clipped || open;
  return (
    <div
      ref={boxRef}
      className={`lists-paper-note${expandable ? ' is-expandable' : ''}`}
      data-open={open || undefined}
    >
      <span className="lists-paper-note-label">
        <Note size={13} aria-hidden="true" />
        {'Note'}
      </span>
      <span ref={textRef} id={textId} className="lists-paper-note-text">{note}</span>
      {expandable && (
        <button
          type="button"
          className="lists-paper-note-more"
          aria-expanded={open}
          aria-controls={textId}
          onClick={(event) => {
            event.stopPropagation();
            fromHeight.current = boxRef.current?.offsetHeight ?? null;
            setOpen((value) => !value);
          }}
        >
          {open ? 'Show less' : 'Read more'}
          <CaretDown size={12} weight="bold" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
