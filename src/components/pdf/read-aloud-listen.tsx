import { useEffect, useMemo, useRef, useState } from 'react';
import { DownloadSimple } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
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
 * The paper as a podcast, in a tab of the viewer beside its text: a sphere that
 * breathes while the voice speaks, ringed by how much of the audio has arrived
 * and then by how far the voice has got; the sentence being read; the controls;
 * and the paper's sections as chapters to jump to.
 */
export default function ReadAloudListen({ title, byline, queue, timeline, prepared, paragraph, position, playing, speed, timings, live, onSpeed, onPlayPause, onSeek, onDownload }: {
  title: string;
  /** Who wrote it, under the title, as a show's name sits under an episode's. */
  byline: string;
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
  onDownload: () => void;
}) {
  const preparing = !prepared.failed && prepared.ready < prepared.total;
  const progress = preparing
    ? (prepared.total ? prepared.ready / prepared.total : 0)
    : (timeline.duration ? Math.min(1, position / timeline.duration) : 0);
  const chapter = chapterAt(timeline, position);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus(); }, []);

  const item = paragraph === null ? null : queue[paragraph] ?? null;
  const starts = useMemo(() => {
    if (!item) return null;
    const text = passageText(item);
    return wordStarts(text, timings[text] ?? null);
  }, [item, timings]);
  const [word, setWord] = useState(0);
  useEffect(() => {
    if (!item) return undefined;
    const text = passageText(item);
    let frame = 0;
    const tick = () => {
      setWord(spokenWordAt(text, starts, live()));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [item, live, starts]);
  const sentence = item ? spokenSentence(item, word) : null;
  const unsaved = prepared.ready < prepared.total;

  return (
    <section className="rd-podcast" aria-labelledby="rd-podcast-title">
      <div className="rd-podcast-cover">
        <svg className="rd-podcast-ring" viewBox="0 0 200 200" aria-hidden="true">
          <circle className="rd-podcast-track" cx="100" cy="100" r="94" />
          <circle className="rd-podcast-fill" data-preparing={preparing || undefined} cx="100" cy="100" r="94" pathLength={1} strokeDasharray={`${progress} 1`} />
        </svg>
        <div className="rd-podcast-orb" data-playing={(playing && !preparing) || undefined} aria-hidden="true" />
        {/* A pointer's shortcut to the chapters listed below, which are the way in for a keyboard. */}
        {!preparing && timeline.duration > 0 && timeline.chapters.map(part => (
          <button
            key={part.start}
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="rd-podcast-mark"
            data-played={part.start <= position || undefined}
            style={{ '--turn': part.start / timeline.duration }}
            onClick={() => onSeek(part.start)}
            title={[part.number, part.title].filter(Boolean).join(' ')}
          />
        ))}
      </div>

      <div className="rd-podcast-head">
        <h2 ref={heading} id="rd-podcast-title" tabIndex={-1} className="rd-podcast-title">{title}</h2>
        {byline && <p className="rd-podcast-byline">{byline}</p>}
      </div>

      <p className="rd-podcast-text" lang="en">
        {preparing
          ? `Preparing the audio, ${Math.floor(progress * 100)}%`
          : sentence?.words.map((text, index) => (
            <span key={index} data-said={index < sentence.current || undefined} data-current={index === sentence.current || undefined}>{text} </span>
          ))}
      </p>

      {!preparing && (
        <>
          <div className="rd-podcast-times">
            <span className="rd-listen-time">{clock(position)}</span>
            <span className="rd-listen-chapter-now">{[chapter.number, chapter.title].filter(Boolean).join(' ')}</span>
            <span className="rd-listen-time">−{clock((timeline.duration - position) / speed)}</span>
          </div>
          <div className="rd-podcast-controls">
            <SpeedButton speed={speed} onSpeed={onSpeed} />
            <ReadAloudTransport position={position} playing={playing} onPlayPause={onPlayPause} onSeek={onSeek} />
            <Button
              variant="ghost"
              size="icon"
              onClick={onDownload}
              disabled={unsaved}
              focusableWhenDisabled
              aria-label="Download the audio"
              title={unsaved ? 'The audio cannot be saved: some paragraphs do not have PaperTok’s voice.' : 'Download the audio'}
            >
              <DownloadSimple size={18} aria-hidden="true" />
            </Button>
          </div>
        </>
      )}

      {timeline.chapters.length > 1 && (
        <nav className="rd-podcast-chapters" aria-label="Chapters">
          <ol>
            {timeline.chapters.map(part => (
              <li key={part.start}>
                <button
                  type="button"
                  disabled={preparing}
                  aria-current={part.start === chapter.start || undefined}
                  onClick={() => onSeek(part.start)}
                  aria-label={`${[part.number, part.title].filter(Boolean).join(' ')}, ${clock(part.end - part.start)}`}
                >
                  <span className="rd-podcast-chapter-number">{part.number}</span>
                  <span className="rd-podcast-chapter-title">{part.title}</span>
                  <span className="rd-podcast-chapter-time">{clock(part.end - part.start)}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </section>
  );
}
