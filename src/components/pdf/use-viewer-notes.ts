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

/** `a3` before `b0`, then by block number: the order the paper reads in. */
const readingOrder = (passage: PassageAnnotation) => [passage.sectionId[0] === 'a' ? 0 : 1, Number(passage.sectionId.slice(1)) || 0];

/**
 * Highlights and notes in the paper's own text. They are the reader's
 * annotations (`usePassageAnnotations`) at the `full-text` level, so they share
 * its collection, its rules and its save and delete paths.
 */
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
  // Where focus goes back to when the popover closes: the paragraph a keyboard opened it from, else the text.
  const [origin, setOrigin] = useState<HTMLElement | null>(null);
  // A save that failed keeps the passage and the note, so nothing typed is lost.
  const [failed, setFailed] = useState<string | null>(null);

  const open = (passage: PassageSelection | null, from: HTMLElement | null) => {
    if (!passage || passage.quote.length < HIGHLIGHT_MIN_QUOTE_LENGTH) return;
    setFailed(null);
    setOrigin(from);
    // Cut as it will be stored, so the passage painted while the editor is open is the one saved.
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
      // The popover unmounts rather than closes here, so it cannot hand focus back itself.
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

/**
 * On a touch screen there is no pointer release to open the editor on: the selection is made with the
 * system's handles. This follows it, and is the passage while a selection of one is held in the text.
 */
export function useTouchSelection(root: HTMLElement | null) {
  const [passage, setPassage] = useState<PassageSelection | null>(null);
  useEffect(() => {
    if (!root) return undefined;
    const update = () => {
      const next = selectedPassage(root);
      setPassage(next && next.quote.length >= HIGHLIGHT_MIN_QUOTE_LENGTH ? next : null);
    };
    // Read at once, since the selection may have changed while this was not listening;
    // then, as the handles move it many times a second, once it has settled.
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

/** Paints the stored passages with the CSS Custom Highlight API, without touching the article's DOM. */
export function usePaintedPassages(root: HTMLElement | null, passages: Pick<PassageAnnotation, 'sectionId' | 'quote' | 'color'>[], pending: Pick<PassageAnnotation, 'sectionId' | 'quote'> | null) {
  useEffect(() => {
    if (!root || typeof CSS === 'undefined' || !('highlights' in CSS)) return undefined;
    const ranges = (list: Pick<PassageAnnotation, 'sectionId' | 'quote'>[]) => list.flatMap((passage) => {
      const block = root.querySelector(`[data-passage="${CSS.escape(passage.sectionId)}"]`);
      const range = block && passageRange(block, passage.quote);
      return range ? [range] : [];
    });
    // The selection being noted stays marked while focus is in the note field, where the browser's own is lost.
    const paint = () => {
      // One registry entry per colour, so `::highlight(viewer-passage-teal)` can paint it.
      for (const color of HIGHLIGHT_COLORS) {
        CSS.highlights.set(`${PAINT}-${color}`, new Highlight(...ranges(passages.filter(passage => (passage.color ?? 'yellow') === color))));
      }
      CSS.highlights.set(PENDING, new Highlight(...ranges(pending ? [pending] : [])));
    };
    paint();
    // Formulas are typeset after the text arrives, which replaces the nodes a range points into.
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
