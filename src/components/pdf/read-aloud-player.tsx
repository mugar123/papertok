import type { KeyboardEvent } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowCounterClockwise, Pause, Play, X } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import type { ReadAloudTimeline } from './read-aloud.ts';
import { chapterAt } from './read-aloud.ts';
import './read-aloud-player.css';

const SKIP_SECONDS = 15;

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function spokenClock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/**
 * The read-aloud controls, drawn inside the paper viewer's dock in place of its
 * tools: the chapter being read, a track marked where each section starts,
 * and play, pause and skip. Dragging the track names the chapter it would
 * land in; letting go moves the voice there.
 */
export default function ReadAloudPlayer({ timeline, prepared, position, playing, onPlayPause, onSeek, onClose, openedFrom }: {
  timeline: ReadAloudTimeline;
  /** Passages whose audio exists; until all do, the track shows what is left to prepare. */
  prepared: { ready: number; total: number; failed: boolean };
  position: number;
  playing: boolean;
  onPlayPause: () => void;
  onSeek: (seconds: number) => void;
  onClose: () => void;
  /** The closed dock's outline, which the player grows out of. */
  openedFrom: { width: number; height: number } | null;
}) {
  const [target, setTarget] = useState<number | null>(null);
  // Where a mouse over the track points, before any press.
  const [hover, setHover] = useState<number | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const playButton = useRef<HTMLButtonElement | null>(null);
  const shown = target ?? position;
  const chapter = chapterAt(timeline, shown);

  useEffect(() => { playButton.current?.focus(); }, []);

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
  const PlayIcon = playing ? Pause : Play;
  const preparing = !prepared.failed && prepared.ready < prepared.total;
  const percent = prepared.total ? Math.floor((prepared.ready / prepared.total) * 100) : 0;
  return (
    <div
      ref={root}
      className="rd-listen"
      role="group"
      aria-label="Read aloud"
      onKeyDown={onKeyDown}
      style={openedFrom ? { width: openedFrom.width } : undefined}
    >
      <div className="rd-listen-top">
        <p className="rd-listen-chapter">
          {chapter.number && <span className="rd-listen-number">{chapter.number}</span>}
          <span className="rd-listen-title">{chapter.title}</span>
        </p>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close player" title="Close player">
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
      <div className="rd-listen-controls">
        <span className="rd-listen-time">{clock(shown)}</span>
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
        <span className="rd-listen-time rd-listen-left">
          {preparing ? `Preparing ${percent}%` : `−${clock(timeline.duration - shown)}`}
        </span>
      </div>
    </div>
  );
}
