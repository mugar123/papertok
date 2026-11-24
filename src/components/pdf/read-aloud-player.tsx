import type { KeyboardEvent, Ref } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowCounterClockwise, ArrowsOut, DownloadSimple, Pause, Play, X } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import type { ReadAloudTimeline } from './read-aloud.ts';
import { chapterAt, clock } from './read-aloud.ts';
import { READ_ALOUD_SPEEDS } from './use-read-aloud.ts';
import './read-aloud-player.css';

const SKIP_SECONDS = 15;


function spokenClock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/** Back and forward 15 seconds around play and pause, in the dock's player and the listening view. */
export function ReadAloudTransport({ position, playing, onPlayPause, onSeek, playButton }: {
  position: number;
  playing: boolean;
  onPlayPause: () => void;
  onSeek: (seconds: number) => void;
  playButton?: Ref<HTMLButtonElement>;
}) {
  const PlayIcon = playing ? Pause : Play;
  return (
    <div className="rd-listen-transport">
      <Button variant="ghost" size="icon" className="rd-listen-skip" onClick={() => onSeek(position - SKIP_SECONDS)} aria-label={`Back ${SKIP_SECONDS} seconds`} title={`Back ${SKIP_SECONDS} seconds`}>
        <ArrowCounterClockwise size={30} weight="light" aria-hidden="true" />
        <span aria-hidden="true">{SKIP_SECONDS}</span>
      </Button>
      <Button ref={playButton} variant="ghost" size="icon" onClick={onPlayPause} aria-label={playing ? 'Pause' : 'Play'}>
        <PlayIcon size={18} weight="fill" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" className="rd-listen-skip" onClick={() => onSeek(position + SKIP_SECONDS)} aria-label={`Forward ${SKIP_SECONDS} seconds`} title={`Forward ${SKIP_SECONDS} seconds`}>
        <ArrowClockwise size={30} weight="light" aria-hidden="true" />
        <span aria-hidden="true">{SKIP_SECONDS}</span>
      </Button>
    </div>
  );
}

/** Steps through the speeds the voice offers, and back to the slowest after the fastest. */
export function SpeedButton({ speed, onSpeed }: { speed: number; onSpeed: (speed: number) => void }) {
  const next = READ_ALOUD_SPEEDS[(READ_ALOUD_SPEEDS.indexOf(speed as typeof READ_ALOUD_SPEEDS[number]) + 1) % READ_ALOUD_SPEEDS.length];
  return (
    <Button variant="ghost" size="sm" className="rd-listen-speed" onClick={() => onSpeed(next)} aria-label={`Speed ${speed}×`} title="Change the speed">
      {speed}×
    </Button>
  );
}

/**
 * The read-aloud controls, drawn inside the paper viewer's dock in place of its
 * tools: the chapter being read, a track marked where each section starts,
 * and play, pause and skip. Dragging the track names the chapter it would
 * land in; letting go moves the voice there.
 */
