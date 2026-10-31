export interface HighlightInput { quote?: unknown; kind?: string; source?: string; id?: string | null; fresh?: boolean; pending?: boolean; proposed?: boolean }
export interface HighlightRange { start: number; end: number; kind: string; source: string; id: string | null; fresh: boolean; pending: boolean; proposed: boolean }
type TextSegment = { type: 'text'; value: string; start: number; end: number; kind?: never; id?: never; source?: never; under?: never }
  | ({ type: 'mark'; value: string; under: string[] } & HighlightRange);
export type HighlightMath = Omit<HighlightRange, 'kind' | 'source'> & { type: 'math'; value: string; raw: string; display: boolean; kind: string | null; source: string | null; under: string[] };
export type HighlightChunk = TextSegment | HighlightMath;

import { normalizeLatexText, normalizeSavedLatexText, paintedQuote, savedHighlightSpace, splitLatexText } from './latex.ts';

/**
 * Resolving highlights onto rendered scientific text.
 *
 * Two constraints shape this module:
 *
 * 1. `splitLatexText` runs its input through `normalizeLatexText` first, which
 *    strips markup, collapses whitespace and escapes `%`. Offsets in the raw
 *    string therefore do not survive. Ranges are in *normalized* space, and
 *    quotes are cut from that text before its font commands are unwrapped
 *    (`savedHighlightSpace`) and found there again.
 *
 * 2. A highlight must never cross *into* a maths chunk. Wrapping part of a
 *    `$...$` expression in a `<mark>` would hand KaTeX a broken fragment, so
 *    ranges are clipped to text chunks. A maths chunk a range covers whole is a
 *    different case: nothing is being cut, so it is marked as one piece and the
 *    highlight runs through the formula instead of stopping either side of it.
 *
 * Every item a plan emits carries its `start`/`end` in normalized space. That
 * is what lets a reader map a DOM selection back onto the source: the rendered
 * maths says `x²` where the source says `$x^2$`, so a selection's own text is
 * useless as an anchor and its offsets are the only thing that survives.
 */

/** Shorter than this and a quote matches the wrong place too easily. */
const MIN_QUOTE_LENGTH = 8;

/**
 * A quote keeps its font commands: it lives in `savedHighlightSpace`, and
 * whether a wrapper unwraps depends on the formulas around it in the
 * paragraph, which a quote on its own does not have.
 */
export function normalizeHighlightQuote(quote: unknown) {
  return normalizeSavedLatexText(quote);
}

/**
 * Which of two ranges covering the same characters paints them.
 *
 * The reader's own marks sit over the model's: a selection still deciding
 * what it wants to become is the topmost thing on the page, then a highlight
 * the reader made, then a passage the model proposed. Ties keep document
 * order. Whatever is underneath is not lost: the segment remembers it in
 * `under`, and the renderer keeps the model's underline running beneath the
 * reader's wash.
 */
function layerRank(range: HighlightRange) {
  if (range.pending) return 0;
  return range.source === 'user' ? 1 : 2;
}

function byLayer(a: HighlightRange, b: HighlightRange) {
  return layerRank(a) - layerRank(b) || a.start - b.start;
}

/**
 * Whether `buildHighlightPlan` paints any of `start`..`end`: it marks prose,
 * and a formula only when the range covers it whole. A quote can also occur
 * inside a formula, and resolving it there drew no mark at all.
 *
 * Every occurrence of a quote is checked, so the formulas the range touches
 * are found by bisecting the spans, which are in order and disjoint: walking
 * all of them per occurrence took a paragraph of 3,000 formulas holding the
 * quote ten times as long to resolve.
 */
function drawsMark(formulas: [number, number][], start: number, end: number) {
  let low = 0;
  let high = formulas.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (formulas[middle][1] <= start) low = middle + 1;
    else high = middle;
  }
  let inFormulas = 0;
  for (let index = low; index < formulas.length && formulas[index][0] < end; index += 1) {
    const [from, to] = formulas[index];
    if (start <= from && to <= end) return true;
    inFormulas += Math.min(end, to) - Math.max(start, from);
  }
  return inFormulas < end - start;
}

/**
 * Maps quotes onto character ranges of the normalized text.
 *
 * A quote the model mangled simply fails to match and is dropped: a missing
 * highlight is invisible, whereas a mis-placed one is a lie about the text.
 */
