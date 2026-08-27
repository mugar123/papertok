import { useEffect, useMemo, useRef, useState } from 'react';
import { canHaveFigures, getPaperFigures } from '../services/paperFigureService.js';

/** Shared and never written to: the answer for an edition nobody has asked about yet. */
const NO_FIGURES = new Map();

/**
 * The plates for one edition of Research.
 *
 * The figures arrive from the worker long after the papers do, and for a good
 * share of the selection they never arrive at all — only papers with an arXiv
 * identifier are asked, and of those only the ones a renderer has already
 * converted answer. Two consequences shape this hook:
 *
 *  - **Whether a paper *can* have a plate is known synchronously; whether it
 *    *does* is not.** Neither moves the grid — the forme is planned from the
 *    edition's seed alone. The first decides which cells hold a well open, the
 *    second decides when the well stops being grey, and a cell that held one
 *    open for nothing gives the space back once the edition has settled.
 *
 *  - **A resolved edition must never flash back to grey.** The results are held
 *    against the edition they belong to rather than reset when the period
 *    changes, so a stale answer cannot land on the new selection and the new
 *    selection reads as empty until its own answers arrive.
 *
 * Figures are cached in the service, so a period the reader has already seen
 * resolves without a request and its wells are never grey a second time.
 */
export function useEditionFigures(papers) {
  const [store, setStore] = useState({ key: '', figures: NO_FIGURES, settled: true });
  const requestRef = useRef(0);

  // The papers worth asking about, and a key that changes only when that set
  // does — `papers` is a fresh array on every render of the report.
  const candidates = useMemo(
    () => (papers || []).filter(paper => paper && canHaveFigures(paper)),
    [papers],
  );
  const candidateKey = candidates.map(paper => paper.id).join('|');

  useEffect(() => {
    if (candidates.length === 0) return undefined;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    let active = true;
    const collected = new Map();

    const isCurrent = () => active && requestRef.current === requestId;

    const pending = candidates.map(paper => (
      getPaperFigures(paper)
        .then(found => {
          // Committed one at a time on purpose: a plate that is ready should
          // not wait behind a paper whose renderer is slow.
          if (!isCurrent() || found.length === 0) return;
          collected.set(paper.id, found[0]);
          // The first figure is the one the paper leads with, which is the one
          // worth showing where there is room for exactly one.
          setStore({ key: candidateKey, figures: new Map(collected), settled: false });
        })
        // The service swallows its own failures; this is belt and braces so one
        // rejection cannot leave the edition unsettled for ever.
        .catch(() => {})
    ));

    Promise.all(pending).then(() => {
      if (isCurrent()) setStore({ key: candidateKey, figures: new Map(collected), settled: true });
    });

    return () => { active = false; };
    // `candidateKey` is the real dependency. `candidates` is rebuilt whenever
    // the report object is replaced — including by a re-rank that changed
    // nothing — and re-running on that would restart every request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey]);

  // Derived rather than reset in an effect: until this edition's own results
  // land, it simply has none, and an edition with nothing to ask about has
  // already settled.
  const isCurrentEdition = store.key === candidateKey;
  return {
    figures: isCurrentEdition ? store.figures : NO_FIGURES,
    settled: isCurrentEdition ? store.settled : candidates.length === 0,
  };
}

export default useEditionFigures;
