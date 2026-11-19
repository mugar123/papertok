import type { Block, FullText, Inline } from '../../utils/full-text.ts';
import { plainScientificText } from '../../utils/plain-scientific-text.ts';

/** One request's worth of speech: a passage of the paper, or part of a long one. */
export interface SpokenPassage {
  /** The `data-passage` of the block it reads, so the reader can mark and scroll to it. */
  passage: string;
  utterances: string[];
}

/** Below the Worker's 3,000 characters a request, so a long paragraph is sent in parts. */
const MAX_PART_CHARS = 2_500;
const FORMULA_OMITTED = 'Formula omitted.';

/** The words of a run of inline content, without citation marks or pictured formulas. */
export function spokenInlines(content: Inline[]): string {
  return content.map((item) => {
    switch (item.t) {
      case 'text': return item.text;
      case 'math': return item.tex ? plainScientificText(`$${item.tex}$`) : 'formula';
      case 'formula-image': return '';
      case 'ref': return item.cites ? '' : spokenInlines(item.children);
      default: return spokenInlines(item.children);
    }
  }).join('');
}

const tidy = (text: string) => text.replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s*\)|\[\s*\]/g, '').trim();

function sentences(text: string) {
  if (typeof Intl.Segmenter !== 'function') return text ? [text] : [];
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .map(part => part.segment.trim())
    .filter(Boolean);
}

/** Sentences grouped into parts that each fit one request. */
function parts(lines: string[]) {
  const out: string[][] = [[]];
  let length = 0;
  for (const line of lines) {
    if (length > 0 && length + line.length + 1 > MAX_PART_CHARS) {
      out.push([]);
      length = 0;
    }
    out[out.length - 1].push(line.slice(0, MAX_PART_CHARS));
    length += line.length + 1;
  }
  return out.filter(group => group.length > 0);
}

export interface ReadAloudChapter {
  number: string;
  title: string;
  /** Index of its first passage in the queue. */
  first: number;
}

/**
 * What reading the paper aloud says, in order: the abstract when it is shown,
 * then the body's prose and lists. Headings are spoken before what follows them
 * and start a chapter; a display formula is announced once instead of read;
 * figures, tables, citation marks, notes and references are left out.
 */
export function fullTextListen(doc: FullText, { withAbstract }: { withAbstract: boolean }) {
  const queue: SpokenPassage[] = [];
  const chapters: ReadAloudChapter[] = [];
  let heading: string | null = null;

  const read = (blocks: Block[], prefix: string) => blocks.forEach((block, index) => {
    if (block.t === 'heading') {
      const title = tidy(spokenInlines(block.children));
      if (!title) return;
      chapters.push({ number: block.label?.replace(/\.$/, '') ?? '', title, first: queue.length });
      const spoken = block.label ? `${block.label.replace(/\.$/, '')}. ${title}.` : `${title}.`;
      heading = heading ? `${heading} ${spoken}` : spoken;
      return;
    }
    if (block.t === 'equation') {
      queue[queue.length - 1]?.utterances.push(FORMULA_OMITTED);
      return;
    }
    if (block.t !== 'p' && block.t !== 'list') return;
    const text = tidy(block.t === 'p'
      ? spokenInlines(block.children)
      : block.items.map(item => spokenInlines(item)).join('. '));
    if (!text) return;
    const lines = [...(heading ? [heading] : []), ...sentences(text)];
    heading = null;
    for (const group of parts(lines)) queue.push({ passage: `${prefix}${index}`, utterances: group });
  });

  if (withAbstract && doc.abstract.length > 0) {
    chapters.push({ number: '', title: 'Abstract', first: 0 });
    read(doc.abstract, 'a');
  }
  read(doc.body, 'b');
  return { queue, chapters: chapters.filter((chapter, index) => chapter.first < queue.length && chapter.first !== chapters[index + 1]?.first) };
}

/** The voice speaks about this many characters a second, until a clip's real length is known. */
const CHARS_PER_SECOND = 15;

/**
 * Where each passage and chapter sits in the listen, in seconds: the clip's own
 * length once it has arrived, and an estimate from the length of the text until then.
 */
export function readAloudTimeline(
  queue: readonly SpokenPassage[],
  chapters: readonly ReadAloudChapter[],
  measured: (item: SpokenPassage) => number | undefined = () => undefined,
) {
  let clock = 0;
  const passages = queue.map((item) => {
    const start = clock;
    clock += measured(item) ?? Math.max(2, Math.round(item.utterances.join(' ').length / CHARS_PER_SECOND));
    return { start, end: clock };
  });
  const starts = chapters.length > 0 && chapters[0].first === 0 ? chapters : [{ number: '', title: 'Introduction', first: 0 }, ...chapters];
  const parts = starts.map((chapter, index) => ({
    number: chapter.number,
    title: chapter.title,
    start: passages[chapter.first]?.start ?? clock,
    end: index + 1 < starts.length ? passages[starts[index + 1].first]?.start ?? clock : clock,
  }));
  return { passages, chapters: parts, duration: clock };
}

export type ReadAloudTimeline = ReturnType<typeof readAloudTimeline>;

/** The passage a moment in the listen falls in, and how far into it. */
export function locateInListen(timeline: ReadAloudTimeline, seconds: number) {
  const { passages } = timeline;
  const found = passages.findIndex(passage => seconds < passage.end);
  const index = found === -1 ? passages.length - 1 : found;
  const { start, end } = passages[index];
  return { index, fraction: Math.min(1, Math.max(0, (seconds - start) / (end - start))) };
}

export function chapterAt(timeline: ReadAloudTimeline, seconds: number) {
  return timeline.chapters.find(chapter => seconds < chapter.end) ?? timeline.chapters[timeline.chapters.length - 1];
}

/** `visible` is the range of passages on screen, or null when reading starts from the top. */
export function readAloudStart(paused: number | null, visible: { first: number; last: number } | null) {
  if (!visible) return paused ?? 0;
  return paused !== null && paused >= visible.first && paused <= visible.last ? paused : visible.first;
}
