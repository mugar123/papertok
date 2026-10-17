import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areaKeyForCategory,
  areaKeyForOpenAlexField,
  areaKeyForPaper,
  areaAccentForPaper,
  areaLabelForPaper,
  openAlexFilterForArea,
} from './areaAccent.js';
import { CATEGORIES } from '../data/categoryTaxonomy.js';

/* One resolution, used by the accent ink, the field label and the watermark
   alike. Computing any of them a second way is how a paper ends up inked as
   one field, labelled as another and stamped with the mark of a third. */

test('an arXiv category resolves exactly, then by prefix', () => {
  assert.equal(areaKeyForCategory('cs.AI'), 'cs');
  assert.equal(areaKeyForCategory('quant-ph'), 'physics');
  // Not listed explicitly, reached by prefix.
  assert.equal(areaKeyForCategory('cs.NE'), 'cs');
});

test('an exact hit outranks a prefix hit, whatever the declaration order', () => {
  // Physics is declared before maths and owns `math-ph`, whose key starts with
  // "math" — so a prefix-first pass painted every number-theory paper physics.
  assert.equal(areaKeyForCategory('math.NT'), 'math');
  assert.equal(areaKeyForCategory('math-ph'), 'physics');
});

test('an OpenAlex field id resolves, by number or by URL', () => {
  assert.equal(areaKeyForOpenAlexField(17), 'cs');
  assert.equal(areaKeyForOpenAlexField('https://openalex.org/fields/26'), 'math');
  assert.equal(areaKeyForOpenAlexField({ id: 'https://openalex.org/fields/31' }), 'physics');
  assert.equal(areaKeyForOpenAlexField(9999), null);
  assert.equal(areaKeyForOpenAlexField(null), null);
});

// OpenAlex files mechanical, aerospace and civil work under Engineering and
// finance under Economics, so by field alone they read as Electrical &
// Electronic Engineering and Economics, and the Explorer's filter for their
// own area never found them.
test('an OpenAlex subfield that belongs elsewhere outranks its field', () => {
  const work = (subfield, field) => ({
    primaryTopic: { subfield: { id: `https://openalex.org/subfields/${subfield}` }, field: { id: `https://openalex.org/fields/${field}` } },
  });
  assert.equal(areaKeyForPaper(work(2210, 22)), 'mech');
  assert.equal(areaKeyForPaper(work(2202, 22)), 'mech');
  assert.equal(areaKeyForPaper(work(2205, 22)), 'civil');
  assert.equal(areaKeyForPaper(work(2208, 22)), 'eess');
  assert.equal(areaKeyForPaper(work(2003, 20)), 'q-fin');
  assert.equal(areaKeyForPaper(work(2002, 20)), 'econ');
  assert.equal(areaKeyForPaper(work(2506, 25)), 'chemeng');
});

// What the Explorer asks OpenAlex for is what its rows are labelled with, and
// no area of the filter sheet goes to OpenAlex unfiltered.
test('every area has an OpenAlex filter built from the tables that label its rows', () => {
  for (const area of Object.keys(CATEGORIES)) {
    assert.ok(openAlexFilterForArea(area), `${area} has no OpenAlex filter`);
  }
  assert.equal(openAlexFilterForArea('cs'), 'primary_topic.field.id:17');
  assert.equal(openAlexFilterForArea('chemeng'), 'primary_topic.field.id:15|25');
  assert.equal(openAlexFilterForArea('mech'), 'primary_topic.subfield.id:2202|2203|2206|2210|2211');
  assert.equal(openAlexFilterForArea('q-fin'), 'primary_topic.subfield.id:2003');
  assert.equal(openAlexFilterForArea('nonsense'), null);
});

/* The bug this file exists to keep fixed: Research's papers carry neither an
   arXiv category nor an OpenAlex field — `categories[0]` is a topic's display
   name — so every one of them used to resolve to nothing and get stamped with
   the physics atom. */
test("a paper known only by its topic's name still finds its branch", () => {
  const cases = [
    ['Wastewater Treatment and Reuse', 'civil'],
    ['Protein Structure and Dynamics', 'bio'],
    ['Interferon and Immune Responses', 'med'],
    ['Natural Language Processing Techniques', 'cs'],
    ['Plasma and Fusion Research', 'physics'],
  ];
  for (const [topic, area] of cases) {
    assert.equal(areaKeyForPaper({ categories: [topic] }), area, topic);
  }
});

test('an arXiv category still wins over the topic name', () => {
  const paper = { primaryCategory: 'math.AG', categories: ['Protein Structure and Dynamics'] };
  assert.equal(areaKeyForPaper(paper), 'math');
});

test('a branch that cannot be worked out resolves to nothing, not to physics', () => {
  for (const paper of [{}, { categories: [] }, { categories: ['General'] }, { primaryCategory: 'Miscellaneous' }]) {
    assert.equal(areaKeyForPaper(paper), null, JSON.stringify(paper));
  }
  // And the ink says so too, rather than picking a field at random.
  assert.equal(areaAccentForPaper({ categories: ['General'] }), 'var(--gradient-brand)');
});

test('the ink and the label come from the same resolution', () => {
  const paper = { categories: ['Wastewater Treatment and Reuse'] };
  assert.equal(areaKeyForPaper(paper), 'civil');
  assert.equal(areaAccentForPaper(paper), 'var(--gradient-civil)');
  assert.equal(areaLabelForPaper(paper, { english: true }), 'Civil & Environmental Engineering');
});
