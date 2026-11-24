import type { Location } from 'react-router-dom';
import type { Paper } from '../../models/paper.ts';
import type { ReaderMenu } from '../feed/paper-menu.tsx';
import type { ReadingView } from './reading-tabs.tsx';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { getPublicPaperPath } from '../../utils/public-navigation.ts';

/** The viewer's tabs in the address: `/paper/<key>/read`, `/listen` and `/summary`. */
export const SLUGS: Record<ReadingView, string> = { paper: 'read', listen: 'listen', summary: 'summary' };
const VIEWS: Record<string, ReadingView | undefined> = { read: 'paper', listen: 'listen', summary: 'summary' };

/** The paper key and tab of a viewer's address, or null for any other path. */
export function matchPaperView(pathname: string) {
  const match = matchPath('/paper/:paperKey/:tab', pathname);
  const view = match ? VIEWS[match.params.tab ?? ''] : undefined;
  if (!match?.params.paperKey || !view) return null;
  // The router leaves some escapes in a parameter; the key is the paper's, unescaped.
  let paperKey = match.params.paperKey;
  try { paperKey = decodeURIComponent(paperKey); } catch { /* already plain */ }
  return { paperKey, view };
}

/** What the viewer's route draws under it: the page it was opened from. */
export type PaperViewState = { background?: Location };

/**
 * The paper and its card's menu, handed from the card that opened the viewer to its route. The
 * menu holds the card's live state and actions, which history state cannot carry.
 */
export const handoffs = new Map<string, { paper: Paper; menu: ReaderMenu }>();
// The control that opened the viewer, which takes the focus back when it closes.
export const opener: { control: HTMLElement | null } = { control: null };

/** Opens a paper's viewer on its route, over the page it is opened from, which stays mounted under it. */
export function useOpenPaperView() {
  const navigate = useNavigate();
  const location = useLocation();
  const here = useRef(location);
  useLayoutEffect(() => { here.current = location; });
  return useCallback((paper: Paper, menu: ReaderMenu) => {
    const page = getPublicPaperPath(paper);
    const view = page && matchPaperView(`${page}/read`);
    if (!page || !view) return;
    handoffs.set(view.paperKey, { paper, menu });
    opener.control = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Opened from another viewer's page, the page under both stays the one beneath.
    const background = (here.current.state as PaperViewState | null)?.background ?? here.current;
    void navigate(`${page}/read`, { state: { background } satisfies PaperViewState });
  }, [navigate]);
}

