import test from 'node:test';
import assert from 'node:assert/strict';
import { getAreaKeyFromTopicName, getCategoryGradient } from './categories.js';

/* The twelve field inks are keyed to arXiv's category codes, but most of the
   corpus arrives from OpenAlex as a topic's display name. Every one of those
   used to fall through to the brand ink, so the field accent said the same
   thing about every paper on the page. */

/** Topic names observed in the live app, with the field each belongs to. */
const OBSERVED = [
  ['Interferon and Immune Responses', 'med'],
  ['Neuroscience and Music Perception', 'med'],
  ['Advanced MRI Techniques and Applications', 'med'],
  ['Exercise and Physiological Response', 'med'],
  ['Microtubule and mitosis dynamics', 'bio'],
  ['Cellular Mechanics and Interactions', 'bio'],
  ['Plant Pathogenic Bacteria Studies', 'bio'],
  ['Protein Structure and Dynamics', 'bio'],
  ['Single-Cell and Spatial Transcriptomics', 'bio'],
  ['Mathematics, Computing, and Information Studies', 'math'],
  ['Number Theory', 'math'],
  ['Natural Language Processing Techniques', 'cs'],
  ['Research Data Management', 'cs'],
  ['Scientific Computing and Data', 'cs'],
  ['Plasma and Fusion Research', 'physics'],
  ['Systems and Control', 'eess'],
  ['Wastewater Treatment and Reuse', 'civil'],
];

test('a topic name resolves to the field it belongs to', () => {
  for (const [topic, area] of OBSERVED) {
    assert.equal(getAreaKeyFromTopicName(topic), area, `${topic} should read as ${area}`);
  }
});

test('the longest match wins, so the colour follows the noun and not the modifier', () => {
  // "Cellular" over "Mechanics", "Mathematics" over "Computing".
  assert.equal(getAreaKeyFromTopicName('Cellular Mechanics and Interactions'), 'bio');
  assert.equal(getAreaKeyFromTopicName('Mathematics, Computing, and Information Studies'), 'math');
});

test('a keyword only matches on a word boundary', () => {
  // The reason 'gene' is not a keyword: it would paint every "General" paper
  // as biology, which is most of the corpus.
  assert.equal(getAreaKeyFromTopicName('General'), '');
  assert.equal(getAreaKeyFromTopicName('Genomic instability'), 'bio');
});

test('a topic with nothing distinctive keeps the ink rather than guessing', () => {
  for (const vague of ['General', 'Miscellaneous', 'Social and Behavioural Sciences', '', null, undefined, 42]) {
    assert.equal(getAreaKeyFromTopicName(vague), '', `${vague} should not be given a field`);
  }
});

test('arXiv codes keep resolving exactly as they did', () => {
  assert.equal(getCategoryGradient('cs.AI'), 'var(--gradient-cs)');
  assert.equal(getCategoryGradient('quant-ph'), 'var(--gradient-physics)');
  assert.equal(getCategoryGradient('math.AG'), 'var(--gradient-math)');
});

test('a topic name now reaches a field ink instead of the brand fallback', () => {
  assert.equal(getCategoryGradient('Wastewater Treatment and Reuse'), 'var(--gradient-civil)');
  assert.equal(getCategoryGradient('Protein Structure and Dynamics'), 'var(--gradient-bio)');
  // And what genuinely has no field still gets the ink.
  assert.equal(getCategoryGradient('General'), 'var(--gradient-brand)');
});

test('the observed topics do not all collapse onto one colour', () => {
  const inks = new Set(OBSERVED.map(([topic]) => getCategoryGradient(topic)));
  assert.ok(inks.size >= 6, `only ${inks.size} distinct field inks across the observed topics`);
  assert.equal(inks.has('var(--gradient-brand)'), false);
});
