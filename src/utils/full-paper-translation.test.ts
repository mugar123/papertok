import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom/worker';
import { parseArxivHtml } from './full-text.ts';
import type { Block, FullText, Inline } from './full-text.ts';
import { RTL_TRANSLATION_LANGUAGES, TRANSLATION_LANGUAGES, translatedChunkLimits } from './full-paper-translation-contract.ts';
import { planFullPaperTranslation, preserveTranslationEdges } from './full-paper-translation.ts';

const formula: Inline = { t: 'math', tex: 'x^2', mathml: '' };
const code: Inline = { t: 'code', children: [{ t: 'text', text: 'x = 1' }] };
const citation: Inline = { t: 'ref', target: 'B1', cites: true, children: [{ t: 'text', text: '[1]' }] };
const citationOpen: Inline = { t: 'text', text: '[' };
const citationClose: Inline = { t: 'text', text: '].' };
const paragraph: Block = { t: 'p', children: [{ t: 'text', text: 'The value is ' }, formula, code, citationOpen, citation, citationClose] };
const doc: FullText = {
  source: 'arxiv', sourceUrl: 'https://arxiv.org/html/1706.03762',
  title: { t: 'heading', level: 1, children: [{ t: 'text', text: 'A model of sequences' }] },
  abstract: [{ t: 'p', children: [{ t: 'text', text: 'An abstract.' }] }],
  body: [
    { t: 'heading', level: 2, id: 's1', children: [{ t: 'text', text: 'Introduction' }] },
    paragraph,
    { t: 'table', rows: [], caption: [{ t: 'text', text: 'Untouched table' }] },
    { t: 'figure', images: [], caption: [{ t: 'text', text: 'Untouched figure' }] },
    { t: 'heading', level: 2, id: 's2', children: [{ t: 'text', text: 'Results' }] },
  ],
  notes: [], references: [], conversionErrors: 0,
};

test('packs consecutive sections and preserves formula, code and citation punctuation', () => {
  const plan = planFullPaperTranslation(doc);
  assert.ok(plan);
  assert.deepEqual(plan.source, [['A model of sequences', 'An abstract.', 'Introduction', 'The value is ', 'Results']]);
  const planned = plan.chunks[0].find(passage => passage.block === paragraph);
  assert.deepEqual(planned?.slots, [paragraph.children[0]]);
  assert.equal(plan.chunks[0].some(({ block }) => block === doc.body[2] || block === doc.body[3]), false);
});

test('keeps original edges and glues a closing bracket in RTL output', () => {
  assert.equal(preserveTranslationEdges('  [Finding]. ', '  (نتيجة )، '), '  [نتيجة]. ');
  assert.equal(preserveTranslationEdges('after the citation)', 'après la citation )'), 'après la citation)');
  assert.equal(preserveTranslationEdges('Text.', ' ... '), '');
  assert.equal(preserveTranslationEdges('The change was -5%.', '-5 % correspond au changement.'), '-5 % correspond au changement.');
  assert.equal(preserveTranslationEdges('.5 mm thick, as in', '.5 mm d’épaisseur, comme dans'), '.5 mm d’épaisseur, comme dans');
  assert.equal(preserveTranslationEdges('Wait…', 'Attendez...'), 'Attendez…');
  assert.equal(preserveTranslationEdges('Wait...', 'Attendez…'), 'Attendez...');
  for (const punctuationOnly of [' … ', ' — ', ' † ']) assert.equal(preserveTranslationEdges('Text.', punctuationOnly), '');
  assert.equal(preserveTranslationEdges('the ’90s.', '’90s.'), '’90s.');
  assert.equal(preserveTranslationEdges('Text.', '.٥ mm'), '.٥ mm.');
  assert.equal(preserveTranslationEdges('by the authors’ ', 'par les auteurs’ '), 'par les auteurs’ ');
  assert.equal(preserveTranslationEdges('Text.', '‘mot’'), 'mot.');
  assert.equal(preserveTranslationEdges('‘word’', 'mot'), '‘mot’');
  assert.equal(preserveTranslationEdges('We used the ‘baseline’ from the authors’ ', 'Nous avons utilisé la « référence » issue de leur '),
    'Nous avons utilisé la « référence » issue de leur ');
  assert.equal(preserveTranslationEdges('‘the model’s prediction’ ', 'la prédiction du modèle '), '‘la prédiction du modèle’ ');
  assert.equal(preserveTranslationEdges('‘word’', '‘l’avis’'), '‘l’avis’');
  assert.equal(preserveTranslationEdges('Text.', '‘l’avis’'), 'l’avis.');
  assert.equal(preserveTranslationEdges('Infinity', '∞'), '∞');
  assert.deepEqual([...RTL_TRANSLATION_LANGUAGES].sort(), ['ar', 'fa', 'he', 'ur']);
  assert.equal(RTL_TRANSLATION_LANGUAGES.has('ja'), false);
});

test('a document outside the pilot or too large is refused whole', () => {
  assert.equal(planFullPaperTranslation({ ...doc, source: 'europepmc' }), null);
  assert.equal(planFullPaperTranslation({ ...doc, body: [] }), null);
  assert.equal(planFullPaperTranslation({ ...doc, conversionErrors: 1 }), null);
  assert.equal(planFullPaperTranslation({ ...doc, body: [{ t: 'p', children: [{ t: 'text', text: 'é'.repeat(3_000) }] }] }), null);
  const paragraphs = Array.from({ length: 17 }, (): Block => ({
    t: 'p', children: [{ t: 'text', text: 'A'.repeat(5_990) }],
  }));
  assert.equal(planFullPaperTranslation({ ...doc, title: undefined, abstract: [], body: paragraphs.slice(0, 16) })?.chunks.length, 16);
  assert.equal(planFullPaperTranslation({ ...doc, title: undefined, abstract: [], body: paragraphs }), null);
});

test('fits the captured arXiv heading hierarchy into one packed chunk', async () => {
  const html = await readFile(new URL('./arxiv-attention-headings.fixture.html', import.meta.url), 'utf8');
  const parsed = parseArxivHtml(html, 'https://arxiv.org/html/1706.03762', source => parseHTML(source).document);
  assert.ok(parsed);
  assert.equal(parsed.body.filter(block => block.t === 'heading').length, 28);
  const plan = planFullPaperTranslation(parsed);
  assert.ok(plan);
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.source[0].at(-1), 'The model combines attention with a feed-forward network.');
});

test('every supported target outside the Latin script gets the larger output limit', () => {
  const extended = Object.keys(TRANSLATION_LANGUAGES)
    .filter(language => translatedChunkLimits(language as keyof typeof TRANSLATION_LANGUAGES).tokens === 14_000)
    .sort();
  assert.deepEqual(extended, ['ar', 'bn', 'fa', 'he', 'hi', 'ja', 'ko', 'ru', 'uk', 'ur', 'zh-Hans', 'zh-Hant']);
});
