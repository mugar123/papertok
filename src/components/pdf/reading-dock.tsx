import type { ComponentProps, ReactNode } from 'react';
import type { Paper } from '../../models/paper.ts';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOut, CircleNotch, Headphones, NotePencil } from '@phosphor-icons/react';
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
import { useZoteroAction } from './use-zotero-action.ts';
import { ZoteroMark } from './zotero-mark.tsx';
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
  useEffect(() => () => resetReadAloud(), [spoken, canListen, resetReadAloud]);
  const listenButton = useRef<HTMLButtonElement | null>(null);
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

  // The podcast tab's way in and out, round in the top bar's corner. The text under it is left
  // out of the keyboard's way while the tab covers it.
  const topbar = scroll?.closest('.pdf-viewer, .rd')?.querySelector('.pdf-topbar, .rd-topbar');
  // The podcast is the voice's only player: opening it starts the voice, closing it stops it.
  const [listening, setListening] = useState(false);
  const listen = (open: boolean) => {
    if (open && !readAloud.playing) playPause();
    if (!open) readAloud.pause();
    setListening(open);
  };
  const podcast = listening && canListen;
  useEffect(() => {
    if (!scroll || !podcast) return undefined;
    scroll.toggleAttribute('inert', true);
    return () => { scroll.toggleAttribute('inert', false); };
  }, [podcast, scroll]);
  const byline = (paper?.authors ?? []).map(author => (typeof author === 'string' ? author : author.name)).filter(Boolean);

  return <>
    {canListen && topbar && createPortal(
      <Toggle ref={listenButton} className="rd-listen-corner" pressed={podcast} onPressedChange={listen} aria-label="Listen to the paper as a podcast" title={podcast ? 'Back to the text' : 'Listen as a podcast'}>
        <Headphones size={18} weight={podcast ? 'fill' : 'regular'} aria-hidden="true" />
      </Toggle>,
      topbar,
    )}
    {/* Hidden rather than unmounted while the podcast tab covers it, so a Zotero send in flight finishes. */}
    <div hidden={podcast}><PaperDock scroll={scroll} menu={menu} contents={contents}>
      {children}
      {notes && <Toggle className="pdf-dock-toggle pdf-dock-notes" pressed={notes.open} onPressedChange={notes.onOpenChange} aria-label="Notes" aria-controls={notes.id} title={notes.open ? 'Hide notes' : 'Show notes'}>
        <NotePencil size={18} aria-hidden="true" />
        <span><span className="pdf-dock-label">Notes</span>{notes.count > 0 && <span className="pdf-dock-count">{notes.count}</span>}</span>
      </Toggle>}
      {paper && <ZoteroControl paper={paper} hidden={false} />}
      {originalUrl && <Button role="link" variant="ghost" size="icon" aria-label="Open in a new tab" title="Open in a new tab" render={<a href={originalUrl} target="_blank" rel="noopener noreferrer" />}><ArrowSquareOut size={18} aria-hidden="true" /></Button>}
    </PaperDock></div>
    {podcast && spoken && <ReadAloudListen
      title={paper?.title ?? title}
      byline={byline.length > 3 ? `${byline.slice(0, 3).join(', ')} and others` : byline.join(', ')}
      queue={spoken.queue}
      timeline={readAloud.timeline} prepared={readAloud.prepared} paragraph={readAloud.paragraph}
      position={readAloud.position} playing={readAloud.playing} speed={readAloud.speed}
      timings={readAloud.timings} live={readAloud.live}
      onSpeed={readAloud.setSpeed} onPlayPause={playPause} onSeek={readAloud.seek} onDownload={downloadAudio}
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
