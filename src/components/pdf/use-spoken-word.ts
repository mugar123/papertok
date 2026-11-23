import type { CharacterTimings, SpokenPassage } from './read-aloud.ts';
import { useEffect, useRef } from 'react';
import { matchSpokenWords, passageText, spokenWordAt, wordSpans, wordStarts } from './read-aloud.ts';
import { blockText, offsetsRange } from './passage-range.ts';

/**
 * Moves the `.rd-word` box in `root` under the word the voice is on in the paper's
 * text: every frame while it plays, and once where a seek leaves it while paused. It
 * slides along a line and jumps to the next one (`data-jump`), so it never sweeps back
 * across the passage. A passage read in parts is matched as a whole, so each part finds
 * its words further into the block; the heading read before it is not in the block.
 */
export function useSpokenWord({ root, queue, speaking, timings, live, playing, position }: {
  root: HTMLElement | null;
  queue: readonly SpokenPassage[];
  speaking: number | null;
  timings: Record<string, CharacterTimings>;
  live: () => { seconds: number | null; fraction: number };
  playing: boolean;
  position: number;
}) {
  // Read each frame, so a new reading does not restart the loop.
  const reading = useRef(live);
  useEffect(() => { reading.current = live; }, [live]);
  // Paused, the box moves with each seek; playing, the frame loop moves it.
  const still = playing ? null : position;
  useEffect(() => {
    const item = speaking === null ? null : queue[speaking];
    const box = root?.querySelector<HTMLElement>(':scope > .rd-word');
    if (!root || !box || !item) return undefined;
    const block = root.querySelector(`[data-passage="${CSS.escape(item.passage)}"]`);
    if (!block) return undefined;

    const parts = queue.filter(part => part.passage === item.passage);
    const texts = parts.map(passageText);
    const spoken = texts.join(' ');
    const spokenSpans = wordSpans(spoken);
    const heading = parts[0].heading?.length ?? 0;
    const page = blockText(block);
    const pageSpans = wordSpans(page);
    const onPage = matchSpokenWords(
      spokenSpans.map(([start, end]) => (end <= heading ? '' : spoken.slice(start, end))),
      pageSpans.map(([start, end]) => page.slice(start, end)),
    );
    const index = parts.indexOf(item);
    const text = texts[index];
    const offset = texts.slice(0, index).reduce((sum, part) => sum + part.length + 1, 0);
    const first = spokenSpans.findIndex(([start]) => start >= offset);
    const starts = wordStarts(text, timings[text] ?? null);

    let word = -1;
    let range: Range | null = null;
    let shown = '';
    let line = Number.NaN;
    const paint = () => {
      const at = onPage[first + spokenWordAt(text, starts, reading.current())];
      if (at === undefined) return;
      if (at !== word) {
        word = at;
        range = offsetsRange(block, pageSpans[at]);
      }
      // Measured every frame, so the box follows its word when the text reflows.
      const rect = range?.getClientRects()[0];
      if (!rect) return;
      const view = root.getBoundingClientRect();
      const x = Math.round(rect.left - view.left + root.scrollLeft);
      const y = Math.round(rect.top - view.top + root.scrollTop);
      const place = `${x} ${y} ${Math.round(rect.width)} ${Math.round(rect.height)}`;
      if (place === shown) return;
      box.toggleAttribute('data-jump', y !== line);
      box.style.transform = `translate(${x}px, ${y}px)`;
      box.style.width = `${Math.round(rect.width)}px`;
      box.style.height = `${Math.round(rect.height)}px`;
      box.hidden = false;
      shown = place;
      line = y;
    };
    paint();
    let frame = 0;
    if (playing) {
      const loop = () => {
        paint();
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(frame);
      box.hidden = true;
    };
  }, [playing, queue, root, speaking, still, timings]);
}
