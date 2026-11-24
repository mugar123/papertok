import { MAX_NOTE_LENGTH } from '../../services/user-highlight-service.ts';
/** A selection in the paper's text: its first block, and the block it ends in and the words of it when it runs on. */
export interface PassageSelection { sectionId: string; quote: string; occurrence: number; anchor: DOMRect; context: string; endSectionId?: string; endQuote?: string }

type Anchored = { sectionId: string; quote: string; occurrence?: number; endSectionId?: string; endQuote?: string };

function collapse(text: string) {
  let collapsed = '';
  const origin: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const space = /\s/.test(text[index]);
    if (space && (collapsed.endsWith(' ') || !collapsed)) continue;
    collapsed += space ? ' ' : text[index];
    origin.push(index);
  }
  return { collapsed, origin };
}

export function quoteOffsets(text: string, quote: string, occurrence = 0): [number, number] | null {
  const wanted = quote.replace(/\s+/g, ' ').trim();
  if (!wanted) return null;
  const { collapsed, origin } = collapse(text);
  let at = collapsed.indexOf(wanted);
  for (let seen = 0; seen < occurrence && at >= 0; seen += 1) at = collapsed.indexOf(wanted, at + 1);
  if (at < 0) return null;
  return [origin[at], origin[at + wanted.length - 1] + 1];
}

export function occurrenceBefore(text: string, quote: string, before: number) {
  const wanted = quote.replace(/\s+/g, ' ').trim();
  const { collapsed } = collapse(text);
  const limit = collapse(text.slice(0, before)).collapsed.length;
  let count = 0;
  for (let at = collapsed.indexOf(wanted); at >= 0 && at < limit; at = collapsed.indexOf(wanted, at + 1)) count += 1;
  return count;
}

function textNodes(block: Element) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: node => (node.parentElement?.closest('.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

const newItem = (before: Text | undefined, node: Text) =>
  before !== undefined && before.parentElement?.closest('li') !== node.parentElement?.closest('li');

function joinText(nodes: Text[], piece: (node: Text) => string = node => node.data) {
  let text = '';
  const starts: number[] = [];
  nodes.forEach((node, index) => {
    if (newItem(nodes[index - 1], node)) text += ' ';
    starts.push(text.length);
    text += piece(node);
  });
  return { text, starts };
}

/** The passages among `passages` that share at least one character of `text` with `passage`. */
export function overlapping<T extends { quote: string; occurrence?: number }>(text: string, passage: { quote: string; occurrence?: number }, passages: readonly T[]): T[] {
  const span = quoteOffsets(text, passage.quote, passage.occurrence);
  if (!span) return [];
  return passages.filter((item) => {
    const other = quoteOffsets(text, item.quote, item.occurrence);
    return other !== null && other[0] < span[1] && span[0] < other[1];
  });
}

/**
 * What saving `note` over the reader's own `overlapped` highlights does: it replaces them and
 * keeps their notes after its own. When the notes together would not fit one note, nothing
 * is replaced, so no note is cut short.
 */
export function replacingHighlights<T extends { note?: string | null }>(note: string, overlapped: readonly T[]) {
  const merged = [note, ...overlapped.map(item => item.note)].filter(Boolean).join('\n\n');
  return merged.length <= MAX_NOTE_LENGTH ? { note: merged, replaced: overlapped } : { note, replaced: [] };
}

export const blockText = (block: Element) => joinText(textNodes(block)).text;

export function passageRange(block: Element, quote: string, occurrence = 0) {
  const offsets = quoteOffsets(blockText(block), quote, occurrence);
  return offsets && offsetsRange(block, offsets);
}

/** The DOM range of [start, end) in `blockText(block)`. */
export function offsetsRange(block: Element, offsets: [number, number]) {
  const nodes = textNodes(block);
  const { starts } = joinText(nodes);
  const range = document.createRange();
  for (const [index, node] of nodes.entries()) {
    const seen = starts[index];
    const end = seen + node.data.length;
    if (offsets[0] >= seen && offsets[0] < end) range.setStart(node, offsets[0] - seen);
    if (offsets[1] > seen && offsets[1] <= end) {
      range.setEnd(node, offsets[1] - seen);
      return range;
    }
  }
  return null;
}

export function selectedPassage(root: Element): PassageSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  return passageFromRange(root, selection.getRangeAt(0));
}

const blockOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-passage]') ?? null;

