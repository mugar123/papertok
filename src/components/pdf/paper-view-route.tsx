import type { Paper } from '../../models/paper.ts';
import type { ReaderMenu } from '../feed/paper-menu.tsx';
import type { ReadingView } from './reading-tabs.tsx';
import type { PaperViewState } from './paper-view.ts';
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { loadPaperByIdentity } from '../../services/paper-lookup.ts';
import { getPublicPaperPath, getPublicPaperUrl, parsePaperKey } from '../../utils/public-navigation.ts';
import { SLUGS, handoffs } from './paper-view.ts';
import { toast } from 'sonner';

const PDFViewer = lazy(() => import('./pdf-viewer.tsx'));

/**
 * A paper's viewer at its address. From a card it has the card's paper and menu; from a link or a
 * reload it loads the paper by its key, and its menu has no card actions. A paper that cannot be
 * loaded leaves for its page, which says what went wrong, with a notice. Leaving goes back to the
 * page under it when the viewer was opened from one, otherwise to the paper's page.
 */
export function PaperViewRoute({ paperKey, view, left, onLeft }: { paperKey: string; view: ReadingView; left: boolean; onLeft: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [handoff] = useState(() => handoffs.get(paperKey) ?? null);
  const [loaded, setLoaded] = useState<Paper | null>(null);
  const toPaperPage = useEffectEvent(() => {
    toast.error('This paper could not be opened. Try again from its page.');
    void navigate(getPublicPaperPath(paperKey) ?? '/feed', { replace: true });
  });
  useEffect(() => {
    if (handoff) return undefined;
    const identity = parsePaperKey(paperKey);
    if (!identity) {
      toPaperPage();
      return undefined;
    }
    let current = true;
    loadPaperByIdentity(identity)
      .then((paper) => {
        if (!current) return;
        if (paper) setLoaded(paper);
        else toPaperPage();
      })
      .catch(() => { if (current) toPaperPage(); });
    return () => { current = false; };
  }, [handoff, paperKey]);
  const paper = handoff?.paper ?? loaded;
  // Without a card: the paper's share address, and no About, Mark as read or Not interested.
  const menu = useMemo<ReaderMenu>(() => {
    if (handoff) return handoff.menu;
    const card = { about: null, links: null, isRead: false, shareUrl: (paper && getPublicPaperUrl(paper)) || '' };
    return { snapshot: () => card, subscribe: () => () => undefined };
  }, [handoff, paper]);
  // Opened from a page in this page load: going back returns to it.
  const fromPage = Boolean(handoff) && Boolean((location.state as PaperViewState | null)?.background);
  // Closed by its X or Escape, the viewer leaves its route; once the route was left (Back), it is
  // only unmounted, after its leave has played.
  const close = useCallback(() => {
    if (left) onLeft();
    else if (fromPage) void navigate(-1);
    else void navigate(getPublicPaperPath(paperKey) ?? '/feed', { replace: true });
  }, [fromPage, left, navigate, onLeft, paperKey]);
  const changeView = useCallback((next: ReadingView) => {
    const page = getPublicPaperPath(paperKey);
    if (page) void navigate(`${page}/${SLUGS[next]}`, { replace: true, state: location.state });
  }, [location.state, navigate, paperKey]);
  if (!paper) return null;
  return (
    <Suspense fallback={null}>
      <PDFViewer key={paperKey} paper={paper} menu={menu} readingView={view} onViewChange={changeView} closing={left} onClose={close} />
    </Suspense>
  );
}

