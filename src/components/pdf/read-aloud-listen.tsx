import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog.tsx';
import type { CharacterTimings, ReadAloudTimeline, SpokenPassage } from './read-aloud.ts';
import { chapterAt, clock, passageText, spokenWordAt, wordSpans, wordStarts } from './read-aloud.ts';
import { ReadAloudTransport, SpeedButton } from './read-aloud-player.tsx';
import './read-aloud-listen.css';

/** The sentence the voice is on, cut into words, and which of them it is saying. */
function spokenSentence(item: SpokenPassage, word: number) {
  const text = passageText(item);
  const at = wordSpans(text)[word]?.[0] ?? 0;
  let start = 0;
  for (const line of item.utterances) {
    if (at < start + line.length + 1) {
      const before = text.slice(0, start).split(/\s+/).filter(Boolean).length;
      return { words: line.split(/\s+/).filter(Boolean), current: word - before };
    }
    start += line.length + 1;
  }
  return null;
}

/**
 * The paper as a listen: a sphere that breathes while the voice speaks, ringed
 * by how much of the audio has arrived and then by how far the voice has got,
 * with each section a mark on the ring to jump to. The sentence being read sits
 * under it, its word marked.
 */
export default function ReadAloudListen({ open, onOpenChange, title, queue, timeline, prepared, paragraph, position, playing, speed, timings, live, onSpeed, onPlayPause, onSeek }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  queue: readonly SpokenPassage[];
  timeline: ReadAloudTimeline;
  prepared: { ready: number; total: number; failed: boolean };
  paragraph: number | null;
  position: number;
  playing: boolean;
  speed: number;
  timings: Record<string, CharacterTimings>;
  live: () => { seconds: number | null; fraction: number };
  onSpeed: (speed: number) => void;
  onPlayPause: () => void;
  onSeek: (seconds: number) => void;
}) {
  const preparing = !prepared.failed && prepared.ready < prepared.total;
  const progress = preparing
    ? (prepared.total ? prepared.ready / prepared.total : 0)
    : (timeline.duration ? Math.min(1, position / timeline.duration) : 0);
  const chapter = chapterAt(timeline, position);

  const item = paragraph === null ? null : queue[paragraph] ?? null;
  const starts = useMemo(() => {
    if (!item) return null;
    const text = passageText(item);
    return wordStarts(text, timings[text] ?? null);
  }, [item, timings]);
  const [word, setWord] = useState(0);
  useEffect(() => {
    if (!open || !item) return undefined;
    const text = passageText(item);
    let frame = 0;
    const tick = () => {
      setWord(spokenWordAt(text, starts, live()));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [item, live, open, starts]);
  const sentence = item ? spokenSentence(item, word) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="rd-podcast left-0 top-0 h-dvh max-w-none translate-x-0 translate-y-0 rounded-none border-0"
        closeLabel="Close the listening view"
      >
        <DialogTitle className="rd-podcast-title">{title}</DialogTitle>
        <p className="rd-podcast-chapter">
          {chapter.number && <span>{chapter.number}</span>}
          {chapter.title}
        </p>
        <div className="rd-podcast-stage">
          <svg className="rd-podcast-ring" viewBox="0 0 200 200" aria-hidden="true">
            <circle className="rd-podcast-track" cx="100" cy="100" r="94" />
            <circle className="rd-podcast-fill" data-preparing={preparing || undefined} cx="100" cy="100" r="94" pathLength={1} strokeDasharray={`${progress} 1`} />
          </svg>
          <div className="rd-podcast-orb" data-playing={(playing && !preparing) || undefined} aria-hidden="true" />
          {!preparing && timeline.duration > 0 && timeline.chapters.map((part) => {
            const turn = part.start / timeline.duration;
            return (
              <button
                key={part.start}
                type="button"
                className="rd-podcast-mark"
                data-played={part.start <= position || undefined}
                style={{ '--turn': turn }}
                onClick={() => onSeek(part.start)}
                aria-label={`Go to ${[part.number, part.title].filter(Boolean).join(' ')}`}
                title={[part.number, part.title].filter(Boolean).join(' ')}
              />
            );
          })}
        </div>
        <p className="rd-podcast-text" lang="en">
          {preparing
            ? `Preparing the audio, ${Math.floor(progress * 100)}%`
            : sentence?.words.map((text, index) => (
              <span key={index} data-said={index < sentence.current || undefined} data-current={index === sentence.current || undefined}>{text} </span>
            ))}
        </p>
        {!preparing && (
          <div className="rd-podcast-controls">
            <span className="rd-listen-time">{clock(position)}</span>
            <ReadAloudTransport position={position} playing={playing} onPlayPause={onPlayPause} onSeek={onSeek} />
            <span className="rd-listen-time rd-listen-left">−{clock((timeline.duration - position) / speed)}</span>
          </div>
        )}
        {!preparing && <SpeedButton speed={speed} onSpeed={onSpeed} />}
      </DialogContent>
    </Dialog>
  );
}
