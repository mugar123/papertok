import { useEffect, useMemo, useState } from 'react';
import { DownloadSimple } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import type { CharacterTimings, ReadAloudTimeline, SpokenPassage } from './read-aloud.ts';
import { chapterAt, clock, passageText, spokenWordAt, wordSpans, wordStarts } from './read-aloud.ts';
import { ReadAloudTrack, ReadAloudTransport, SpeedButton } from './read-aloud-player.tsx';
import ReadAloudSphere from './read-aloud-sphere.tsx';
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
 * The paper as a podcast, in a tab of the viewer beside its text: a turning
 * wireframe sphere, the line under it that shows how much of the audio has
 * arrived and then how far the voice has got, the sentence being read, the
 * controls, and the paper's sections as chapters to jump to.
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
  const percent = prepared.total ? Math.floor((prepared.ready / prepared.total) * 100) : 0;
  // Where a drag along the line would move the voice, until it is let go.
  const [target, setTarget] = useState<number | null>(null);
  const shown = target ?? position;
  const chapter = chapterAt(timeline, shown);

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
      <div className="rd-podcast-cover"><ReadAloudSphere ready={!preparing} playing={playing} /></div>

      <div className="rd-podcast-head">
        <h2 id="rd-podcast-title" className="rd-podcast-title">{title}</h2>
        {byline && <p className="rd-podcast-byline">{byline}</p>}
      </div>

      <p className="rd-podcast-text" lang="en">
        {preparing
          ? `Preparing the audio, ${percent}%`
          : sentence?.words.map((text, index) => (
            <span key={index} data-said={index < sentence.current || undefined} data-current={index === sentence.current || undefined}>{text} </span>
          ))}
      </p>

      <ReadAloudTrack timeline={timeline} prepared={prepared} position={position} target={target} onTarget={setTarget} onSeek={onSeek} />
      {!preparing && (
        <>
          <div className="rd-podcast-times">
            <span className="rd-listen-time">{clock(shown)}</span>
            <span className="rd-listen-chapter-now">{[chapter.number, chapter.title].filter(Boolean).join(' ')}</span>
            <span className="rd-listen-time">−{clock((timeline.duration - shown) / speed)}</span>
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
                  aria-current={(!preparing && part.start === chapter.start) || undefined}
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
