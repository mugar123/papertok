export interface PassageSelection { sectionId: string; quote: string; anchor: DOMRect }

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

export function passageRange(block: Element, quote: string) {
  const nodes = textNodes(block);
  const { text, starts } = joinText(nodes);
  const offsets = quoteOffsets(text, quote);
  if (!offsets) return null;
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
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const block = (start instanceof Element ? start : start.parentElement)?.closest<HTMLElement>('[data-passage]');
  if (!block || !root.contains(block)) return null;
  const clipped = range.cloneRange();
  if (!block.contains(range.endContainer)) clipped.setEnd(block, block.childNodes.length);
  const quote = joinText(textNodes(block).filter(node => clipped.intersectsNode(node)), node => node.data.slice(
    node === clipped.startContainer ? clipped.startOffset : 0,
    node === clipped.endContainer ? clipped.endOffset : undefined,
  )).text.replace(/\s+/g, ' ').trim();
  if (!quote) return null;
  return { sectionId: block.dataset.passage!, quote, anchor: clipped.getBoundingClientRect() };
}

export function blockPassage(block: HTMLElement): PassageSelection | null {
  const quote = joinText(textNodes(block)).text.replace(/\s+/g, ' ').trim();
  if (!quote || !block.dataset.passage) return null;
  return { sectionId: block.dataset.passage, quote, anchor: block.getBoundingClientRect() };
}
