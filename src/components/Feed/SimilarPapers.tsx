import type { Paper } from '../../models/Paper.ts';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CaretRight } from '@phosphor-icons/react';
import { RELATED_UPSTREAM_LIMIT, getRelatedPapers } from '../../services/relatedPapersService.ts';
import { isSignInRequiredError } from '../../utils/signInRequired.ts';
import { buildRelatedPaperEntries } from '../../utils/relatedPaperTransition.ts';
import { getPublicPaperPath } from '../../utils/publicNavigation.ts';
import ScientificText from '../ScientificText.ts';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../Onboarding/Petri.tsx';

/**
 * The papers Semantic Scholar recommends for `paper`, opened under the card's
 * Similar pill. The panel is the abstract's size and scrolls inside it,
 * showing ten more each time the reader reaches the end.
 */
const PAGE_SIZE = 10;
const SKELETON_ROWS = 4;

type SimilarResult = { for: string | null; status: 'loading' | 'ready' | 'empty' | 'error' | 'signin'; papers: Paper[] };

export default function SimilarPapers({ paper }: { paper: Paper }) {
  const navigate = useNavigate();
  const [result, setResult] = useState<SimilarResult>({ for: null, status: 'loading', papers: [] });
  const paperKey = paper?.id;
  // The card re-renders with a new `paper` object for unrelated reasons; only
  // a different paper asks again.
  const paperRef = useRef(paper);
  useLayoutEffect(() => { paperRef.current = paper; });
  const listRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState({ for: paperKey, count: PAGE_SIZE });

  useEffect(() => {
    if (!paperKey) return undefined;
    let cancelled = false;
    // All twenty the Worker caches, kept to those a reader can open: a paper
    // Semantic Scholar knows only by its own hash has no page here.
    getRelatedPapers(paperRef.current, RELATED_UPSTREAM_LIMIT).then((all) => {
      const papers = all.filter((related) => getPublicPaperPath(related));
      if (!cancelled) setResult({ for: paperKey, status: papers.length ? 'ready' : 'empty', papers });
    }).catch((error) => {
      if (cancelled) return;
      console.error('Similar papers did not load', error);
      setResult({ for: paperKey, status: isSignInRequiredError(error) ? 'signin' : 'error', papers: [] });
    });
    return () => { cancelled = true; };
  }, [paperKey]);

  const status = result.for === paperKey ? result.status : 'loading';

  const count = shown.for === paperKey ? shown.count : PAGE_SIZE;
  const hasMore = status === 'ready' && count < result.papers.length;

  useEffect(() => {
    const list = listRef.current;
    const more = moreRef.current;
    if (!hasMore || !list || !more) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setShown({ for: paperKey, count: count + PAGE_SIZE });
    }, { root: list, rootMargin: '0px 0px 120px 0px' });
    observer.observe(more);
    return () => observer.disconnect();
  }, [count, hasMore, paperKey]);
  const entries = useMemo(() => buildRelatedPaperEntries(result.papers), [result.papers]);

  const open = (related: Paper) => {
    const path = getPublicPaperPath(related);
    if (!path) return;
    navigate(path, { state: { paper: related } });
  };

  if (status === 'loading') {
    return (
      <div className="similar-list similar-loading" role="status" aria-live="polite">
        <span className="visually-hidden">{'Finding similar papers...'}</span>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <span key={index} className="similar-skeleton-row" aria-hidden="true">
            <span className="related-skeleton similar-skeleton-year" />
            <span className="related-skeleton similar-skeleton-title" />
          </span>
        ))}
      </div>
    );
  }

  // The Graph panel's own states (`graph-empty`), so the slot reads the same
  // whichever of its two tools is up.
  if (status === 'signin') {
    return <p className="related-state" role="status">{'Similar papers need an account. Sign in to see them.'}</p>;
  }
  if (status === 'error') {
    return (
      <EmptyState
        as="p"
        role="status"
        className="graph-empty"
        art={<Petri pose="upset" className="graph-empty-petri" />}
        title={'Similar papers did not load'}
      >
        {'The rest of PaperTok keeps working.'}
      </EmptyState>
    );
  }
  if (status === 'empty') {
    return (
      <EmptyState as="p" className="graph-empty" art={<Petri pose="star" className="graph-empty-petri" />} title={'No similar papers'}>
        {'Semantic Scholar has no recommendations for this paper yet.'}
      </EmptyState>
    );
  }
  return (
    <div className="related-list similar-list" ref={listRef}>
      {entries.slice(0, count).map(({ paper: related, key }) => (
        <button key={key} type="button" className="related-item" onClick={() => open(related)}>
          <span className="related-item-copy">
            {(related.year || related.journal) && (
              <span className="similar-year">{[related.year, related.journal].filter(Boolean).join(' · ')}</span>
            )}
            <strong><ScientificText>{related.title}</ScientificText></strong>
          </span>
          <CaretRight size={16} aria-hidden="true" className="similar-caret" />
        </button>
      ))}
      {hasMore && <span ref={moreRef} className="similar-more" aria-hidden="true" />}
    </div>
  );
}
