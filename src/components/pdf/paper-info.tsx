import type { ReactNode } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { Block, FullText } from '../../utils/full-text.ts';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { ArrowRight, Info, ListBullets } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { EASE_IN_OUT, EASE_OUT, MOTION_BASE_S } from '../../utils/motion-curves.ts';
import { plainText } from '../../utils/full-text.ts';
import { getCategoryLabel } from '../../data/category-taxonomy.ts';
import { resolvePaperTopic, topicExplorerPath } from '../../utils/topic-navigation.ts';

const WORDS_PER_MINUTE = 230;
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function words(blocks: Block[]) {
  const text = blocks.map(block => {
    if (block.t === 'p' || block.t === 'heading') return plainText(block.children);
    if (block.t === 'list') return block.items.map(plainText).join(' ');
    return '';
  }).join(' ');
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * What is known about the paper and about the text being read: where and when
 * it appeared, the figures that size it up in one ruled row, and its
 * subjects, each opening its page. A fact no source states is left out rather
 * than shown as empty or zero.
 */
function PaperInfo({ paper, doc }: { paper: Paper; doc: FullText | null | undefined }) {
  const venue = paper.journal || paper.conference;
  // Each arXiv category as the app's own topic page, as a card's topic links to it.
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
    { value: citations !== undefined ? compact.format(citations) : '—', unit: '', label: 'Citations', hint: citations !== undefined ? undefined : 'Not counted yet' },
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
                  ? <a href={subject.path} target="_blank" rel="noopener noreferrer"><span>{subject.label}</span><ArrowRight size={14} aria-hidden="true" /><span className="visually-hidden"> (opens in a new tab)</span></a>
                  : <span>{subject.label}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * The viewer's tools, floating at the bottom, and the card that grows out of
 * them with the outline or the paper's information: the card is clipped to the bar's own outline when
 * closed (`--dock-w`, `--dock-h`, measured here) and opens out from it.
 */
export function PaperDock({ paper, doc, scroll, contents, children }: {
  paper: Paper;
  doc: FullText | null | undefined;
  scroll: HTMLElement | null;
  // The outline, where the bar offers it (below the rail's breakpoint), given a way to close the card.
  contents: ((close: () => void) => ReactNode) | null;
  children: ReactNode;
}) {
  // One card for two things, the outline or the paper's information: what it
  // shows outlives its being open, so it leaves with its content.
  const [open, setOpen] = useState(false);
  const [shows, setShows] = useState<'contents' | 'info'>('info');
  const panelId = useId();
  // Reading down the text stows the bar on a phone (pdf-viewer.css); scrolling back up brings it back.
  const [stowed, setStowed] = useState(false);
  useEffect(() => {
    if (!scroll) return;
    let last = scroll.scrollTop;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroll.scrollTop;
      if (top < 48) setStowed(false);
      else if (top - last > 8) setStowed(true);
      else if (last - top > 8) setStowed(false);
      else return;
      last = top;
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => { scroll.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [scroll]);
  const root = useRef<HTMLDivElement | null>(null);
  const dock = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
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
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      opener.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    root.current?.addEventListener('keydown', escape);
    const element = root.current;
    return () => { document.removeEventListener('pointerdown', outside); element?.removeEventListener('keydown', escape); };
  }, [open]);
  // The outline opens on the section being read.
  useEffect(() => {
    if (!open || shows !== 'contents') return;
    const frame = requestAnimationFrame(() => {
      const card = panel.current?.querySelector<HTMLElement>('.pdf-info-body');
      const link = card?.querySelector<HTMLElement>('[aria-current="location"]');
      if (card && link) card.scrollTop = link.offsetTop - card.clientHeight / 2 + link.offsetHeight / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, shows]);
  // Swapping what the open card shows (outline or information) resizes it
  // from the height it had, measured at the press, to the one it lands on,
  // and fades the new content in; a swap during a swap starts from where the
  // card is.
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
  // A second press of the same button closes the card; the other one swaps what it shows.
  const toggle = (what: 'contents' | 'info', button: HTMLButtonElement) => {
    opener.current = button;
    if (open && shows === what) setOpen(false);
    else {
      if (open && panel.current) swapFrom.current = panel.current.getBoundingClientRect().height;
      setShows(what);
      setOpen(true);
    }
  };
  const close = () => setOpen(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="pdf-dock-root" ref={root} data-stowed={(stowed && !open) || undefined}>
      <Collapsible.Panel
        keepMounted
        id={panelId}
        ref={panel}
        className="pdf-info"
        data-shows={shows}
        role="region"
        aria-label={shows === 'contents' ? 'Contents' : 'About this paper'}
        render={(props, state) => <div {...props} inert={!state.open} />}
      >
        <div className="pdf-info-body">
          {shows === 'contents' && contents ? contents(close) : <PaperInfo paper={paper} doc={doc} />}
        </div>
      </Collapsible.Panel>
      <div className="pdf-dock" role="group" aria-label="Paper tools" ref={dock} data-info-open={open || undefined}>
        {contents && (
          <Button variant="ghost" size="icon" className="ft-outline-button" aria-label="Contents" title="Contents" aria-expanded={open && shows === 'contents'} aria-controls={panelId} onClick={event => toggle('contents', event.currentTarget)}>
            <ListBullets size={18} aria-hidden="true" />
          </Button>
        )}
        {children}
        <Button variant="ghost" size="icon" aria-label="About this paper" title="About this paper" aria-expanded={open && shows === 'info'} aria-controls={panelId} onClick={event => toggle('info', event.currentTarget)}>
          <Info size={18} aria-hidden="true" />
        </Button>
      </div>
    </Collapsible.Root>
  );
}
