import type { Block, FullText, Inline } from './full-text.ts';
import {
  PAPER_TRANSLATION_CHUNK_BYTES,
  PAPER_TRANSLATION_MAX_CHUNKS,
  translationJsonBytes,
} from './full-paper-translation-contract.ts';

type TextInline = Extract<Inline, { t: 'text' }>;
type Passage = { block: Block; slots: TextInline[] };

function prose(content: Inline[]): TextInline[] {
  return content.flatMap(item => {
    if (item.t === 'text') return /\p{L}/u.test(item.text) ? [item] : [];
    if (item.t === 'em' || item.t === 'strong') return prose(item.children);
    return [];
  });
}

function paperPassages(doc: FullText) {
  const passages: Passage[] = [];
  for (const block of [...(doc.title ? [doc.title] : []), ...doc.abstract, ...doc.body]) {
    const slots = block.t === 'list' ? block.items.flatMap(prose)
      : block.t === 'heading' || block.t === 'p' ? prose(block.children) : [];
    if (slots.length) passages.push({ block, slots });
  }
  return passages;
}

export function planFullPaperTranslation(doc: FullText) {
  if (doc.source === 'europepmc' || doc.oversizedForTranslation || doc.conversionErrors > 0) return null;
  const chunks: Passage[][] = [];
  let chunk: Passage[] = [];
  let bytes = 2;
  for (const passage of paperPassages(doc)) {
    const passageBytes = translationJsonBytes(passage.slots.map(slot => slot.text)) - 2;
    if (passageBytes + 2 > PAPER_TRANSLATION_CHUNK_BYTES) return null;
    if (chunk.length && bytes + 1 + passageBytes > PAPER_TRANSLATION_CHUNK_BYTES) {
      chunks.push(chunk);
      if (chunks.length === PAPER_TRANSLATION_MAX_CHUNKS) return null;
      chunk = [];
      bytes = 2;
    }
    if (chunk.length) bytes += 1;
    chunk.push(passage);
    bytes += passageBytes;
  }
  if (chunk.length) chunks.push(chunk);
  const body = new Set(doc.body);
  if (!chunks.some(chunk => chunk.some(({ block }) => body.has(block) && (block.t === 'p' || block.t === 'list')))) return null;
  return {
    source: chunks.map(chunk => chunk.flatMap(({ slots }) => slots.map(slot => slot.text))),
    chunks,
  };
}

function splitEdges(text: string) {
  const chars = [...text];
  const edge = /[\s\p{P}]/u;
  let start = 0;
  let end = chars.length;
  while (start < end && edge.test(chars[start])) start++;
  while (end > start && edge.test(chars[end - 1])) end--;
  return {
    leading: chars.slice(0, start).join(''),
    body: chars.slice(start, end).join(''),
    trailing: chars.slice(end).join(''),
  };
}

export function preserveTranslationEdges(source: string, translation: string) {
  const { leading, trailing } = splitEdges(source);
  const { body } = splitEdges(translation);
  return body ? leading + body + trailing : '';
}
