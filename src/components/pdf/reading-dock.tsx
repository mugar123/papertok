import type { ComponentProps, ReactNode } from 'react';
import type { Paper } from '../../models/paper.ts';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOut, CircleNotch, DownloadSimple, Headphones, NotePencil } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { useAuth } from '../../context/auth-context.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { saveFile } from '../../utils/save-file.ts';
import { ReadAloudError, fetchVoiceUsage, markPaperVoiced } from '../../services/read-aloud-service.ts';
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
  /** The top bar of the viewer around the text, where the podcast's round button goes. */
  topbar?: HTMLElement | null;
  notes: { id: string; open: boolean; count: number; onOpenChange: (open: boolean) => void } | null;
  originalUrl: string;
  children?: ReactNode;
};

export function ReadingDock({ title, paper, scroll, contents, menu, spoken, canListen, topbar = null, notes, originalUrl, children }: ReadingDockProps) {
  const { readingPreferences } = useAuth();
  const { trackEvent } = useAnalyticsConsent();
  const readAloud = useReadAloud(spoken?.queue ?? NO_PASSAGES, spoken?.chapters ?? NO_CHAPTERS, {
    title,
    paperId: paper?.id,
    onFallback: cause => toast(!(cause instanceof ReadAloudError) ? 'PaperTok’s voice is not available right now, so this browser’s voice reads instead.'
      : cause.code === 'AI_QUOTA_EXHAUSTED' && cause.scope === 'user' ? 'You have used today’s papers with PaperTok’s voice, so this browser’s voice reads the parts without it. More tomorrow.'
      : cause.code === 'AI_QUOTA_EXHAUSTED' || cause.code === 'AI_AUDIO_NOT_STORED' ? 'Parts of this paper have no PaperTok audio yet, so this browser’s voice reads them.'
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
  const startAt = () => {
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
    return readAloudStart(speaking, visible);
  };
  const playPause = () => {
    if (readAloud.playing) readAloud.pause();
    else {
      readAloud.play(startAt());
    }
  };

  // The podcast tab's way in and out, round in the top bar's corner. The text under it is left
  // out of the keyboard's way while the tab covers it.
  // Opening prepares the first passages; playback starts with the player's Play button.
  const [listening, setListening] = useState(false);
  const listen = (open: boolean) => {
    if (open && speaking === null) {
      void trackEvent('read_aloud_start', { surface: 'reader' });
      readAloud.prepare(startAt());
    }
    if (!open) readAloud.pause();
    setListening(open);
  };
  const podcast = listening && canListen;
  // How many new papers the account may still hear in PaperTok's voice today, read once the
  // first passages are ready, so it already counts this paper.
  const [voiceLeft, setVoiceLeft] = useState<Awaited<ReturnType<typeof fetchVoiceUsage>>>(null);
  const startupDone = readAloud.startup.failed || readAloud.startup.ready >= readAloud.startup.total;
  useEffect(() => {
    if (!podcast || !startupDone) return undefined;
    const controller = new AbortController();
    void fetchVoiceUsage({ signal: controller.signal }).then(usage => { if (!controller.signal.aborted) setVoiceLeft(usage); });
    return () => controller.abort();
  }, [podcast, startupDone]);
  const unsaved = readAloud.prepared.ready < readAloud.prepared.total;
  // Every paragraph has PaperTok's audio: the feed marks the paper as one to hear without spending a use.
  const paperId = paper?.id;
  const voiced = Boolean(paperId) && readAloud.prepared.total > 0 && !unsaved;
  useEffect(() => {
    if (voiced && paperId) void markPaperVoiced(paperId);
  }, [voiced, paperId]);
  useEffect(() => {
    if (!scroll || !podcast) return undefined;
    scroll.toggleAttribute('inert', true);
    return () => { scroll.toggleAttribute('inert', false); };
  }, [podcast, scroll]);

  return <>
    {canListen && topbar && createPortal(
      <div className="rd-listen-corner">
        {/* The podcast's download sits by the button that opened it; it waits for every paragraph's audio. */}
        {podcast && (
          <Button
            variant="ghost"
            size="icon"
            onClick={downloadAudio}
            disabled={unsaved}
            focusableWhenDisabled
            aria-label="Download the audio"
            title={unsaved ? 'The audio cannot be saved yet: some paragraphs do not have PaperTok’s voice.' : 'Download the audio'}
          >
            <DownloadSimple size={18} aria-hidden="true" />
          </Button>
        )}
        <Toggle ref={listenButton} className="rd-listen-toggle" pressed={podcast} onPressedChange={listen} aria-label="Listen to the paper as a podcast" title={podcast ? 'Back to the text' : 'Listen as a podcast'}>
          <Headphones size={18} weight={podcast ? 'fill' : 'regular'} aria-hidden="true" />
        </Toggle>
      </div>,
      topbar,
    )}
    {/* Hidden rather than unmounted while the podcast tab covers it, so a Zotero send in flight finishes. */}
    <div hidden={podcast}><PaperDock scroll={scroll} menu={menu} contents={contents}>
      {children}
      {notes && <Toggle className="pdf-dock-toggle pdf-dock-notes" pressed={notes.open} onPressedChange={notes.onOpenChange} aria-label="Notes" aria-controls={notes.id} title={notes.open ? 'Hide notes' : 'Show notes'}>
        <NotePencil size={18} aria-hidden="true" />
        <span><span className="pdf-dock-label">Notes</span>{notes.count > 0 && <span className="pdf-dock-count">{notes.count}</span>}</span>
      </Toggle>}
      {paper && <ZoteroControl paper={paper} />}
      {originalUrl && <Button role="link" variant="ghost" size="icon" aria-label="Open in a new tab" title="Open in a new tab" render={<a href={originalUrl} target="_blank" rel="noopener noreferrer" />}><ArrowSquareOut size={18} aria-hidden="true" /></Button>}
    </PaperDock></div>
    {podcast && spoken && <ReadAloudListen
      title={paper?.title ?? title}
      queue={spoken.queue}
      player={readAloud}
      voiceLeft={voiceLeft}
      onPlayPause={playPause}
    />}
  </>;
}

function ZoteroControl({ paper }: { paper: Paper }) {
  const { user } = useAuth();
  const zotero = useZoteroAction(paper, user?.uid, true);
  if (!zotero) return null;
  const name = zotero.sent ? `${zotero.label} (${zotero.hint.charAt(0).toLowerCase()}${zotero.hint.slice(1)})` : zotero.label;
  return <Button variant="ghost" className="pdf-dock-toggle pdf-dock-zotero" onClick={zotero.onSelect}
    disabled={zotero.busy} focusableWhenDisabled aria-busy={zotero.busy || undefined}
    aria-label={name} title={name} data-sent={zotero.sent ? '' : undefined}>
    {zotero.busy ? <CircleNotch size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ZoteroMark size={18} />}
    <span className="pdf-dock-label">Zotero</span>
  </Button>;
}
