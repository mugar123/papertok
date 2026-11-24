import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { DownloadSimple, ListBullets } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import type { CharacterTimings, ReadAloudTimeline, SpokenPassage } from './read-aloud.ts';
import { chapterAt, clock, passageText, spokenWordAt, wordSpans, wordStarts } from './read-aloud.ts';
import { ReadAloudTrack, ReadAloudTransport, SpeedButton } from './read-aloud-controls.tsx';
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
 * The paper as a podcast, in a tab of the viewer beside its text, always on night paper:
 * a turning wireframe sphere, the sentence being read as a large caption, one row of
 * controls round the timeline (which shows the audio still to come, then where the voice
 * is), and the paper's sections as chapters in a drawer.
 */
export default function ReadAloudListen({ title, queue, timeline, prepared, paragraph, position, playing, speed, timings, live, onSpeed, onPlayPause, onSeek, onDownload }: {
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
  onDownload: () => void;
}) {
  const preparing = !prepared.failed && prepared.ready < prepared.total;
  const percent = prepared.total ? Math.floor((prepared.ready / prepared.total) * 100) : 0;
  // Where a drag along the line would move the voice, until it is let go.
  const [target, setTarget] = useState<number | null>(null);
  // The player's position moves when a clip reports its time, and with the browser's voice only
  // as each sentence ends; while it speaks, the tab reads where the voice is on every frame.
  const [voiceAt, setVoiceAt] = useState<number | null>(null);
  const now = playing && voiceAt !== null ? voiceAt : position;
  const shown = target ?? now;
  const chapter = chapterAt(timeline, shown);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  // The caption's box follows the sentence's height with a transition (read-aloud-listen.css), so a
  // longer or shorter sentence eases the sphere and the controls to their place instead of jumping.
  const caption = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = caption.current;
    const text = box?.firstElementChild;
    if (!box || !text) return undefined;
    const observer = new ResizeObserver(() => { box.style.height = `${(text as HTMLElement).offsetHeight}px`; });
    observer.observe(text);
    return () => observer.disconnect();
  }, []);
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
  const unsaved = prepared.ready < prepared.total;

  return (
    <section className="rd-podcast" aria-labelledby="rd-podcast-title">
      <div className="rd-podcast-cover"><ReadAloudSphere ready={!preparing} playing={playing} /></div>

      {/* The paper, then the section the voice is in: one line on a wide screen; on a phone the
          paper is the small label and the section the large title, as a player names a song. */}
      <h2 id="rd-podcast-title" className="rd-podcast-title">
        <span className="rd-podcast-paper">{title}</span>
        {!preparing && <span className="rd-podcast-section">{[chapter.number, chapter.title].filter(Boolean).join(' ')}</span>}
      </h2>

      <div ref={caption} className="rd-podcast-caption">
        <p className="rd-podcast-text" lang="en">
          {preparing
            ? `Preparing the audio, ${percent}%`
            : !sentence ? 'Press play to listen.' : sentence.words.map((text, index) => (
              <span key={index} data-said={index < sentence.current || undefined} data-current={index === sentence.current || undefined}>{text} </span>
            ))}
        </p>
      </div>

      {/* The controls: under the caption on a wide screen; on a phone, a bar fixed to the bottom of the
          tab, ruled off from the sphere and the caption, which scroll behind it. */}
      <div className="rd-podcast-player">
        {preparing ? <ReadAloudTrack timeline={timeline} prepared={prepared} position={now} target={target} onTarget={setTarget} onSeek={onSeek} /> : (
          <div className="rd-podcast-dock">
            {/* As a music player lays them out: the transport centred, the speed and the chapters at its sides. */}
            <div className="rd-podcast-buttons">
              <SpeedButton speed={speed} onSpeed={onSpeed} />
              <ReadAloudTransport position={now} playing={playing} onPlayPause={onPlayPause} onSeek={onSeek} />
              {timeline.chapters.length > 1 ? (
                <Button variant="ghost" size="icon" aria-label="Chapters" title="Chapters" aria-expanded={chaptersOpen} aria-controls={drawerId} onClick={() => setChaptersOpen(open => !open)}>
                  <ListBullets size={20} aria-hidden="true" />
                </Button>
              ) : <span />}
            </div>
            {/* and under it the line, its minute at one end and what is left at the other. */}
            <div className="rd-podcast-line">
              <span className="rd-listen-time">{clock(shown)}</span>
              <ReadAloudTrack timeline={timeline} prepared={prepared} position={now} target={target} onTarget={setTarget} onSeek={onSeek} />
              <span className="rd-listen-time rd-listen-left">−{clock((timeline.duration - shown) / speed)}</span>
            </div>
          </div>
        )}

        {!preparing && (
          <div className="rd-podcast-tools">
            <Button
              variant="outline"
              size="sm"
              className="rd-podcast-chip"
              onClick={onDownload}
              disabled={unsaved}
              focusableWhenDisabled
              title={unsaved ? 'The audio cannot be saved: some paragraphs do not have PaperTok’s voice.' : 'Download the audio'}
            >
              <DownloadSimple size={16} aria-hidden="true" />
              Download
            </Button>
          </div>
        )}
      </div>

      {timeline.chapters.length > 1 && (
        <nav id={drawerId} className="rd-podcast-chapters" aria-label="Chapters" data-open={chaptersOpen || undefined} inert={!chaptersOpen}>
          <p className="rd-podcast-chapters-title" aria-hidden="true">Chapters</p>
          <ol>
            {timeline.chapters.map(part => (
              <li key={part.start}>
                <button
                  type="button"
                  disabled={preparing}
                  aria-current={(!preparing && part.start === chapter.start) || undefined}
                  onClick={() => { onSeek(part.start); setChaptersOpen(false); }}
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
