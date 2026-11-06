import type { ReactNode } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { Block, FullText } from '../../utils/full-text.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PopoverChangeDetails } from '../ui/popover.tsx';
import { Popover, PopoverPopup, PopoverPortal, PopoverPositioner, PopoverTrigger } from '../ui/popover.tsx';
import { ArrowRight, Info, ListBullets } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { useScrollFrame } from './use-scroll-frame.ts';
import useIsPhone from '../../hooks/use-is-phone.ts';
import { Drawer, DrawerContent, DrawerHandle } from '../ui/drawer.tsx';
import { EASE_IN_OUT, EASE_OUT, MOTION_BASE_S } from '../../utils/motion-curves.ts';
import { blockInlines, plainText } from '../../utils/full-text.ts';
import { getCategoryLabel } from '../../data/category-taxonomy.ts';
import { resolvePaperTopic, topicExplorerPath } from '../../utils/topic-navigation.ts';
import { NewTabHint } from './new-tab-hint.tsx';
import { compactCount } from '../../utils/format-count.ts';

const WORDS_PER_MINUTE = 230;

function words(blocks: Block[]) {
  return blocks.flatMap(blockInlines).map(plainText).join(' ').split(/\s+/).filter(Boolean).length;
}

function PaperInfo({ paper, doc }: { paper: Paper; doc: FullText | null | undefined }) {
  const venue = paper.journal || paper.conference;
  const subjects = [...new Set([paper.primaryCategory, ...(paper.categories ?? [])].filter((code): code is string => Boolean(code)))]
    .map(code => {
      const label = getCategoryLabel(code) || code;
      return { code, label, path: topicExplorerPath(resolvePaperTopic({ categoryId: code, label })) };
    });
  const citations = paper.citationCountKnown || (paper.citationCount ?? 0) > 0 ? paper.citationCount : undefined;
  const length = doc ? words([...doc.abstract, ...doc.body]) : 0;
  const tiles = [
    doc && { value: String(Math.max(1, Math.round(length / WORDS_PER_MINUTE))), unit: 'min', label: 'Reading time' },
    // Always shown: a count no source states is a dash, not a zero.
    { value: citations !== undefined ? compactCount.format(citations) : '—', unit: '', label: 'Citations', hint: citations !== undefined ? undefined : 'Not counted yet' },
    doc && doc.references.length > 0 && { value: String(doc.references.length), unit: '', label: 'References' },
  ].filter((tile): tile is { value: string; unit: string; label: string; hint?: string } => Boolean(tile));
  return (
    <>
      <div className="pdf-info-head">
        <p className="pdf-info-when">{[venue, paper.year].filter(Boolean).join(' · ') || 'About this paper'}</p>
      </div>
      {tiles.length > 0 && (
        <ul className="pdf-info-stats" style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}>
          {tiles.map(tile => (
            <li key={tile.label}>
              <span className="pdf-info-label">{tile.label}</span>
              <span className="pdf-info-value" title={tile.hint}>{tile.value}{tile.unit && <small> {tile.unit}</small>}{tile.hint && <span className="visually-hidden"> ({tile.hint})</span>}</span>
            </li>
          ))}
        </ul>
      )}
      {subjects.length > 0 && (
        <section className="pdf-info-section" aria-labelledby="pdf-info-subjects">
          <h3 id="pdf-info-subjects" className="pdf-info-section-title">Subjects</h3>
          <ul className="pdf-info-rows">
            {subjects.map(subject => (
              <li key={subject.code}>
                {subject.path
                  ? <a href={subject.path} target="_blank" rel="noopener noreferrer"><span>{subject.label}</span><ArrowRight size={14} aria-hidden="true" /><NewTabHint /></a>
                  : <span>{subject.label}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// The card is clipped to the bar's outline when closed (`--dock-w`, `--dock-h`, measured here).
export function PaperDock({ paper, doc, scroll, contents, children }: {
  paper: Paper;
  doc: FullText | null | undefined;
  scroll: HTMLElement | null;
  contents: ((close: () => void) => ReactNode) | null;
  children: ReactNode;
}) {
  const isPhone = useIsPhone();
  const [open, setOpen] = useState(false);
  const [shows, setShows] = useState<'contents' | 'info'>('info');
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
  const body = useRef<HTMLDivElement | null>(null);
  const contentsButton = useRef<HTMLButtonElement | null>(null);
  const infoButton = useRef<HTMLButtonElement | null>(null);
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
    if (!open || shows !== 'contents') return;
    const frame = requestAnimationFrame(() => {
      const card = body.current;
      const link = card?.querySelector<HTMLElement>('[aria-current="location"]');
      if (card && link) card.scrollTop = link.offsetTop - card.clientHeight / 2 + link.offsetHeight / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, shows]);
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
    if (next && (what === 'contents' || what === 'info')) {
      if (open && what !== shows && panel.current) swapFrom.current = panel.current.getBoundingClientRect().height;
      setShows(what);
    }
    setOpen(next);
  };
  const close = () => setOpen(false);
  const label = shows === 'contents' ? 'Contents' : 'About this paper';
  const content = (
    <div className="pdf-info-body" ref={body} data-base-ui-swipe-ignore={isPhone || undefined}>
      {shows === 'contents' && contents ? contents(close) : <PaperInfo paper={paper} doc={doc} />}
    </div>
  );
  if (isPhone) {
    const show = (what: 'contents' | 'info') => {
      setShows(what);
      setOpen(true);
    };
    return (
      <div className="pdf-dock-root" data-stowed={(stowed && !open) || undefined}>
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="pdf-sheet" overlayClassName="ft-sheet-backdrop" forceOverlay viewportClassName="ft-sheet-viewport" aria-label={label} finalFocus={shows === 'contents' ? contentsButton : infoButton}>
            <DrawerHandle />
            {content}
          </DrawerContent>
        </Drawer>
        <div className="pdf-dock" role="group" aria-label="Paper tools" ref={dock}>
          {contents && (
            <Button ref={contentsButton} variant="ghost" size="icon" className="ft-outline-button" aria-label="Contents" title="Contents" aria-haspopup="dialog" onClick={() => show('contents')}>
              <ListBullets size={18} aria-hidden="true" />
            </Button>
          )}
          {children}
          <Button ref={infoButton} variant="ghost" size="icon" aria-label="About this paper" title="About this paper" aria-haspopup="dialog" onClick={() => show('info')}>
            <Info size={18} aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  }
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
            <PopoverPopup ref={panel} className="pdf-info" data-shows={shows} aria-label={label}>
              {content}
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
          <PopoverTrigger data-shows="info" render={<Button variant="ghost" size="icon" aria-label="About this paper" title="About this paper" />}>
            <Info size={18} aria-hidden="true" />
          </PopoverTrigger>
        </div>
      </Popover>
    </div>
  );
}
