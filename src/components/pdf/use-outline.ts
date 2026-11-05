import type { FullText } from '../../utils/full-text.ts';
import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useScrollFrame } from './use-scroll-frame.ts';
import { plainText } from '../../utils/full-text.ts';
import { anchor } from './article-places.ts';

type OutlineItem = { target: string; depth: number; title: string };
export type Outline = { items: OutlineItem[]; active: number };

// Sections, subsections and subsubsections; a paragraph's own title
// ("Encoder:") is part of the text, not of its outline.
function outlineOf(doc: FullText, withAbstract: boolean): OutlineItem[] {
  const sections = doc.body.flatMap(block => (block.t === 'heading' && block.id && block.level <= 4
    ? [{ target: anchor(block.id), depth: Math.max(block.level, 2) - 2, title: plainText(block.children).trim() }]
    : []));
  return [
    ...(withAbstract && doc.abstract.length > 0 ? [{ target: 'ft-abstract-title', depth: 0, title: 'Abstract' }] : []),
    ...sections,
    ...(doc.notes.length > 0 ? [{ target: 'ft-notes-title', depth: 0, title: 'Notes' }] : []),
    ...(doc.references.length > 0 ? [{ target: 'ft-references-title', depth: 0, title: 'References' }] : []),
  ];
}

// The section being read is the last whose heading has passed a quarter of the way down.
export function useOutline(doc: FullText | null | undefined, scroll: HTMLElement | null, withAbstract: boolean): Outline {
  const items = useMemo(() => (doc ? outlineOf(doc, withAbstract) : []), [doc, withAbstract]);
  const [active, setActive] = useState(-1);
  const update = () => {
    if (!scroll) return;
    const line = scroll.getBoundingClientRect().top + scroll.clientHeight / 4;
    setActive(items.findLastIndex(item => {
      const heading = document.getElementById(item.target);
      return heading !== null && heading.getBoundingClientRect().top <= line;
    }));
  };
  useScrollFrame(items.length > 0 ? scroll : null, update);
  const settle = useEffectEvent(update);
  useEffect(() => {
    if (!scroll || items.length === 0) return;
    const frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [scroll, items]);
  return { items, active };
}
