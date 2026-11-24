import type { Paper } from '../../models/paper.ts';
import type { ReaderMenu } from '../feed/paper-menu.tsx';
import type { ReadingView } from './reading-tabs.tsx';
import type { PaperViewState } from './paper-view.ts';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { loadPaperByIdentity } from '../../services/paper-lookup.ts';
import { getPublicPaperPath, getPublicPaperUrl, parsePaperKey } from '../../utils/public-navigation.ts';
import { SLUGS, handoffs, opener } from './paper-view.ts';

const PDFViewer = lazy(() => import('./pdf-viewer.tsx'));

/**
 * A paper's viewer at its address. From a card it has the card's paper and menu; from a link or a
 * reload it loads the paper by its key, and its menu has no card actions. Leaving goes back to the
 * page under it when there is one, otherwise to the paper's page.
 */
export function PaperViewRoute({ paperKey, view }: { paperKey: string; view: ReadingView }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [handoff] = useState(() => handoffs.get(paperKey) ?? null);
  const [loaded, setLoaded] = useState<Paper | null>(null);
  useEffect(() => {
    if (handoff) return undefined;
    const identity = parsePaperKey(paperKey);
    if (!identity) return undefined;
    let current = true;
    loadPaperByIdentity(identity)
      .then((paper) => { if (current && paper) setLoaded(paper); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [handoff, paperKey]);
  const paper = handoff?.paper ?? loaded;
  // Without a card: the paper's share address, and no About, Mark as read or Not interested.
  const menu = useMemo<ReaderMenu>(() => {
    if (handoff) return handoff.menu;
    const card = { about: null, links: null, isRead: false, shareUrl: (paper && getPublicPaperUrl(paper)) || '' };
    return { snapshot: () => card, subscribe: () => () => undefined };
  }, [handoff, paper]);
  const fromPage = Boolean((location.state as PaperViewState | null)?.background);
  const close = useCallback(() => {
    handoffs.delete(paperKey);
    if (fromPage) void navigate(-1);
    else void navigate(getPublicPaperPath(paperKey) ?? '/feed', { replace: true });
    const { control } = opener;
    opener.control = null;
    if (control) requestAnimationFrame(() => { if (control.isConnected) control.focus({ preventScroll: true }); });
  }, [fromPage, navigate, paperKey]);
  const changeView = useCallback((next: ReadingView) => {
    const page = getPublicPaperPath(paperKey);
    if (page) void navigate(`${page}/${SLUGS[next]}`, { replace: true, state: location.state });
  }, [location.state, navigate, paperKey]);
  if (!paper) return null;
  return (
    <Suspense fallback={null}>
      <PDFViewer key={paperKey} paper={paper} menu={menu} readingView={view} onViewChange={changeView} onClose={close} />
    </Suspense>
  );
}

