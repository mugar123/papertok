import type { ComponentProps, ReactNode } from 'react';
import type { Paper } from '../../models/paper.ts';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
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
import UsesCount from '../reader/uses-count.tsx';
import '../ui/tag.css';

const NO_PASSAGES: SpokenPassage[] = [];
const NO_CHAPTERS: ReadAloudChapter[] = [];

type ReadingDockProps = Pick<ComponentProps<typeof PaperDock>, 'scroll' | 'contents' | 'menu'> & {
  title: string;
  paper?: Paper;
  spoken: { queue: SpokenPassage[]; chapters: ReadAloudChapter[] } | null;
  canListen: boolean;
  /** Whether the viewer's Listen tab is chosen: the podcast covers the text. */
  listening?: boolean;
  /** The top bar of the viewer around the text, where the podcast's download goes. */
  topbar?: HTMLElement | null;
  notes: { id: string; open: boolean; count: number; onOpenChange: (open: boolean) => void } | null;
  originalUrl: string;
  children?: ReactNode;
};

export function ReadingDock({ title, paper, scroll, contents, menu, spoken, canListen, listening = false, topbar = null, notes, originalUrl, children }: ReadingDockProps) {
  const { readingPreferences, user } = useAuth();
  // How many new papers the account may still hear in PaperTok's voice today, read again when a
  // paragraph is refused for them; kept with the account it was read for.
  const [voiceRead, setVoiceRead] = useState(0);
  const [voiceUsage, setVoiceUsage] = useState<{ uid: string; usage: Awaited<ReturnType<typeof fetchVoiceUsage>> } | null>(null);
  const voiceLeft = voiceUsage && voiceUsage.uid === user?.uid ? voiceUsage.usage : null;
  const { trackEvent } = useAnalyticsConsent();
  const readAloud = useReadAloud(spoken?.queue ?? NO_PASSAGES, spoken?.chapters ?? NO_CHAPTERS, {
    title,
    paperId: paper?.id,
    onFallback: (cause) => {
      const code = cause instanceof ReadAloudError ? cause.code : '';
      if (code === 'AI_QUOTA_EXHAUSTED' && (cause as ReadAloudError).scope === 'user') {
        setVoiceRead(read => read + 1);
        toast('You have used today’s papers with PaperTok’s voice, so this browser’s voice reads the parts without it. More tomorrow.');
      } else if (code === 'AI_QUOTA_EXHAUSTED' || code === 'AI_AUDIO_NOT_STORED') {
        toast('Parts of this paper have no PaperTok audio yet, so this browser’s voice reads them.');
      } else {
        toast('PaperTok’s voice is not available right now, so this browser’s voice reads instead.');
      }
    },
    onError: () => toast.error('Reading aloud stopped. This browser could not play the voice.'),
    onBlocked: () => toast('The audio is ready. Press play to listen.'),
  });
  const { paragraph: speaking, reset: resetReadAloud } = readAloud;
  useEffect(() => () => resetReadAloud(), [spoken, canListen, resetReadAloud]);
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

  // The viewer's Listen tab. Opening it prepares the first passages, and playback starts with the
  // player's Play button; leaving it stops the voice. The text under it is left out of the
  // keyboard's way while the tab covers it.
  const podcast = listening && canListen;
  const listen = useEffectEvent((open: boolean) => {
    if (open && speaking === null) {
      void trackEvent('read_aloud_start', { surface: 'reader' });
      readAloud.prepare(startAt());
    }
    if (!open) readAloud.pause();
  });
  const opened = useRef(false);
  useEffect(() => {
    if (podcast === opened.current) return;
    opened.current = podcast;
    listen(podcast);
  }, [podcast]);
  // Read once the first passages are ready, so the count already holds this paper.
  const startupDone = readAloud.startup.failed || readAloud.startup.ready >= readAloud.startup.total;
  const uid = user?.uid;
  useEffect(() => {
    if (!podcast || !startupDone || !uid) return undefined;
    const controller = new AbortController();
    void fetchVoiceUsage({ signal: controller.signal }).then((usage) => { if (!controller.signal.aborted) setVoiceUsage({ uid, usage }); });
    return () => controller.abort();
  }, [podcast, startupDone, uid, voiceRead]);
  const unsaved = readAloud.prepared.ready < readAloud.prepared.total;
  // Every passage has stored audio: the Worker checks it and the feed shows the paper as voiced.
  const paperId = paper?.id;
  const voiced = Boolean(paperId) && readAloud.prepared.total > 0 && !unsaved;
  const { audioKeys } = readAloud;
  useEffect(() => {
    const audio = voiced && paperId ? audioKeys() : null;
    if (audio && paperId) void markPaperVoiced(paperId, audio);
  }, [voiced, paperId, audioKeys]);
  useEffect(() => {
    if (!scroll || !podcast) return undefined;
    scroll.toggleAttribute('inert', true);
    return () => { scroll.toggleAttribute('inert', false); };
  }, [podcast, scroll]);

  return <>
    {podcast && topbar && createPortal(
      <div className="rd-listen-corner">
        {/* The day's new papers with PaperTok's voice, as the reader shows its AI uses, then the
            podcast's download, in the bar's corner while the Listen tab is open; the download waits
            for every paragraph's audio. */}
        {voiceLeft && (
          <span className="rd-tag rd-tag--ai rd-uses" role="status">
            <Headphones size={12} aria-hidden="true" />
            <UsesCount left={voiceLeft.papersLeft} limit={voiceLeft.dailyPapers} what="new papers with PaperTok’s voice" />
          </span>
        )}
        {(
          <Button
            variant="ghost"
            size="icon"
            onClick={downloadAudio}
            disabled={unsaved}
            focusableWhenDisabled
            aria-label="Download the audio"
            title={unsaved ? `${readAloud.prepared.ready} of ${readAloud.prepared.total} parts ready. The download needs PaperTok’s voice for all of them.` : 'Download the audio'}
          >
            <DownloadSimple size={18} aria-hidden="true" />
          </Button>
        )}
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
