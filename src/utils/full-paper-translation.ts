import type { Block, FullText, Inline } from './full-text.ts';
import {
  PAPER_TRANSLATION_CHUNK_BYTES,
  PAPER_TRANSLATION_MAX_CHUNKS,
  translationJsonBytes,
  type TranslationLanguage,
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

function replaceProse(content: Inline[], translations: Map<TextInline, string>, language: TranslationLanguage): Inline[] {
  return content.map(item => {
    if (item.t === 'text') {
      const translated = translations.get(item);
      return translated === undefined ? item : { ...item, language, text: item.text.replace(item.text.trim(), () => translated.trim()) };
    }
    if (item.t === 'em' || item.t === 'strong') return { ...item, children: replaceProse(item.children, translations, language) };
    return item;
  });
}

export function applyTranslatedPassages(chunk: Passage[], values: string[], language: TranslationLanguage): Map<Block, Block> {
  let index = 0;
  return new Map<Block, Block>(chunk.map(({ block, slots }) => {
    const translations = new Map(slots.map(slot => [slot, values[index++]] as const));
    if (block.t === 'list') return [block, { ...block, items: block.items.map(item => replaceProse(item, translations, language)) }];
    if (block.t === 'heading' || block.t === 'p') return [block, { ...block, children: replaceProse(block.children, translations, language) }];
    return [block, block];
  }));
}
