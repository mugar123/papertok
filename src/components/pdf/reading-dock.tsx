import type { ComponentProps, ReactNode } from 'react';
import type { Paper } from '../../models/paper.ts';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOut, CircleNotch, Headphones, NotePencil, SpeakerHigh } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { useAuth } from '../../context/auth-context.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { saveFile } from '../../utils/save-file.ts';
import { ReadAloudError } from '../../services/read-aloud-service.ts';
import { Button } from '../ui/button.tsx';
import { Toggle } from '../ui/toggle.ts';
import { PaperDock } from './paper-info.tsx';
import type { ReadAloudChapter, SpokenPassage } from './read-aloud.ts';
import { readAloudStart } from './read-aloud.ts';
import { useReadAloud } from './use-read-aloud.ts';
import { useSpokenWord } from './use-spoken-word.ts';
import { useZoteroAction } from './use-zotero-action.ts';
import { ZoteroMark } from './zotero-mark.tsx';
import ReadAloudPlayer from './read-aloud-player.tsx';
import ReadAloudListen from './read-aloud-listen.tsx';

const NO_PASSAGES: SpokenPassage[] = [];
const NO_CHAPTERS: ReadAloudChapter[] = [];

type ReadingDockProps = Pick<ComponentProps<typeof PaperDock>, 'scroll' | 'contents' | 'menu'> & {
  title: string;
  paper?: Paper;
  spoken: { queue: SpokenPassage[]; chapters: ReadAloudChapter[] } | null;
  canListen: boolean;
  notes: { id: string; open: boolean; count: number; onOpenChange: (open: boolean) => void } | null;
  originalUrl: string;
  children?: ReactNode;
};

