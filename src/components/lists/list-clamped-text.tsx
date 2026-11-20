import type { ReactNode } from 'react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import { useReducedMotion } from 'framer-motion';
import { EASE_OUT, animateSize } from '../../utils/motion-curves.ts';

type ListClampedTextProps = {
  /** The text the clamp measures; a new text measures again. */
  text: string;
  className: string;
  textClassName: string;
  lang?: string;
  /** Shown above the text, inside the box that opens. */
  header?: ReactNode;
  /** How the text renders, when that is more than the string itself. */
  children?: ReactNode;
};

/**
 * A text in a list row, clamped to a few lines, with "Read more" once the
 * clamp hides something. Opening animates the whole box, header included, so
 * the rows below slide rather than jump. `className` decides how much of the
 * box answers the click (lists-page.css).
 */
export default function ListClampedText({ text, className, textClassName, lang, header, children }: ListClampedTextProps) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const fromHeight = useRef<number | null>(null);
  const textId = useId();
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return undefined;
    const measure = () => {
      if (!element.isConnected || open) return;
      setClipped(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    // A clamped box keeps its height when what is inside it changes, so the
    // resize observer alone misses formulas typeset after the first paint and
    // the serif arriving late; both change whether the clamp hides anything.
    let live = true;
    void document.fonts.ready.then(() => { if (live) measure(); });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resized?.observe(element);
    const rewritten = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    rewritten?.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      live = false;
      resized?.disconnect();
      rewritten?.disconnect();
    };
  }, [text, open]);

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
      className={`${className}${expandable ? ' is-expandable' : ''}`}
      data-open={open || undefined}
    >
      {header}
      <p ref={textRef} id={textId} className={textClassName} lang={lang}>{children ?? text}</p>
      {expandable && (
        <button
          type="button"
          className="lists-paper-more"
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
