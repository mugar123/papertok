import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listUserHighlights,
  removeUserHighlight,
  saveUserHighlight,
} from '../services/userHighlightService.js';
import { annotatePassage, PaperAnnotationError } from '../services/paperAnnotationService.js';

/**
 * Everything a passage can become.
 *
 * A selection in the reader is a fork with three ends: a bare mark, a mark with
 * your words on it, or a mark with the model's. All three are one document in
 * the same collection, so they are one state machine rather than three, and it
 * lives here rather than in the reader — the reader is already the longest file
 * in the tree and none of this is about laying out a document.
 *
 * `pending` is the fork itself: the selection, captured whole (quote, anchor,
 * the paragraph around it, and where it sits on screen) at the moment the
 * selection is decided — mouse-up on a fine pointer, `selectionchange` settling
 * on a coarse one. Capturing it up front is what lets the desktop route clear
 * the browser's own selection immediately — the reader paints its own mark on
 * the passage instead, so the highlight you are about to make is the highlight
 * you can already see. Touch leaves the native selection alone; its own OS
 * handles and callout serve as that same provisional mark there.
 */

const IDLE = 'idle';
/** One frozen empty list, so "nothing to show" is a stable identity. */
const EMPTY = Object.freeze([]);

export function usePassageAnnotations({
  uid,
  paper,
  paperId,
  level,
  language,
  onQuota,
  trackEvent,
}) {
  const [loaded, setLoaded] = useState([]);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(IDLE);
  const [error, setError] = useState(null);
  const askAbortRef = useRef(null);

  // Derived rather than cleared: without a reader or a paper there is nothing to
  // show, and writing that emptiness into state from an effect would cost a
  // cascading render — and leave whatever was there on screen until it landed.
  const annotations = uid && paperId ? loaded : EMPTY;

  useEffect(() => {
    if (!uid || !paperId) return undefined;
    let active = true;
    listUserHighlights(uid, paperId).then(stored => {
      if (active) setLoaded(stored);
    });
    return () => { active = false; };
  }, [paperId, uid]);

  // An answer in flight when the reader closes is an answer nobody will read,
  // and its use has already been spent either way.
  useEffect(() => () => askAbortRef.current?.abort(), []);

  const dismiss = useCallback(() => {
    setPending(null);
    setError(null);
  }, []);

  const begin = useCallback((selection) => {
    setError(null);
    setPending(selection);
  }, []);

  /**
   * One writer for all three outcomes: they differ by `kind` and by whether
   * they carry words, and nothing else. Returns the stored annotation so the
   * caller can decide what to do next.
   */
  const store = useCallback(async ({ kind, note }) => {
    if (!uid || !pending) return null;
    const saved = await saveUserHighlight(uid, {
      paperId,
      paperTitle: paper?.title,
      level,
      language,
      sectionId: pending.sectionId,
      paragraphIndex: pending.paragraphIndex,
      quote: pending.quote,
      kind,
      note,
    });
    if (!saved) return null;
    setLoaded(current => [
      ...current.filter(item => item.id !== saved.id),
      // `fresh` is not stored: it exists for the length of one animation, so the
      // pen can be seen laying the colour down on the passage that just got it.
      { ...saved, fresh: true },
    ]);
    return saved;
  }, [language, level, paper?.title, paperId, pending, uid]);

  const highlight = useCallback(async () => {
    const saved = await store({ kind: 'user' });
    if (saved) trackEvent?.('paper_highlight', { surface: 'reader', level });
    setPending(null);
    return saved;
  }, [level, store, trackEvent]);

  const saveNote = useCallback(async (text) => {
    const note = String(text || '').trim();
    if (!note) return null;
    setBusy('saving');
    try {
      const saved = await store({ kind: 'user', note });
      if (saved) trackEvent?.('paper_annotation', { surface: 'reader', level, origin: 'user' });
      setPending(null);
      return saved;
    } finally {
      setBusy(IDLE);
    }
  }, [level, store, trackEvent]);

  const ask = useCallback(async () => {
    if (!pending) return null;
    // The passage is captured before the request goes out: the menu closes
    // immediately, and what the request is about must not depend on state the
    // reader can change while it is in flight.
    const passage = pending;
    askAbortRef.current?.abort();
    const controller = new AbortController();
    askAbortRef.current = controller;
    setPending(null);
    setBusy('asking');
    setError(null);
    trackEvent?.('paper_annotation', { surface: 'reader', level, origin: 'ai' });

    try {
      const answer = await annotatePassage(paper, {
        quote: passage.quote,
        context: passage.context,
        level,
        language,
        signal: controller.signal,
      });
      if (typeof answer.remainingUses === 'number') onQuota?.(answer.remainingUses);
      const saved = await saveUserHighlight(uid, {
        paperId,
        paperTitle: paper?.title,
        level,
        language,
        sectionId: passage.sectionId,
        paragraphIndex: passage.paragraphIndex,
        quote: passage.quote,
        kind: 'ai',
        note: answer.note,
      });
      // An answer that arrived but could not be stored is still an answer worth
      // showing: it goes in the rail unsaved rather than being thrown away for
      // a Firestore write the reader never asked about.
      const entry = saved
        ? { ...saved, fresh: true }
        : {
          id: `local:${passage.sectionId}:${passage.paragraphIndex}`,
          paperId,
          level,
          language,
          sectionId: passage.sectionId,
          paragraphIndex: passage.paragraphIndex,
          quote: passage.quote,
          kind: 'ai',
          note: answer.note,
          fresh: true,
          unsaved: true,
        };
      setLoaded(current => [...current.filter(item => item.id !== entry.id), entry]);
      return entry;
    } catch (caught) {
      if (caught instanceof PaperAnnotationError && caught.code === 'AI_CANCELLED') return null;
      setError(caught instanceof PaperAnnotationError ? caught.code : 'AI_UNAVAILABLE');
      return null;
    } finally {
      setBusy(IDLE);
    }
  }, [language, level, onQuota, paper, paperId, pending, trackEvent, uid]);

  const remove = useCallback(async (annotationId) => {
    if (!annotationId) return;
    // Removed from the rail first: the write is the slow part, and a card that
    // lingers after the click reads as a click that did not land. A failure
    // puts it back.
    const removed = annotations.find(item => item.id === annotationId);
    setLoaded(current => current.filter(item => item.id !== annotationId));
    if (!uid || removed?.unsaved) return;
    const ok = await removeUserHighlight(uid, annotationId);
    if (!ok && removed) setLoaded(current => [...current, removed]);
  }, [annotations, uid]);

  /** Takes the one-shot `fresh` flag back off once its animation has run. */
  const settle = useCallback((annotationId) => {
    setLoaded(current => current.map(item => (
      item.id === annotationId && item.fresh ? { ...item, fresh: false } : item
    )));
  }, []);

  return {
    annotations,
    pending,
    busy,
    error,
    begin,
    dismiss,
    highlight,
    saveNote,
    ask,
    remove,
    settle,
    clearError: useCallback(() => setError(null), []),
  };
}
