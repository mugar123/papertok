import { normalizeLatexText, splitLatexText } from './latex.js';

/**
 * Resolving highlights onto rendered scientific text.
 *
 * Two constraints shape this module:
 *
 * 1. `splitLatexText` runs its input through `normalizeLatexText` first, which
 *    strips markup, collapses whitespace and escapes `%`. Offsets in the raw
 *    string therefore do not survive. Everything here works in *normalized*
 *    space, and quotes are normalized the same way before being searched.
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

export function normalizeHighlightQuote(quote) {
  return normalizeLatexText(quote);
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
function layerRank(range) {
  if (range.pending) return 0;
  return range.source === 'user' ? 1 : 2;
}

function byLayer(a, b) {
  return layerRank(a) - layerRank(b) || a.start - b.start;
}

/**
 * Maps quotes onto character ranges of the normalized text.
 *
 * A quote the model mangled simply fails to match and is dropped: a missing
 * highlight is invisible, whereas a mis-placed one is a lie about the text.
 */
export function resolveHighlightRanges(text, highlights = []) {
  const normalized = normalizeLatexText(text);
  if (!normalized) return [];

  const ranges = [];
  for (const highlight of highlights) {
    const quote = normalizeHighlightQuote(highlight?.quote);
    if (quote.length < MIN_QUOTE_LENGTH) continue;
    const source = highlight?.source || 'ai';
    const pending = Boolean(highlight?.pending);

    // Prefer the first occurrence not already marked BY THE SAME SOURCE, so
    // repeated phrasing marks each mention rather than piling onto the first.
    // A mark of the other source does not claim the text: a reader may well
    // select the sentence the model proposed, and both then have to show —
    // dropping the second one, whichever it was, took the model's underline
    // away the moment the reader's selection touched it (2026-09-17). A
    // pending selection sits on anything, its own saved mark included.
    const claimed = range => !pending && !range.pending && range.source === source;
    let searchFrom = 0;
    let start = -1;
    for (;;) {
      const candidate = normalized.indexOf(quote, searchFrom);
      if (candidate === -1) break;
      const end = candidate + quote.length;
      const overlaps = ranges.some(range => claimed(range) && candidate < range.end && end > range.start);
      if (!overlaps) {
        start = candidate;
        break;
      }
      searchFrom = candidate + 1;
    }
    if (start === -1) continue;

    ranges.push({
      start,
      end: start + quote.length,
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
export function segmentTextChunk(chunkStart, value, ranges) {
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

  const segments = [];
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
export function buildHighlightPlan(text, highlights = []) {
  const chunks = splitLatexText(text);
  const ranges = resolveHighlightRanges(text, highlights);
  const plan = [];
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
export function buildSelectionAnchor(selectedText) {
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
export function buildRangeAnchor(text, start, end) {
  const normalized = normalizeLatexText(text);
  if (!normalized) return null;
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(normalized.length, Math.max(start, end));
  const quote = normalized.slice(from, to).trim();
  if (quote.length < MIN_QUOTE_LENGTH) return null;
  return { quote, kind: 'user' };
}

export const HIGHLIGHT_MIN_QUOTE_LENGTH = MIN_QUOTE_LENGTH;