/** The words of `block` that `range` covers, as the block's text shows them. */
function coveredText(block: HTMLElement, range: Range) {
  const picked = textNodes(block).filter(node => range.intersectsNode(node));
  return joinText(picked, node => node.data.slice(
    node === range.startContainer ? range.startOffset : 0,
    node === range.endContainer ? range.endOffset : undefined,
  )).text.replace(/\s+/g, ' ').trim();
}

/**
 * The passage a range covers: the words of the block it starts in and, when it runs into a later
 * block, that block's id and the words of it up to where the range ends (the blocks between are
 * covered whole).
 */
export function passageFromRange(root: Element, range: Range): PassageSelection | null {
  const block = blockOf(range.startContainer);
  if (!block || !root.contains(block)) return null;
  const clipped = range.cloneRange();
  if (!block.contains(range.endContainer)) clipped.setEnd(block, block.childNodes.length);
  const nodes = textNodes(block);
  const picked = nodes.filter(node => clipped.intersectsNode(node));
  const quote = coveredText(block, clipped);
  if (!quote) return null;
  const whole = joinText(nodes);
  const before = whole.starts[nodes.indexOf(picked[0])] + (picked[0] === clipped.startContainer ? clipped.startOffset : 0);
  const passage = { sectionId: block.dataset.passage!, quote, occurrence: occurrenceBefore(whole.text, quote, before), anchor: clipped.getBoundingClientRect(), context: whole.text.replace(/\s+/g, ' ').trim() };
  const last = blockOf(range.endContainer);
  if (!last || last === block || !root.contains(last)) return passage;
  const ending = range.cloneRange();
  ending.setStart(last, 0);
  const endQuote = coveredText(last, ending);
  return endQuote ? { ...passage, endSectionId: last.dataset.passage!, endQuote } : passage;
}

/** The DOM range a saved passage covers: within its block, or from its block into the one it ends in. */
export function annotationRange(root: ParentNode, passage: Anchored) {
  const block = root.querySelector(`[data-passage="${CSS.escape(passage.sectionId)}"]`);
  const start = block && passageRange(block, passage.quote, passage.occurrence);
  if (!start || !passage.endSectionId || !passage.endQuote) return start;
  const last = root.querySelector(`[data-passage="${CSS.escape(passage.endSectionId)}"]`);
  const end = last && passageRange(last, passage.endQuote);
  if (!end) return start;
  const range = document.createRange();
  range.setStart(start.startContainer, start.startOffset);
  range.setEnd(end.endContainer, end.endOffset);
  return range;
}

export function blockPassage(block: HTMLElement): PassageSelection | null {
  const quote = joinText(textNodes(block)).text.replace(/\s+/g, ' ').trim();
  if (!quote || !block.dataset.passage) return null;
  return { sectionId: block.dataset.passage, quote, occurrence: 0, anchor: block.getBoundingClientRect(), context: quote };
}

/**
 * The passage painted under a viewport point, for a click on a highlight. The
 * highlights are painted with the CSS Custom Highlight API, so there is no
 * element to click: the point must fall inside one of the passage range's
 * line boxes, in the block the click landed in.
 */
export function passageAt<T extends Anchored>(target: EventTarget | null, passages: readonly T[], x: number, y: number): T | null {
  // A link or button inside a highlight keeps its own job: a citation, a figure, a new tab.
  if (!(target instanceof Element) || target.closest('a, button')) return null;
  const block = target.closest<HTMLElement>('[data-passage]');
  if (!block) return null;
  // Only the passages that start in this block, or run across blocks, can be under the point.
  return passages.find(passage => (passage.sectionId === block.dataset.passage || passage.endSectionId)
    && [...annotationRange(block.ownerDocument, passage)?.getClientRects() ?? []]
      .some(box => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)) ?? null;
}
