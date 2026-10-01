import test from 'node:test';
import assert from 'node:assert/strict';
import { getAreaKeyFromTopicName } from './categories.js';

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
