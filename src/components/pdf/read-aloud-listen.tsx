import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Headphones, ListBullets, X } from '@phosphor-icons/react';
import UsesCount from '../reader/uses-count.tsx';
import '../ui/tag.css';
import { Button } from '../ui/button.tsx';
import type { SpokenPassage } from './read-aloud.ts';
import type { useReadAloud } from './use-read-aloud.ts';
import { chapterAt, clock, passageText, spokenWordAt, wordSpans, wordStarts } from './read-aloud.ts';
import { ReadAloudTrack, ReadAloudTransport, SpeedButton } from './read-aloud-controls.tsx';
import ReadAloudForms from './read-aloud-forms.tsx';
import './read-aloud-listen.css';

/** Where the chapters panel covers the tab (the stylesheet's own phone breakpoint, read-aloud-listen.css). */
const PHONE = '(max-width: 600px)';

/** What the tab says, and tells a screen reader, while the first passages' audio is fetched. */
const PREPARING = 'Preparing the first passages';

/** About three lines of the caption on a wide screen and five on a phone; a longer sentence is shown a piece at a time, as lyrics are. */
const CAPTION_WORDS = 20;

/** The piece of a sentence's words that holds the one being said, the pieces as even as they can be. */
function captionPiece(words: string[], current: number) {
  const size = Math.ceil(words.length / Math.ceil(words.length / CAPTION_WORDS));
  const start = Math.floor(Math.max(0, current) / size) * size;
  return { words: words.slice(start, start + size), current: current - start, first: start };
}

/** The sentence the voice is on, cut into words (only the piece being read, if it is long), and which of them it is saying. */
function spokenSentence(item: SpokenPassage, word: number) {
  const text = passageText(item);
  const at = wordSpans(text)[word]?.[0] ?? 0;
  let start = 0;
  for (const line of item.utterances) {
    if (at < start + line.length + 1) {
      const before = text.slice(0, start).split(/\s+/).filter(Boolean).length;
      const piece = captionPiece(line.split(/\s+/).filter(Boolean), word - before);
      // Where the piece starts in the passage, so each new piece is a new element and enters as one.
      return { ...piece, first: before + piece.first };
    }
    start += line.length + 1;
  }
  return null;
}

/**
 * The paper as a podcast, in a tab of the viewer beside its text, always on night paper:
 * a cloud of particles flowing between scientific forms, the sentence being read as a large caption, one row of
 * controls round the timeline (which shows the audio still to come, then where the voice
 * is), and the paper's sections as chapters in a drawer.
 */