export function resolveHighlightRanges(text: unknown, highlights: HighlightInput[] = []) {
  const space = savedHighlightSpace(text);
  if (!space.current) return [];

  const ranges: HighlightRange[] = [];
  for (const highlight of highlights) {
    const quote = normalizeHighlightQuote(highlight?.quote);
    const source = highlight?.source || 'ai';
    const pending = Boolean(highlight?.pending);

    // Prefer the first occurrence not already marked BY THE SAME SOURCE, so
    // repeated phrasing marks each mention rather than piling onto the first.
    // A mark of the other source does not claim the text: a reader may well
    // select the sentence the model proposed, and both then have to show —
    // dropping the second one, whichever it was, took the model's underline
    // away the moment the reader's selection touched it (2026-09-17). A
    // pending selection sits on anything, its own saved mark included.
    const claimed = (range: HighlightRange) => !pending && !range.pending && range.source === source;
    const findFree = (
      haystack: string,
      needle: string,
      toCurrent = (offset: number) => offset,
      accepts?: (start: number, end: number) => boolean,
    ) => {
      for (let candidate = haystack.indexOf(needle); candidate !== -1; candidate = haystack.indexOf(needle, candidate + 1)) {
        const start = toCurrent(candidate);
        const end = toCurrent(candidate + needle.length);
        if (end > start && (!accepts || accepts(start, end)) && drawsMark(space.formulas, start, end) && !ranges.some(range => claimed(range) && start < range.end && end > range.start)) return { start, end };
      }
      return null;
    };
    if (quote.length < MIN_QUOTE_LENGTH) continue;
    // Found in the text it was cut from, where main found it too. A quote not
    // cut from it, such as one the model wrote or a selection read off the
    // screen, may only occur in the painted text. The first occurrence that
    // paints the quote as it reads on its own wins: selecting bold `agent
    // harness` stores `\textbf{agent harness}`, which a formula or an escaped
    // `\\textbf` elsewhere in the paragraph shows as written, and preferring
    // that spelling marked the other mention or nothing (2026-10-31). Next is
    // one that paints the quote as written, which is how a wrapper the
    // paragraph keeps resolves; then one that paints its words without the
    // cut brackets, because a quote that starts or ends on a brace can also
    // match a wrapper's brace earlier in the paragraph.
    const words = paintedQuote(quote);
    const paints = (text: string) => (start: number, end: number) => space.current.slice(start, end).trim() === text;
    const found = findFree(space.text, quote, space.toCurrent, paints(normalizeLatexText(quote)))
      ?? findFree(space.text, quote, space.toCurrent, paints(quote))
      ?? findFree(space.text, quote, space.toCurrent, paints(words))
      ?? findFree(space.text, quote, space.toCurrent)
      ?? (space.text === space.current ? null : findFree(space.current, quote));
    if (!found) continue;
    const { start, end } = found;

    ranges.push({
      start,
      end,
      kind: highlight?.kind || 'finding',
      source,
      id: highlight?.id || null,
      // Transient render states, carried rather than stored: the pen laying its
      // colour down on a mark that was just made, and the provisional wash on a
      // selection still deciding what it wants to become.
      fresh: Boolean(highlight?.fresh),
      pending,
      // The model's own suggestions, which the reader can switch off. Carried
      // rather than filtered out up front so switching them off can be a change
      // of colour instead of a change of document.
      proposed: Boolean(highlight?.proposed),
    });
  }

  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Cuts one text chunk into plain and marked segments.
 * `chunkStart` is the chunk's offset within the normalized text.
 *
 * Cut at every boundary any range draws inside the chunk, so two ranges that
 * overlap yield three segments — one for each, one for the shared stretch —
 * and the shared stretch is painted by the topmost (`byLayer`) with the rest
 * remembered in `under`. Ranges spanning maths are clipped to the chunk; the
 * maths between stays intact (see `buildHighlightPlan`).
 */
export function segmentTextChunk(chunkStart: number, value: string, ranges: HighlightRange[]): TextSegment[] {
  const chunkEnd = chunkStart + value.length;
  const overlapping = ranges.filter(range => range.start < chunkEnd && range.end > chunkStart);
  if (overlapping.length === 0) {
    return [{ type: 'text', value, start: chunkStart, end: chunkEnd }];
  }

  const cuts = new Set([chunkStart, chunkEnd]);
  for (const range of overlapping) {
    cuts.add(Math.max(range.start, chunkStart));
    cuts.add(Math.min(range.end, chunkEnd));
  }
  const points = [...cuts].sort((a, b) => a - b);

  const segments: TextSegment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const slice = value.slice(start - chunkStart, end - chunkStart);
    const covering = overlapping.filter(range => range.start <= start && range.end >= end).sort(byLayer);
    if (covering.length === 0) {
      segments.push({ type: 'text', value: slice, start, end });
      continue;
    }
    const [top, ...rest] = covering;
    segments.push({
      type: 'mark',
      value: slice,
      start,
      end,
      kind: top.kind,
      source: top.source,
      id: top.id,
      fresh: top.fresh,
      pending: top.pending,
      proposed: top.proposed,
      under: rest.map(range => range.source),
    });
  }
  return segments;
}

/**
 * Produces a flat render plan for a paragraph: text and mark segments
 * interleaved with the maths chunks, in document order.
 */
