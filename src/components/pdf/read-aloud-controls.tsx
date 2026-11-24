import type { Ref } from 'react';
import { useState } from 'react';
import { ArrowClockwise, ArrowCounterClockwise, Pause, Play } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import type { ReadAloudTimeline } from './read-aloud.ts';
import { chapterAt, clock, spokenClock } from './read-aloud.ts';
import { READ_ALOUD_SPEEDS } from './use-read-aloud.ts';
import './read-aloud-controls.css';

const SKIP_SECONDS = 15;
/** The space after each of the timeline's blocks. */
const BLOCK_GAP_PX = 4;

/** Back and forward 15 seconds of listening around play and pause: at 2× that is 30 of the paper's. */
export function ReadAloudTransport({ position, playing, speed, onPlayPause, onSeek, playButton }: {
  position: number;
  playing: boolean;
  speed: number;
  onPlayPause: () => void;
  onSeek: (seconds: number) => void;
  playButton?: Ref<HTMLButtonElement>;
}) {
  const PlayIcon = playing ? Pause : Play;
  return (
    <div className="rd-listen-transport">
      <Button variant="ghost" size="icon" className="rd-listen-skip" onClick={() => onSeek(position - SKIP_SECONDS * speed)} aria-label={`Back ${SKIP_SECONDS} seconds`} title={`Back ${SKIP_SECONDS} seconds`}>
        <ArrowCounterClockwise size={30} weight="light" aria-hidden="true" />
        <span aria-hidden="true">{SKIP_SECONDS}</span>
      </Button>
      <Button ref={playButton} variant="ghost" size="icon" className="rd-listen-play" onClick={onPlayPause} aria-label={playing ? 'Pause' : 'Play'}>
        <PlayIcon size={18} weight="fill" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" className="rd-listen-skip" onClick={() => onSeek(position + SKIP_SECONDS * speed)} aria-label={`Forward ${SKIP_SECONDS} seconds`} title={`Forward ${SKIP_SECONDS} seconds`}>
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

/** A section shorter than this share of the paper joins the block before it, as a video's short chapters do. */
const MIN_BLOCK_SHARE = 0.015;

/**
 * The paper's top-level sections, each running until the next one starts: the timeline's
 * blocks, so a paper with many short subsections, appendices or notes is not cut into slivers.
 */
function sections(timeline: ReadAloudTimeline) {
  const tops = timeline.chapters.filter(part => !part.number.includes('.'));
  const spans = (tops.length > 0 ? tops : timeline.chapters)
    .map((part, index, all) => ({ ...part, start: index === 0 ? 0 : part.start, end: all[index + 1]?.start ?? timeline.duration }));
  const blocks: typeof spans = [];
  for (const span of spans) {
    const last = blocks[blocks.length - 1];
    if (last && (span.end - span.start) / timeline.duration < MIN_BLOCK_SHARE) last.end = span.end;
    else blocks.push(span);
  }
  return blocks;
}

/**
 * The line through the paper, cut into one block per top-level section as a video's chapters are:
 * showing where the voice is. The segment under
 * the pointer grows, the tip names its minute and section, and letting go moves the voice
 * there; a range input on top carries it for the keyboard.
 */
export function ReadAloudTrack({ timeline, position, speed, target, onTarget, onSeek }: {
  timeline: ReadAloudTimeline;
  position: number;
  /** Times are told in listening time, the paper's divided by the speed. */
  speed: number;
  target: number | null;
  onTarget: (seconds: number | null) => void;
  onSeek: (seconds: number) => void;
}) {
  // Where a mouse over the track points, before any press.
  const [hover, setHover] = useState<number | null>(null);
  const shown = target ?? position;
  const chapter = chapterAt(timeline, shown);
  /** The moment under a pointer, over the full width of the line as drawn. */
  const pointAt = (event: { clientX: number; currentTarget: Element }) => {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - left) / width)) * timeline.duration;
  };
  const commit = () => {
    if (target === null) return;
    onSeek(target);
    onTarget(null);
  };
  const pointed = target ?? hover;
  const pointedChapter = pointed === null ? null : chapterAt(timeline, pointed);
  const share = (seconds: number) => (timeline.duration ? (seconds / timeline.duration) * 100 : 0);
  const blocks = sections(timeline);
  const pointedBlock = pointed === null ? null : blocks.find(part => pointed < part.end) ?? blocks[blocks.length - 1];
  // A subsection is named after its section, which is the block it falls in.
  const tipText = !pointedChapter ? '' : !pointedBlock || pointedBlock.start === pointedChapter.start
    ? pointedChapter.title
    : `${pointedBlock.title} · ${[pointedChapter.number, pointedChapter.title].filter(Boolean).join(' ')}`;
  return (
    <div
      className="rd-listen-track"
      data-dragging={target !== null || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onTarget(pointAt(event));
      }}
      onPointerMove={(event) => {
        const at = pointAt(event);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onTarget(at);
        // Kept up to date during a drag too, or letting go shows where the mouse was before the press.
        setHover(event.pointerType === 'mouse' ? at : null);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const at = pointAt(event);
        onSeek(at);
        onTarget(null);
        setHover(event.pointerType === 'mouse' ? at : null);
      }}
      onPointerCancel={() => {
        onTarget(null);
        setHover(null);
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="rd-listen-line" aria-hidden="true">
        {blocks.map(part => (
          <span
            key={part.start}
            className="rd-listen-part"
            data-pointed={pointedBlock === part || undefined}
            // Placed by time, not laid out with gaps, so the block under the pointer is the minute it names.
            style={{ left: `${share(part.start)}%`, width: `calc(${share(part.end - part.start)}% - ${BLOCK_GAP_PX}px)` }}
          >
            <span className="rd-listen-part-fill" style={{ width: `${Math.min(100, Math.max(0, ((shown - part.start) / Math.max(1e-6, part.end - part.start)) * 100))}%` }} />
          </span>
        ))}
        <span className="rd-listen-thumb" style={{ left: `${share(shown)}%` }} />
      </div>
      <input
        type="range"
        min={0}
        max={Math.round(timeline.duration)}
        step={1}
        value={Math.round(shown)}
        aria-label="Position in the paper"
        aria-valuetext={`${spokenClock(shown / speed)}, ${[chapter.number, chapter.title].filter(Boolean).join(' ')}`}
        onChange={event => onTarget(Number(event.target.value))}
        onBlur={commit}
        onKeyUp={(event) => { if (event.key !== 'Escape') commit(); }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || target === null) return;
          event.stopPropagation();
          onTarget(null);
        }}
      />
      {pointed !== null && pointedChapter && (
        <span className="rd-listen-tip" aria-hidden="true" style={{ '--at': `${share(pointed)}%` }}>
          {clock(pointed / speed)}
          <span>{tipText}</span>
        </span>
      )}
    </div>
  );
}