export function ReadingDock({ title, paper, scroll, contents, menu, spoken, canListen, notes, originalUrl, children }: ReadingDockProps) {
  const { readingPreferences } = useAuth();
  const { trackEvent } = useAnalyticsConsent();
  const readAloud = useReadAloud(spoken?.queue ?? NO_PASSAGES, spoken?.chapters ?? NO_CHAPTERS, {
    title,
    onFallback: cause => toast(cause instanceof ReadAloudError && (cause.code === 'AI_QUOTA_EXHAUSTED' || cause.code === 'AI_AUDIO_NOT_STORED')
      ? 'Parts of this paper have no PaperTok audio yet, so this browser’s voice reads them.'
      : 'PaperTok’s voice is not available right now, so this browser’s voice reads instead.'),
    onError: () => toast.error('Reading aloud stopped. This browser could not play the voice.'),
    onBlocked: () => toast('The audio is ready. Press play to listen.'),
  });
  const { paragraph: speaking, reset: resetReadAloud } = readAloud;
  useSpokenWord({ root: scroll, queue: spoken?.queue ?? NO_PASSAGES, speaking, timings: readAloud.timings, live: readAloud.live, playing: readAloud.playing, position: readAloud.position });
  useEffect(() => () => resetReadAloud(), [spoken, canListen, resetReadAloud]);
  const readAloudButton = useRef<HTMLButtonElement | null>(null);
  // The closed dock's outline while the player is open, which it grows out of.
  const [playerFrom, setPlayerFrom] = useState<{ width: number; height: number } | null>(null);
  const playerOpen = playerFrom !== null && canListen;
  // The player is as wide as the text column, which narrows when the notes open (read-aloud-player.css).
  useEffect(() => {
    const article = scroll?.querySelector<HTMLElement>('article');
    const stage = scroll?.closest<HTMLElement>('.pdf-stage');
    if (!playerOpen || !article || !stage) return undefined;
    const measure = () => {
      const style = getComputedStyle(article);
      stage.style.setProperty('--ft-text-w', `${article.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(article);
    return () => {
      observer.disconnect();
      stage.style.removeProperty('--ft-text-w');
    };
  }, [playerOpen, scroll]);
  const followsVoice = useRef(true);
  useEffect(() => {
    if (!scroll) return undefined;
    const controller = new AbortController();
    const release = () => { followsVoice.current = false; };
    for (const type of ['wheel', 'touchmove', 'keydown']) scroll.addEventListener(type, release, { signal: controller.signal, passive: true });
    scroll.addEventListener('pointerdown', (event) => {
      if (event.target === scroll) release();
    }, { signal: controller.signal, passive: true });
    return () => controller.abort();
  }, [scroll]);
  const spokenPassage = speaking === null ? null : spoken?.queue[speaking]?.passage ?? null;
  useEffect(() => {
    if (!scroll || !spokenPassage) return undefined;
    const block = scroll.querySelector<HTMLElement>(`[data-passage="${CSS.escape(spokenPassage)}"]`);
    if (!block) return undefined;
    block.setAttribute('data-speaking', '');
    if (followsVoice.current) {
      // Centred in what the top bar and the player leave visible, or from its start when it does not fit.
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const view = scroll.getBoundingClientRect();
      const top = Math.max(view.top, scroll.closest('.pdf-viewer, .rd')?.querySelector('.pdf-topbar, .rd-topbar')?.getBoundingClientRect().bottom ?? view.top);
      const bottom = Math.min(view.bottom, scroll.parentElement?.querySelector('.pdf-dock')?.getBoundingClientRect().top ?? view.bottom);
      const room = bottom - top;
      const rect = block.getBoundingClientRect();
      const offset = rect.height < room ? (room - rect.height) / 2 : 16;
      scroll.scrollTo({ top: scroll.scrollTop + rect.top - top - offset, behavior: still ? 'auto' : 'smooth' });
    }
    return () => block.removeAttribute('data-speaking');
  }, [spokenPassage, scroll]);
  const savingAudio = useRef(false);
  const downloadAudio = () => {
    if (savingAudio.current) return;
    savingAudio.current = true;
    readAloud.audioFile()
      .then(file => saveFile(file, title, 'mp3'), () => toast.error('Could not save the audio.'))
      .finally(() => { savingAudio.current = false; });
  };
  const playPause = () => {
    if (readAloud.playing) {
      readAloud.pause();
      return;
    }
    followsVoice.current = true;
    if (speaking === null) void trackEvent('read_aloud_start', { surface: 'reader' });
    let visible = null;
    if (readingPreferences.readAloudFromPosition && scroll && spoken) {
      const { top, bottom } = scroll.getBoundingClientRect();
      const onScreen = new Set([...scroll.querySelectorAll<HTMLElement>('[data-passage]')]
        .filter((block) => {
          const rect = block.getBoundingClientRect();
          return rect.bottom > top && rect.top < bottom;
        })
        .map(block => block.dataset.passage));
      const first = spoken.queue.findIndex(item => onScreen.has(item.passage));
      if (first !== -1) visible = { first, last: spoken.queue.findLastIndex(item => onScreen.has(item.passage)) };
    }
    readAloud.play(readAloudStart(speaking, visible));
  };
  const openPlayer = () => {
    const bar = readAloudButton.current?.closest<HTMLElement>('.pdf-dock');
    if (bar) {
      const padding = Number.parseFloat(getComputedStyle(bar).paddingLeft) || 0;
      setPlayerFrom({ width: bar.clientWidth - 2 * padding, height: bar.getBoundingClientRect().height });
    }
    if (!readAloud.playing) playPause();
  };
  const [listening, setListening] = useState(false);
  const closePlayer = () => {
    setListening(false);
    readAloud.pause();
    setPlayerFrom(null);
    requestAnimationFrame(() => readAloudButton.current?.focus());
  };

  // The listening view's own way in, round in the top bar's corner.
  const topbar = scroll?.closest('.pdf-viewer, .rd')?.querySelector('.pdf-topbar, .rd-topbar');
  const listen = () => {
    if (!playerOpen) openPlayer();
    else if (!readAloud.playing) playPause();
    setListening(true);
  };

  return <>
    {scroll && createPortal(<div className="rd-word" hidden aria-hidden="true" />, scroll)}
    {canListen && topbar && createPortal(
      <Button variant="outline" size="icon" className="rd-listen-corner" onClick={listen} aria-label="Listen to the paper" title="Listen to the paper">
        <Headphones size={18} aria-hidden="true" />
      </Button>,
      topbar,
    )}
    <PaperDock scroll={scroll} pinned={playerOpen} menu={playerOpen ? undefined : menu} contents={playerOpen ? null : contents}>
      {playerOpen ? <ReadAloudPlayer
        timeline={readAloud.timeline} prepared={readAloud.prepared} position={readAloud.position}
        playing={readAloud.playing} speed={readAloud.speed} onSpeed={readAloud.setSpeed} onPlayPause={playPause} onSeek={readAloud.seek}
        onClose={closePlayer} onDownload={downloadAudio} onExpand={() => setListening(true)} openedFrom={playerFrom}
      /> : <>
        {children}
        {notes && <Toggle className="pdf-dock-toggle pdf-dock-notes" pressed={notes.open} onPressedChange={notes.onOpenChange} aria-label="Notes" aria-controls={notes.id} title={notes.open ? 'Hide notes' : 'Show notes'}>
          <NotePencil size={18} aria-hidden="true" />
          <span><span className="pdf-dock-label">Notes</span>{notes.count > 0 && <span className="pdf-dock-count">{notes.count}</span>}</span>
        </Toggle>}
        {canListen && <Toggle ref={readAloudButton} className="pdf-dock-toggle" pressed={readAloud.playing} onPressedChange={openPlayer} aria-label="Voice, read aloud" title="Read aloud">
          <SpeakerHigh size={18} aria-hidden="true" /><span className="pdf-dock-label">Voice</span>
        </Toggle>}
      </>}
      {paper && <ZoteroControl paper={paper} hidden={playerOpen} />}
      {!playerOpen && originalUrl && <Button role="link" variant="ghost" size="icon" aria-label="Open in a new tab" title="Open in a new tab" render={<a href={originalUrl} target="_blank" rel="noopener noreferrer" />}><ArrowSquareOut size={18} aria-hidden="true" /></Button>}
    </PaperDock>
    {playerOpen && spoken && <ReadAloudListen
      open={listening} onOpenChange={setListening} title={title} queue={spoken.queue}
      timeline={readAloud.timeline} prepared={readAloud.prepared} paragraph={readAloud.paragraph}
      position={readAloud.position} playing={readAloud.playing} speed={readAloud.speed}
      timings={readAloud.timings} live={readAloud.live}
      onSpeed={readAloud.setSpeed} onPlayPause={playPause} onSeek={readAloud.seek}
    />}
  </>;
}

function ZoteroControl({ paper, hidden }: { paper: Paper; hidden: boolean }) {
  const { user } = useAuth();
  const zotero = useZoteroAction(paper, user?.uid, true);
  if (!zotero || hidden) return null;
  const name = zotero.sent ? `${zotero.label} (${zotero.hint.charAt(0).toLowerCase()}${zotero.hint.slice(1)})` : zotero.label;
  return <Button variant="ghost" className="pdf-dock-toggle pdf-dock-zotero" onClick={zotero.onSelect}
    disabled={zotero.busy} focusableWhenDisabled aria-busy={zotero.busy || undefined}
    aria-label={name} title={name} data-sent={zotero.sent ? '' : undefined}>
    {zotero.busy ? <CircleNotch size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ZoteroMark size={18} />}
    <span className="pdf-dock-label">Zotero</span>
  </Button>;
}