export default function ReadAloudListen({ title, queue, player, voiceLeft = null, onPlayPause }: {
  title: string;
  queue: readonly SpokenPassage[];
  /** The voice the dock plays: where it is, how much is ready, and its controls. */
  player: Pick<ReturnType<typeof useReadAloud>, 'timeline' | 'startup' | 'buffering' | 'paragraph' | 'position' | 'playing' | 'speed' | 'timings' | 'live' | 'setSpeed' | 'seek'>;
  /** New papers the account may still hear in PaperTok's voice today, when known. */
  voiceLeft?: { papersLeft: number; dailyPapers: number } | null;
  onPlayPause: () => void;
}) {
  const { timeline, startup, buffering, paragraph, position, playing, speed, timings, live, setSpeed: onSpeed, seek: onSeek } = player;
  const preparing = !startup.failed && startup.ready < startup.total;
  const percent = startup.total ? Math.floor((startup.ready / startup.total) * 100) : 100;
  // What the wait is for: the chapters and, at the chosen speed, about how long they last (left out when unknown).
  const chapterCount = timeline.chapters.length;
  const minutes = Math.round(timeline.duration / speed / 60);
  // Where a drag along the line would move the voice, until it is let go.
  const [target, setTarget] = useState<number | null>(null);
  // The player's position moves when a clip reports its time, and with the browser's voice only
  // as each sentence ends; while it speaks, the tab reads where the voice is on every frame.
  const [voiceAt, setVoiceAt] = useState<number | null>(null);
  const now = playing && voiceAt !== null ? voiceAt : position;
  const shown = target ?? now;
  const chapter = chapterAt(timeline, shown);
  // The player's state, told to a screen reader as it changes: the section only when the voice
  // reaches a new one, never each word or percent. The region is mounted empty and filled after,
  // as a region that arrives holding its words is not reliably spoken.
  const reading = chapterAt(timeline, now);
  const status = preparing ? PREPARING : buffering ? 'Loading this passage' : playing ? `Reading ${[reading.number, reading.title].filter(Boolean).join(' ')}` : 'Paused';
  const statusRegion = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (statusRegion.current) statusRegion.current.textContent = status;
  }, [status]);
  // The chapter the voice was in before, so the rail can run from there to the one it is in now.
  const current = timeline.chapters.findIndex(part => part.start === chapter.start);
  const [rail, setRail] = useState({ at: current, from: current });
  if (rail.at !== current) setRail({ at: current, from: rail.at });
  // The caption's box follows the sentence's height with a transition (read-aloud-listen.css), so a
  // longer or shorter sentence eases the forms and the controls to their place instead of jumping.
  const caption = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = caption.current;
    const text = box?.firstElementChild;
    if (!box || !text) return undefined;
    const observer = new ResizeObserver(() => { box.style.height = `${(text as HTMLElement).offsetHeight}px`; });
    observer.observe(text);
    return () => observer.disconnect();
  }, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Whether the open panel covers the tab, as it does on a phone: then the player behind it is out of reach.
  const [drawerCovers, setDrawerCovers] = useState(false);
  const drawerButton = useRef<HTMLButtonElement | null>(null);
  const drawer = useRef<HTMLElement | null>(null);
  // Open, the panel takes the focus to the chapter being read; closed, it gives it back to its button.
  // The focus goes back once the panel has closed, when the player behind it is no longer inert.
  const returnFocus = useRef(false);
  const closeDrawer = () => {
    returnFocus.current = true;
    setDrawerOpen(false);
  };
  useEffect(() => {
    if (!drawerOpen) {
      if (returnFocus.current) drawerButton.current?.focus();
      returnFocus.current = false;
      return;
    }
    const panel = drawer.current;
    (panel?.querySelector<HTMLElement>('button[aria-current]') ?? panel?.querySelector<HTMLElement>('ol button'))?.focus({ preventScroll: true });
    panel?.querySelector('button[aria-current]')?.scrollIntoView({ block: 'center' });
  }, [drawerOpen]);
  const drawerId = useId();

  const item = paragraph === null ? null : queue[paragraph] ?? null;
  const starts = useMemo(() => {
    if (!item) return null;
    const text = passageText(item);
    return wordStarts(text, timings[text] ?? null);
  }, [item, timings]);
  const [word, setWord] = useState(0);
  const span = paragraph === null ? null : timeline.passages[paragraph] ?? null;
  useEffect(() => {
    if (!item) return undefined;
    const text = passageText(item);
    let frame = 0;
    const tick = () => {
      const voice = live();
      setWord(spokenWordAt(text, starts, voice));
      // A tenth of a second is finer than the clock shows and coarse enough not to render every frame.
      if (span) setVoiceAt(Math.round((span.start + voice.fraction * (span.end - span.start)) * 10) / 10);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [item, live, span, starts]);
  const sentence = item ? spokenSentence(item, word) : null;

  return (
    <section className="rd-podcast" aria-labelledby="rd-podcast-paper" data-chapters-open={drawerOpen || undefined} data-preparing={preparing || undefined}>
      {/* The paper heads the tab, as a player names the album over its cover. */}
      <span ref={statusRegion} className="visually-hidden" role="status" />
      <header className="rd-podcast-header">
        <p id="rd-podcast-paper" className="rd-podcast-header-title">{title}</p>
        {voiceLeft && (
          <p className="rd-podcast-header-voice">
            <span className="rd-tag rd-tag--ai rd-uses" role="status">
              <Headphones size={12} aria-hidden="true" />
              <UsesCount left={voiceLeft.papersLeft} limit={voiceLeft.dailyPapers} what="new papers with PaperTok’s voice" />
            </span>
          </p>
        )}
      </header>
      <div className="rd-podcast-cover">
        <ReadAloudForms progress={preparing ? startup.ready / startup.total : 1} playing={playing && !buffering} />
        {/* While the first passages are prepared, a ring round the forms fills with them. */}
        {preparing && (
          <svg className="rd-podcast-ring" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="49" pathLength={100} />
            <circle cx="50" cy="50" r="49" pathLength={100} strokeDasharray="100" strokeDashoffset={100 - percent} />
          </svg>
        )}
      </div>

      <div className="rd-podcast-words">
        {/* The section the voice is in: small over the caption on a wide screen, the large title on a phone, as a player names a song. */}
        {!preparing && (
          <h2 className="rd-podcast-title">
            <span key={chapter.start} className="rd-podcast-section">{[chapter.number, chapter.title].filter(Boolean).join(' ')}</span>
          </h2>
        )}

        {preparing && (
          <div className="rd-podcast-wait">
            <p className="rd-podcast-wait-what">{PREPARING}</p>
            <p className="rd-podcast-wait-meta">{[`${percent}%`, chapterCount > 1 && `${chapterCount} chapters`, minutes > 0 && `about ${minutes} min`].filter(Boolean).join(' · ')}</p>
          </div>
        )}
        <div ref={caption} className="rd-podcast-caption" hidden={preparing}>
          <p className="rd-podcast-text" lang="en">
            {buffering ? 'Loading this passage…'
              : !sentence ? 'Press play to listen.' : (
                <span key={`${paragraph}:${sentence.first}`} className="rd-podcast-piece">
                  {sentence.words.map((text, index) => (
                    <span key={index} data-said={index < sentence.current || undefined} data-current={index === sentence.current || undefined}>{text} </span>
                  ))}
                </span>
              )}
          </p>
        </div>
      </div>

      {/* The controls: under the caption on a wide screen; on a phone, a bar fixed to the bottom of the
          tab, ruled off from the forms and the caption, which scroll behind it. */}
      {!preparing && (
        <div className="rd-podcast-player" inert={drawerOpen && drawerCovers}>
          <div className="rd-podcast-dock">
            {/* As a music player lays them out: the transport centred, the speed and the chapters at its sides. */}
            <div className="rd-podcast-buttons">
              <SpeedButton speed={speed} onSpeed={onSpeed} />
              <ReadAloudTransport position={now} playing={playing} speed={speed} onPlayPause={onPlayPause} onSeek={onSeek} />
              {timeline.chapters.length > 1 ? (
                <Button ref={drawerButton} variant="ghost" size="icon" aria-label="All chapters" title="All chapters" aria-expanded={drawerOpen} aria-controls={drawerId} onClick={() => {
                  setDrawerCovers(window.matchMedia(PHONE).matches);
                  setDrawerOpen(open => !open);
                }}>
                  <ListBullets size={20} aria-hidden="true" />
                </Button>
              ) : <span />}
            </div>
            {/* and under it the line, its minute at one end and what is left at the other. */}
            <div className="rd-podcast-line">
              <span className="rd-listen-time">{clock(shown / speed)}</span>
              <ReadAloudTrack timeline={timeline} position={now} speed={speed} target={target} onTarget={setTarget} onSeek={onSeek} />
              <span className="rd-listen-time rd-listen-left">−{clock((timeline.duration - shown) / speed)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Every chapter at once, with its length, in a drawer from the side. */}
      {timeline.chapters.length > 1 && (
        <nav
          ref={drawer}
          id={drawerId}
          className="rd-podcast-drawer"
          aria-label="All chapters"
          data-open={drawerOpen || undefined}
          inert={!drawerOpen}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            closeDrawer();
          }}
        >
          <div className="rd-podcast-drawer-head">
            <p className="rd-podcast-drawer-heading" aria-hidden="true">Chapters</p>
            <Button variant="ghost" size="icon" className="rd-podcast-drawer-close" aria-label="Close chapters" title="Close" onClick={closeDrawer}>
              <X size={16} aria-hidden="true" />
            </Button>
          </div>
          {/* The whole run takes 240ms however many rows it crosses. */}
          <ol style={{ '--from': rail.from, '--rail-step': 240 / Math.max(1, Math.abs(rail.at - rail.from)) }}>
            {timeline.chapters.map((part, index) => (
              <li key={part.start} style={{ '--row': index }}>
                <button
                  type="button"
                  disabled={preparing}
                  aria-current={(!preparing && part.start === chapter.start) || undefined}
                  data-played={(!preparing && part.start < chapter.start) || undefined}
                  data-section={(Boolean(part.number) && !part.number.includes('.')) || undefined}
                  onClick={() => {
                    onSeek(part.start);
                    // Beside the tab the panel stays open to pick again; full screen on a phone it gives way to the player.
                    if (window.matchMedia(PHONE).matches) closeDrawer();
                  }}
                  aria-label={`${[part.number, part.title].filter(Boolean).join(' ')}, from ${clock(part.start / speed)}`}
                >
                  <span className="rd-podcast-drawer-time">{clock(part.start / speed)}</span>
                  <span className="rd-podcast-drawer-dot" aria-hidden="true" />
                  {/* "Appendix A" is shown as "A", so a long label stays short beside its title. */}
                  <span className="rd-podcast-drawer-title">
                    {part.number && <span className="rd-podcast-drawer-number">{part.number.split(/\s+/).pop()}</span>}
                    {part.title}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </section>
  );
}
