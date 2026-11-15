/**
 * Where a highlight sits in the paper's own text. A block of that text carries
 * `data-passage` (`a3`, `b12`); a highlight is that key plus the words selected
 * in it, compared with runs of whitespace collapsed, so the line breaks a
 * selection picks up do not stop it from being found again.
 */
export interface PassageSelection { sectionId: string; quote: string; anchor: DOMRect }

/** Where `quote` starts and ends in `text`, ignoring differences in whitespace. */
export function quoteOffsets(text: string, quote: string): [number, number] | null {
  const wanted = quote.replace(/\s+/g, ' ').trim();
  if (!wanted) return null;
  let collapsed = '';
  const origin: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const space = /\s/.test(text[index]);
    if (space && (collapsed.endsWith(' ') || !collapsed)) continue;
    collapsed += space ? ' ' : text[index];
    origin.push(index);
  }
  const at = collapsed.indexOf(wanted);
  if (at < 0) return null;
  return [origin[at], origin[at + wanted.length - 1] + 1];
}

/** The text a reader sees: KaTeX keeps a hidden MathML copy of each formula beside the one it draws. */
function textNodes(block: Element) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: node => (node.parentElement?.closest('.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

/** The range of `quote` inside `block`, or null when the words are no longer there. */
export function passageRange(block: Element, quote: string) {
  const nodes = textNodes(block);
  const offsets = quoteOffsets(nodes.map(node => node.data).join(''), quote);
  if (!offsets) return null;
  const range = document.createRange();
  let seen = 0;
  for (const node of nodes) {
    const end = seen + node.data.length;
    if (offsets[0] >= seen && offsets[0] < end) range.setStart(node, offsets[0] - seen);
    if (offsets[1] > seen && offsets[1] <= end) {
      range.setEnd(node, offsets[1] - seen);
      return range;
    }
    seen = end;
  }
  return null;
}

/**
 * The current selection as a passage of one block. A selection that runs past
 * the block it started in is cut at that block's end: a highlight is stored
 * per block.
 */
export function selectedPassage(root: Element): PassageSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const block = (start instanceof Element ? start : start.parentElement)?.closest<HTMLElement>('[data-passage]');
  if (!block || !root.contains(block)) return null;
  const clipped = range.cloneRange();
  if (!block.contains(range.endContainer)) clipped.setEnd(block, block.childNodes.length);
  const quote = textNodes(block)
    .filter(node => clipped.intersectsNode(node))
    .map(node => node.data.slice(
      node === clipped.startContainer ? clipped.startOffset : 0,
      node === clipped.endContainer ? clipped.endOffset : undefined,
    ))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!quote) return null;
  return { sectionId: block.dataset.passage!, quote, anchor: clipped.getBoundingClientRect() };
}

/** A whole block as a passage: the keyboard's unit, since plain text gives a keyboard no caret to select with. */
export function blockPassage(block: HTMLElement): PassageSelection | null {
  const quote = textNodes(block).map(node => node.data).join('').replace(/\s+/g, ' ').trim();
  if (!quote || !block.dataset.passage) return null;
  return { sectionId: block.dataset.passage, quote, anchor: block.getBoundingClientRect() };
}
