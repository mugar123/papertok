import type { Paper } from '../../models/paper.ts';
import type { PassageAnnotation } from '../../hooks/use-passage-annotations.ts';
import { useEffect, useMemo, useState } from 'react';
import { usePassageAnnotations } from '../../hooks/use-passage-annotations.ts';
import { FULL_TEXT_LEVEL, HIGHLIGHT_COLORS, MAX_QUOTE_LENGTH } from '../../services/user-highlight-service.ts';
import { HIGHLIGHT_MIN_QUOTE_LENGTH } from '../../utils/text-highlights.ts';
import type { PassageSelection } from './passage-range.ts';
import { blockPassage, passageRange, selectedPassage } from './passage-range.ts';

const PAINT = 'viewer-passage';
const PENDING = 'viewer-passage-pending';

const readingOrder = (passage: PassageAnnotation) => [passage.sectionId[0] === 'a' ? 0 : 1, Number(passage.sectionId.slice(1)) || 0];

export function useViewerNotes(paper: Paper, uid: string | null) {
  const paperId = paper.id || paper.doi || paper.arxivId || '';
  const notes = usePassageAnnotations({ uid, paper, paperId, level: FULL_TEXT_LEVEL, language: 'en' });
  const passages = useMemo(() => notes.annotations
    .filter(item => item.level === FULL_TEXT_LEVEL)
    .sort((a, b) => {
      const [ra, ia] = readingOrder(a);
      const [rb, ib] = readingOrder(b);
      return ra - rb || ia - ib;
    }), [notes.annotations]);
  const [status, setStatus] = useState('');
  const [origin, setOrigin] = useState<HTMLElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const open = (passage: PassageSelection | null, from: HTMLElement | null) => {
    if (!passage || passage.quote.length < HIGHLIGHT_MIN_QUOTE_LENGTH) return;
    setFailed(null);
    setOrigin(from);
    notes.begin({ sectionId: passage.sectionId, paragraphIndex: 0, quote: passage.quote.slice(0, MAX_QUOTE_LENGTH).trim(), anchor: passage.anchor });
  };
  const pick = (root: HTMLElement | null) => {
    if (root) open(selectedPassage(root), root);
  };
  const pickBlock = (block: HTMLElement) => open(blockPassage(block), block);

  const save = async (note: string, color?: string) => {
    const passage = notes.pending;
    const saved = note ? await notes.saveNote(note, color) : await notes.highlight(color);
    if (saved) {
      window.getSelection()?.removeAllRanges();
      origin?.focus({ preventScroll: true });
      setStatus(note ? 'Note saved' : 'Highlight saved');
      return;
    }
    if (passage) notes.begin(passage);
    setFailed(note);
    setStatus('Could not save. Check your connection and try again.');
  };

  const dismiss = () => {
    setFailed(null);
    notes.dismiss();
  };

  const remove = async (id: string) => {
    setStatus(await notes.remove(id) ? 'Highlight deleted' : 'Could not delete. Check your connection and try again.');
  };

  return { ...notes, passages, status, origin, failed, pick, pickBlock, pickPassage: open, save, dismiss, remove };
}

export function useTouchSelection(root: HTMLElement | null) {
  const [passage, setPassage] = useState<PassageSelection | null>(null);
  useEffect(() => {
    if (!root) return undefined;
    const update = () => {
      const next = selectedPassage(root);
      setPassage(next && next.quote.length >= HIGHLIGHT_MIN_QUOTE_LENGTH ? next : null);
    };
    let timer = window.setTimeout(update);
    const read = () => {
      clearTimeout(timer);
      timer = window.setTimeout(update, 200);
    };
    document.addEventListener('selectionchange', read);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', read);
    };
  }, [root]);
  return root ? passage : null;
}

export function usePaintedPassages(root: HTMLElement | null, passages: Pick<PassageAnnotation, 'sectionId' | 'quote' | 'color'>[], pending: Pick<PassageAnnotation, 'sectionId' | 'quote'> | null) {
  useEffect(() => {
    if (!root || typeof CSS === 'undefined' || !('highlights' in CSS)) return undefined;
    const ranges = (list: Pick<PassageAnnotation, 'sectionId' | 'quote'>[]) => list.flatMap((passage) => {
      const block = root.querySelector(`[data-passage="${CSS.escape(passage.sectionId)}"]`);
      const range = block && passageRange(block, passage.quote);
      return range ? [range] : [];
    });
    const paint = () => {
      for (const color of HIGHLIGHT_COLORS) {
        CSS.highlights.set(`${PAINT}-${color}`, new Highlight(...ranges(passages.filter(passage => (passage.color ?? 'yellow') === color))));
      }
      CSS.highlights.set(PENDING, new Highlight(...ranges(pending ? [pending] : [])));
    };
    paint();
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      for (const color of HIGHLIGHT_COLORS) CSS.highlights.delete(`${PAINT}-${color}`);
      CSS.highlights.delete(PENDING);
    };
  }, [root, passages, pending]);
}
