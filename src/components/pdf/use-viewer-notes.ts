import type { Paper } from '../../models/paper.ts';
import type { PassageAnnotation } from '../../hooks/use-passage-annotations.ts';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { usePassageAnnotations } from '../../hooks/use-passage-annotations.ts';
import { FULL_TEXT_LEVEL, HIGHLIGHT_COLORS, MAX_QUOTE_LENGTH, highlightColor } from '../../services/user-highlight-service.ts';
import { HIGHLIGHT_MIN_QUOTE_LENGTH } from '../../utils/text-highlights.ts';
import type { PassageSelection } from './passage-range.ts';
import type { HighlightColor } from '../../services/user-highlight-service.ts';
import { blockPassage, blockText, overlapping, passageAt, passageRange, replacingHighlights, selectedPassage } from './passage-range.ts';
import { newestFirst } from './passage-order.ts';
import { lastKnownAIUses, refreshAIUses, subscribeAIUses } from '../../services/paper-rewrite-service.ts';

const PAINT = 'viewer-passage';
const PENDING = 'viewer-passage-pending';
const ACTIVE = 'viewer-passage-active';
const HOVER = 'viewer-passage-hover';
export const SAVE_ERROR = 'Could not save. Check your connection and try again.';

export function useViewerNotes(paper: Paper, uid: string | null, aiLevel: string) {
  const paperId = paper.id || paper.doi || paper.arxivId || '';
  // The day's AI allowance, from the store the reader and cards share.
  const [seededQuota] = useState(() => lastKnownAIUses(uid));
  const quota = useSyncExternalStore(subscribeAIUses, () => lastKnownAIUses(uid));
  useEffect(() => {
    if (!uid) return undefined;
    const controller = new AbortController();
    void refreshAIUses(uid, controller.signal);
    return () => controller.abort();
  }, [uid]);
  // Until the worker has answered, a use is assumed to be there: the worker refuses if not.
  const canAsk = quota === null || quota === seededQuota || Boolean(quota.unlimited) || quota.remainingUses > 0;
  const notes = usePassageAnnotations({ uid, paper, paperId, level: FULL_TEXT_LEVEL, aiLevel, language: 'en' });
  const passages = useMemo(() => newestFirst(notes.annotations.filter(item => item.level === FULL_TEXT_LEVEL)), [notes.annotations]);
  const [status, setStatus] = useState('');
  const [origin, setOrigin] = useState<HTMLElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The passage the reader clicked. Derived against the list, so a deleted one simply drops out.
  const [picked, setPicked] = useState<string | null>(null);
  const active = passages.some(passage => passage.id === picked) ? picked : null;

  const pickPassage = (passage: PassageSelection | null, from: HTMLElement | null) => {
    if (!passage || passage.quote.length < HIGHLIGHT_MIN_QUOTE_LENGTH) return;
    setFailed(null);
    setOrigin(from);
    notes.begin({ sectionId: passage.sectionId, paragraphIndex: 0, quote: passage.quote.slice(0, MAX_QUOTE_LENGTH).trim(), occurrence: passage.occurrence, anchor: passage.anchor, context: passage.context.slice(0, 4_000) });
  };
  const pick = (root: HTMLElement | null) => {
    if (root) pickPassage(selectedPassage(root), root);
  };
  const pickBlock = (block: HTMLElement) => pickPassage(blockPassage(block), block);
  // A click on the text marks the highlight under it, or clears the mark off a highlight.
  // Returns whether it landed on one.
  const pickAt = (target: EventTarget | null, x: number, y: number) => {
    const id = passageAt(target, passages, x, y)?.id ?? null;
    setPicked(id);
    return id !== null;
  };

  // A selection over the reader's own highlights replaces them, keeping their notes.
  const save = async (note: string, color?: HighlightColor) => {
    const passage = notes.pending;
    const block = passage && document.querySelector(`[data-passage="${CSS.escape(passage.sectionId)}"]`);
    const { note: text, replaced } = replacingHighlights(note, block && passage
      ? overlapping(blockText(block), passage, passages.filter(item => item.kind === 'user' && item.sectionId === passage.sectionId))
      : []);
    const saved = text ? await notes.saveNote(text, color) : await notes.highlight(color);
    if (saved) {
      window.getSelection()?.removeAllRanges();
      origin?.focus({ preventScroll: true });
      const removed = await Promise.all(replaced.filter(item => item.id !== saved.id).map(item => notes.remove(item.id)));
      setStatus(removed.every(Boolean) ? (text ? 'Note saved' : 'Highlight saved') : 'Saved, but the old highlight could not be removed. Try deleting it.');
      return;
    }
    if (passage) notes.begin(passage);
    setFailed(note);
    setStatus(SAVE_ERROR);
  };

  const dismiss = () => {
    setFailed(null);
    notes.dismiss();
  };

  // The question goes out and the editor closes; the answer lands in the notes as an AI entry.
  const ask = async (question: string) => {
    window.getSelection()?.removeAllRanges();
    origin?.focus({ preventScroll: true });
    setStatus('Asking the AI');
    const answer = await notes.ask(question);
    setStatus(answer ? 'Answer added to the notes' : 'Could not get an answer. Try again.');
  };

  const remove = async (id: string) => {
    setStatus(await notes.remove(id) ? 'Highlight deleted' : 'Could not delete. Check your connection and try again.');
  };

  return { ...notes, passages, active, status, origin, failed, pick, pickAt, pickBlock, pickPassage, pickId: setPicked, save, ask, quota, canAsk, dismiss, remove };
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

export function usePaintedPassages(root: HTMLElement | null, passages: Pick<PassageAnnotation, 'id' | 'sectionId' | 'quote' | 'color' | 'occurrence'>[], pending: Pick<PassageAnnotation, 'sectionId' | 'quote' | 'occurrence'> | null, active: string | null = null, hovered: string | null = null) {
  useEffect(() => {
    if (!root || typeof CSS === 'undefined' || !('highlights' in CSS)) return undefined;
    const ranges = (list: Pick<PassageAnnotation, 'sectionId' | 'quote' | 'occurrence'>[]) => list.flatMap((passage) => {
      const block = root.querySelector(`[data-passage="${CSS.escape(passage.sectionId)}"]`);
      const range = block && passageRange(block, passage.quote, passage.occurrence);
      return range ? [range] : [];
    });
    const paint = () => {
      for (const color of HIGHLIGHT_COLORS) {
        CSS.highlights.set(`${PAINT}-${color}`, new Highlight(...ranges(passages.filter(passage => highlightColor(passage) === color))));
        // The clicked passage is painted again, darker, above its colour's wash.
        const picked = new Highlight(...ranges(passages.filter(passage => passage.id === active && highlightColor(passage) === color)));
        picked.priority = 2;
        CSS.highlights.set(`${ACTIVE}-${color}`, picked);
        // The one under the pointer a shade darker too, as a click on it opens its note.
        const pointed = new Highlight(...ranges(passages.filter(passage => passage.id === hovered && passage.id !== active && highlightColor(passage) === color)));
        pointed.priority = 1;
        CSS.highlights.set(`${HOVER}-${color}`, pointed);
      }
      CSS.highlights.set(PENDING, new Highlight(...ranges(pending ? [pending] : [])));
      // A formula is drawn in boxes the painted text does not fill, so one a highlight covers takes its colour as a background.
      const covering = passages.map(passage => ({ passage, ranges: ranges([passage]) }));
      for (const formula of root.querySelectorAll<HTMLElement>('.ft-math')) {
        const over = covering.find(({ passage, ranges: found }) => passage.id === active && found.some(range => range.intersectsNode(formula)))
          ?? covering.find(({ ranges: found }) => found.some(range => range.intersectsNode(formula)));
        if (over) formula.dataset.mark = highlightColor(over.passage);
        else delete formula.dataset.mark;
        formula.toggleAttribute('data-mark-active', over?.passage.id === active);
      }
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
      for (const color of HIGHLIGHT_COLORS) {
        CSS.highlights.delete(`${PAINT}-${color}`);
        CSS.highlights.delete(`${ACTIVE}-${color}`);
        CSS.highlights.delete(`${HOVER}-${color}`);
      }
      CSS.highlights.delete(PENDING);
      for (const formula of root.querySelectorAll<HTMLElement>('.ft-math')) {
        delete formula.dataset.mark;
        formula.removeAttribute('data-mark-active');
      }
    };
  }, [root, passages, pending, active, hovered]);
}
