import type { FullText } from '../../utils/full-text.ts';
import { useEffect, useMemo, useState } from 'react';
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

/**
 * The paper's outline and the section being read in `scroll`: the last one
 * whose heading has passed a quarter of the way down the text.
 */
export function useOutline(doc: FullText | null | undefined, scroll: HTMLElement | null, withAbstract: boolean): Outline {
  const items = useMemo(() => (doc ? outlineOf(doc, withAbstract) : []), [doc, withAbstract]);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (!scroll || items.length === 0) return;
    const headings = items.map(item => document.getElementById(item.target));
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = scroll.getBoundingClientRect().top + scroll.clientHeight / 4;
      setActive(headings.findLastIndex(heading => heading !== null && heading.getBoundingClientRect().top <= line));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    frame = requestAnimationFrame(update);
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => { scroll.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [scroll, items]);
  return { items, active };
}
