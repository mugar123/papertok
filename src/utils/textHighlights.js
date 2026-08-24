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
 * 2. A highlight must never cross a maths chunk. Wrapping part of a `$...$`
 *    expression in a `<mark>` would hand KaTeX a broken fragment, so ranges are
 *    clipped to text chunks and the maths is left untouched.
 */

/** Shorter than this and a quote matches the wrong place too easily. */
const MIN_QUOTE_LENGTH = 8;

export function normalizeHighlightQuote(quote) {
  return normalizeLatexText(quote);
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

    // Prefer the first occurrence that is not already highlighted, so repeated
    // phrasing marks each mention rather than piling onto the first.
    let searchFrom = 0;
    let start = -1;
    for (;;) {
      const candidate = normalized.indexOf(quote, searchFrom);
      if (candidate === -1) break;
      const end = candidate + quote.length;
      const overlaps = ranges.some(range => candidate < range.end && end > range.start);
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
      source: highlight?.source || 'ai',
      id: highlight?.id || null,
    });
  }

  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Cuts one text chunk into plain and marked segments.
 * `chunkStart` is the chunk's offset within the normalized text.
 */
export function segmentTextChunk(chunkStart, value, ranges) {
  const chunkEnd = chunkStart + value.length;
  const overlapping = ranges
    .filter(range => range.start < chunkEnd && range.end > chunkStart)
    .sort((a, b) => a.start - b.start);
  if (overlapping.length === 0) return [{ type: 'text', value }];

  const segments = [];
  let cursor = chunkStart;
  for (const range of overlapping) {
    // Clip to the chunk: a range spanning maths is split across the text
    // chunks on either side, and the maths between them stays intact.
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, chunkEnd);
    if (end <= start) continue;
    if (start > cursor) {
      segments.push({ type: 'text', value: value.slice(cursor - chunkStart, start - chunkStart) });
    }
    segments.push({
      type: 'mark',
      value: value.slice(start - chunkStart, end - chunkStart),
      kind: range.kind,
      source: range.source,
      id: range.id,
    });
    cursor = end;
  }
  if (cursor < chunkEnd) {
    segments.push({ type: 'text', value: value.slice(cursor - chunkStart) });
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
    plan.push({ type: 'math', value: chunk.value, raw: chunk.raw, display: chunk.display });
    offset += chunk.raw.length;
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

export const HIGHLIGHT_MIN_QUOTE_LENGTH = MIN_QUOTE_LENGTH;