export function buildHighlightPlan(text: unknown, highlights: HighlightInput[] = []) {
  const chunks = splitLatexText(text);
  const ranges = resolveHighlightRanges(text, highlights);
  const plan: HighlightChunk[] = [];
  let offset = 0;

  for (const chunk of chunks) {
    if (chunk.type === 'text') {
      for (const segment of segmentTextChunk(offset, chunk.value, ranges)) {
        if (segment.value) plan.push(segment);
      }
      offset += chunk.value.length;
      continue;
    }
    const mathEnd = offset + chunk.raw.length;
    // Whole or not at all. A formula cannot be marked in half — there is no
    // character in `x²` that corresponds to the middle of `$x^2$` — so only a
    // range that swallows the entire chunk paints it; the topmost of them does.
    const [covering, ...beneath] = ranges
      .filter(range => range.start <= offset && range.end >= mathEnd)
      .sort(byLayer);
    plan.push({
      type: 'math',
      value: chunk.value,
      raw: chunk.raw,
      display: chunk.display,
      start: offset,
      end: mathEnd,
      kind: covering?.kind || null,
      source: covering?.source || null,
      id: covering?.id || null,
      fresh: Boolean(covering?.fresh),
      pending: Boolean(covering?.pending),
      proposed: Boolean(covering?.proposed),
      under: beneath.map(range => range.source),
    });
    offset = mathEnd;
  }

  return plan;
}

/**
 * Turns a user text selection into an anchor that can be re-resolved after the
 * rewrite is regenerated. Position is deliberately not stored: the quote is the
 * anchor, and `paragraphIndex` only scopes the search.
 */
export function buildSelectionAnchor(selectedText: string) {
  const quote = normalizeHighlightQuote(selectedText);
  if (quote.length < MIN_QUOTE_LENGTH) return null;
  return { quote, kind: 'user' };
}

/**
 * The same anchor, built from offsets instead of from the selected string.
 *
 * A selection that touches maths cannot be read back with `toString()`: KaTeX
 * renders both a visual copy and a clipped MathML copy of the formula, so the
 * browser hands back something like `x2x^2x2` where the paragraph source says
 * `$x^2$`, and the quote matches nothing. Offsets into the normalized text
 * survive that, and slicing the source with them produces a quote that
 * `resolveHighlightRanges` can find again on the next render.
 */
export function buildRangeAnchor(text: unknown, start: number, end: number) {
  const space = savedHighlightSpace(text);
  let from = Math.max(0, Math.min(start, end));
  let to = Math.min(space.current.length, Math.max(start, end));
  while (from < to && /\s/.test(space.current[from])) from += 1;
  while (to > from && /\s/.test(space.current[to - 1])) to -= 1;
  const words = space.current.slice(from, to);
  if (words.length < MIN_QUOTE_LENGTH) return null;
  return { quote: savedQuote(space, from, to, words), kind: 'user' };
}

/** Slices `savedQuote` normalizes for one selection before it keeps the bare one. */
const QUOTE_TRIES = 8;

/**
 * The painted characters `from`..`to` as the slice of the saved space they
 * came from. Font commands the selection covers whole come with it, so it reads
 * as the selected words and selecting `HERMES harness` stores the
 * `\textbf{HERMES} harness` a reader selected on main. A selection that cuts
 * across a wrapper keeps the brace between, which still marks it.
 *
 * Between two painted characters the saved text holds only what unwrapping
 * removed: font command openers, their closing braces and spaces. Walking out
 * from the selection, a slice may start at each opener met before the first
 * closer, and end after each closer met before the first opener. A slice past
 * that brace carries a brace cut from its partner, or a wrapper that paints
 * nothing such as `\emph{}`: sixty of those filled the 400 characters a quote
 * is stored at and left no words to mark. The slices are tried widest first, and each try normalizes the whole slice:
 * past `QUOTE_TRIES` the bare slice is kept, so a text that makes many of them
 * fail cannot stall the reader's selection handler.
 */
function savedQuote({ text: saved, source }: ReturnType<typeof savedHighlightSpace>, from: number, to: number, words: string) {
  const start = source[from];
  const end = source[to - 1] + 1;
  const firsts = [start];
  for (let index = start - 1; index >= (from > 0 ? source[from - 1] + 1 : 0) && saved[index] !== '}'; index -= 1) {
    if (saved[index] === '\\') firsts.push(index);
  }
  const lasts = [end];
  for (let index = end; index < (to < source.length ? source[to] : saved.length) && saved[index] !== '{'; index += 1) {
    if (saved[index] === '}') lasts.push(index + 1);
  }
  firsts.reverse();
  lasts.reverse();
  let tries = 0;
  for (const first of firsts) {
    for (const last of lasts) {
      const quote = saved.slice(first, last);
      if (normalizeLatexText(quote) === words) return quote;
      if (++tries === QUOTE_TRIES) return saved.slice(start, end);
    }
  }
  return saved.slice(start, end);
}

export const HIGHLIGHT_MIN_QUOTE_LENGTH = MIN_QUOTE_LENGTH;
