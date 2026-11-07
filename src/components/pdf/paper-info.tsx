import type { ReactNode } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { Block, FullText } from '../../utils/full-text.ts';
import type { ReaderMenu } from '../feed/paper-menu.tsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PopoverChangeDetails } from '../ui/popover.tsx';
import { Popover, PopoverPopup, PopoverPortal, PopoverPositioner, PopoverTitle, PopoverTrigger } from '../ui/popover.tsx';
import { DotsThree, ListBullets } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { useScrollFrame } from './use-scroll-frame.ts';
import { EASE_IN_OUT, EASE_OUT, MOTION_BASE_S } from '../../utils/motion-curves.ts';
import { blockInlines, plainText } from '../../utils/full-text.ts';
import { PaperMenuBody } from '../feed/paper-menu.tsx';
import { paperActions, paperShareUrl, shareMethod } from '../feed/paper-actions.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { areaAccentForPaper } from '../../utils/area-accent.ts';

const WORDS_PER_MINUTE = 230;

function words(blocks: Block[]) {
  return blocks.flatMap(blockInlines).map(plainText).join(' ').split(/\s+/).filter(Boolean).length;
}

const readingMinutes = (doc: FullText) => Math.max(1, Math.round(words([...doc.abstract, ...doc.body]) / WORDS_PER_MINUTE));

// The card is clipped to the bar's outline when closed (`--dock-w`, `--dock-h`, measured here).
export function PaperDock({ paper, doc, scroll, contents, fromCard, onLeave, children }: {
  paper: Paper;
  doc: FullText | null | undefined;
  scroll: HTMLElement | null;
  contents: ((close: () => void) => ReactNode) | null;
  fromCard: ReaderMenu;
  onLeave: (then: () => void) => void;
  children: ReactNode;
}) {
  const [view, setView] = useState<'closed' | 'contents' | 'actions' | 'about'>('closed');
  const open = view !== 'closed';
  const [shows, setShows] = useState<'contents' | 'menu'>('menu');
  const signedIn = Boolean(useAuth().user);
  const { trackEvent } = useAnalyticsConsent();
  const [stowed, setStowed] = useState(false);
  const lastTop = useRef(0);
  useScrollFrame(scroll, () => {
    const top = scroll?.scrollTop ?? 0;
    if (top < 48) setStowed(false);
    else if (top - lastTop.current > 8) setStowed(true);
    else if (lastTop.current - top > 8) setStowed(false);
    else return;
    lastTop.current = top;
  });
  // State, not a ref: the portal needs the element on its first render.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const dock = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const bar = dock.current;
    if (!bar) return;
    const measure = () => {
      panel.current?.style.setProperty('--dock-w', `${bar.offsetWidth}px`);
      panel.current?.style.setProperty('--dock-h', `${bar.offsetHeight}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (view !== 'contents') return;
    const frame = requestAnimationFrame(() => {
      const card = panel.current?.querySelector<HTMLElement>('.pdf-info-body');
      const link = card?.querySelector<HTMLElement>('[aria-current="location"]');
      if (card && link) card.scrollTop = link.offsetTop - card.clientHeight / 2 + link.offsetHeight / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);
  // A swap resizes the card from the height measured at the press; a swap during a swap starts from where it is.
  const swapFrom = useRef(0);
  const resize = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const card = panel.current;
    const from = swapFrom.current;
    swapFrom.current = 0;
    if (!card || !from) return;
    resize.current?.cancel();
    const to = card.offsetHeight;
    if (Math.abs(from - to) < 1) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!still) resize.current = card.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: MOTION_BASE_S * 1000, easing: `cubic-bezier(${EASE_IN_OUT.join(', ')})` });
    card.querySelector('.pdf-info-body')?.animate(
      still ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: MOTION_BASE_S * 1000, easing: `cubic-bezier(${EASE_OUT.join(', ')})` },
    );
  }, [shows]);
  // A press on the bar's other tools is not a press outside the card.
  const onOpenChange = (next: boolean, details: PopoverChangeDetails) => {
    if (!next && details.reason === 'outside-press' && dock.current?.contains(details.event.target as Node)) return;
    const what = details.trigger?.getAttribute('data-shows');
    if (next && (what === 'contents' || what === 'menu')) {
      if (open && what !== shows && panel.current) swapFrom.current = panel.current.getBoundingClientRect().height;
      setShows(what);
      setView(what === 'contents' ? 'contents' : 'actions');
      return;
    }
    if (!next) setView('closed');
  };
  const close = () => setView('closed');
  const menu = (
    <PaperMenuBody
      title={paper.title}
      url={paperShareUrl(paper)}
      onShared={method => { void trackEvent('share', { method: shareMethod(method), content_type: 'paper', surface: 'reader' }); }}
      actions={paperActions({
        paper,
        isRead: fromCard.isRead(),
        aboutHint: 'Status, topics, funding and links',
        onAbout: () => setView('about'),
        onToggleRead: () => { if (signedIn && fromCard.isRead()) fromCard.toggleRead(); else onLeave(fromCard.toggleRead); },
        onNotInterested: () => onLeave(fromCard.notInterested),
      })}
      open={view === 'actions' || view === 'about'}
      onClose={close}
      ShareHeading="h3"
      panel={view === 'about' ? {
        id: 'about',
        title: 'About this paper',
        subtitle: doc && `${readingMinutes(doc)} min read`,
        aside: fromCard.links(),
        content: fromCard.about(),
        className: 'pc-about pc-about--reader',
        style: { '--area-accent': areaAccentForPaper(paper) },
        onBack: () => setView('actions'),
      } : null}
      renderTitle={heading => <PopoverTitle className="pc-share-sheet-title font-serif text-[1.25rem] font-semibold leading-tight tracking-[-0.01em] text-foreground">{heading}</PopoverTitle>}
    />
  );
  return (
    <div className="pdf-dock-root" ref={setRoot} data-stowed={(stowed && !open) || undefined}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverPortal keepMounted container={root}>
          <PopoverPositioner
            anchor={dock}
            side="top"
            align="center"
            sideOffset={({ anchor }) => -anchor.height}
            collisionAvoidance={{ side: 'none', align: 'none' }}
            className="pdf-info-positioner"
          >
            <PopoverPopup ref={panel} className="pdf-info" data-shows={shows} aria-label={shows === 'contents' ? 'Contents' : undefined}>
              <div className="pdf-info-body">
                {shows === 'contents' && contents ? contents(close) : menu}
              </div>
            </PopoverPopup>
          </PopoverPositioner>
        </PopoverPortal>
        <div className="pdf-dock" role="group" aria-label="Paper tools" ref={dock} data-info-open={open || undefined}>
          {contents && (
            <PopoverTrigger data-shows="contents" render={<Button variant="ghost" size="icon" className="ft-outline-button" aria-label="Contents" title="Contents" />}>
              <ListBullets size={18} aria-hidden="true" />
            </PopoverTrigger>
          )}
          {children}
          <PopoverTrigger data-shows="menu" render={<Button variant="ghost" size="icon" aria-label="More actions" title="More actions" />}>
            <DotsThree size={18} weight="bold" aria-hidden="true" />
          </PopoverTrigger>
        </div>
      </Popover>
    </div>
  );
}