export default function ReadAloudPlayer({ timeline, prepared, position, playing, speed, onSpeed, onPlayPause, onSeek, onClose, onDownload, onExpand, openedFrom }: {
  timeline: ReadAloudTimeline;
  /** Passages whose audio exists; until all do, the track shows what is left to prepare. */
  prepared: { ready: number; total: number; failed: boolean };
  position: number;
  playing: boolean;
  speed: number;
  onSpeed: (speed: number) => void;
  onPlayPause: () => void;
  onSeek: (seconds: number) => void;
  onClose: () => void;
  /** Saves the paper's audio; offered once every passage has PaperTok's voice. */
  onDownload: () => void;
  /** Opens the listening view over the whole paper. */
  onExpand: () => void;
  /** The closed dock's outline, which the player grows out of. */
  openedFrom: { width: number; height: number } | null;
}) {
  const [target, setTarget] = useState<number | null>(null);
  // Where a mouse over the track points, before any press.
  const [hover, setHover] = useState<number | null>(null);
  // The voice starts once the paper's audio is all there; until then the player shows only how much is.
  const preparing = !prepared.failed && prepared.ready < prepared.total;
  const root = useRef<HTMLDivElement | null>(null);
  const playButton = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const shown = target ?? position;
  const chapter = chapterAt(timeline, shown);

  useEffect(() => { (playButton.current ?? closeButton.current)?.focus(); }, []);

  useLayoutEffect(() => {
    const bar = root.current?.closest<HTMLElement>('.pdf-dock');
    if (!bar || !openedFrom) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      bar.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'linear' });
      return;
    }
    const { width, height } = bar.getBoundingClientRect();
    const radius = getComputedStyle(bar).borderTopLeftRadius;
    const top = Math.max(0, height - openedFrom.height);
    const side = Math.max(0, (width - openedFrom.width) / 2);
    bar.animate(
      [{ clipPath: `inset(${top}px ${side}px 0 round ${radius})` }, { clipPath: `inset(0 round ${radius})` }],
      { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  }, [openedFrom]);

  /** The moment under a pointer, over the full width of the line as drawn. */
  const pointAt = (event: { clientX: number; currentTarget: Element }) => {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - left) / width)) * timeline.duration;
  };

  const commit = () => {
    if (target === null) return;
    onSeek(target);
    setTarget(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const pointed = target ?? hover;
  const pointedChapter = pointed === null ? null : chapterAt(timeline, pointed);
  const percent = prepared.total ? Math.floor((prepared.ready / prepared.total) * 100) : 0;
  // Why the audio cannot be saved yet, or at all once some paragraphs will not get PaperTok's voice.
  const downloadNoteId = useId();
  const unsaved = prepared.ready < prepared.total;
  const downloadNote = prepared.failed
    ? 'The audio cannot be saved: some paragraphs do not have PaperTok’s voice.'
    : 'Available once every paragraph has PaperTok’s voice.';
  return (
    <div
      ref={root}
      className="rd-listen"
      role="group"
      aria-label="Voice"
      onKeyDown={onKeyDown}
    >
      <div className="rd-listen-top">
        <p className="rd-listen-chapter">
          {chapter.number && <span className="rd-listen-number">{chapter.number}</span>}
          <span className="rd-listen-title">{chapter.title}</span>
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDownload}
          disabled={unsaved}
          focusableWhenDisabled
          aria-label="Download the audio"
          aria-describedby={unsaved ? downloadNoteId : undefined}
          title={unsaved ? downloadNote : 'Download the audio'}
        >
          <DownloadSimple size={16} aria-hidden="true" />
        </Button>
        {unsaved && <span id={downloadNoteId} className="visually-hidden">{downloadNote}</span>}
        {!preparing && <SpeedButton speed={speed} onSpeed={onSpeed} />}
        <Button variant="ghost" size="icon-sm" onClick={onExpand} aria-label="Open the listening view" title="Open the listening view">
          <ArrowsOut size={16} aria-hidden="true" />
        </Button>
        <Button ref={closeButton} variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close player" title="Close player">
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      {preparing ? (
        <div className="rd-listen-track">
          <progress className="rd-listen-progress" max={prepared.total} value={prepared.ready} aria-label="Preparing the paper's audio" />
        </div>
      ) : (
      <div
        className="rd-listen-track"
        data-dragging={target !== null || undefined}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setTarget(pointAt(event));
        }}
        onPointerMove={(event) => {
          const at = pointAt(event);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) setTarget(at);
          // Kept up to date during a drag too, or letting go shows where the mouse was before the press.
          setHover(event.pointerType === 'mouse' ? at : null);
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const at = pointAt(event);
          onSeek(at);
          setTarget(null);
          setHover(event.pointerType === 'mouse' ? at : null);
        }}
        onPointerCancel={() => {
          setTarget(null);
          setHover(null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div className="rd-listen-line" aria-hidden="true">
          <span className="rd-listen-fill" style={{ width: `${timeline.duration ? (shown / timeline.duration) * 100 : 0}%` }} />
          {timeline.chapters.slice(1).map(part => (
            <span key={part.start} className="rd-listen-mark" data-played={part.start <= shown || undefined} style={{ left: `${(part.start / timeline.duration) * 100}%` }} />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={Math.round(timeline.duration)}
          step={1}
          value={Math.round(shown)}
          aria-label="Position in the paper"
          aria-valuetext={`${spokenClock(shown)}, ${[chapter.number, chapter.title].filter(Boolean).join(' ')}`}
          onChange={event => setTarget(Number(event.target.value))}
          onBlur={commit}
          onKeyUp={(event) => { if (event.key !== 'Escape') commit(); }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || target === null) return;
            event.stopPropagation();
            setTarget(null);
          }}
        />
        {pointed !== null && pointedChapter && (
          <span className="rd-listen-tip" aria-hidden="true" style={{ '--at': `${timeline.duration ? (pointed / timeline.duration) * 100 : 0}%` }}>
            {clock(pointed)}
            {pointedChapter.number && <span>{pointedChapter.number}</span>}
          </span>
        )}
      </div>
      )}
      {preparing ? (
        <p className="rd-listen-preparing">Preparing the audio, {percent}%</p>
      ) : (
      <div className="rd-listen-controls">
        <span className="rd-listen-time">{clock(shown)}</span>
        <ReadAloudTransport position={position} playing={playing} onPlayPause={onPlayPause} onSeek={onSeek} playButton={playButton} />
        <span className="rd-listen-time rd-listen-left">−{clock((timeline.duration - shown) / speed)}</span>
      </div>
      )}
    </div>
  );
}
