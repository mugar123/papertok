import test from 'node:test';
import assert from 'node:assert/strict';

import { reconstructOpenAlexAbstract, usableOpenAlexAbstract } from './openAlexAbstract.js';

// Builds an inverted index from plain text, the way OpenAlex stores it.
function invertedIndexOf(text) {
  const index = {};
  text.split(' ').forEach((word, position) => {
    (index[word] ||= []).push(position);
  });
  return index;
}

const ARTICLE_ABSTRACT = 'We measured serum markers in 120 patients with chronic heart failure and found higher levels in severe cases.';

test('an article keeps the abstract OpenAlex rebuilds for it', () => {
  assert.equal(
    usableOpenAlexAbstract({ type: 'article', abstract_inverted_index: invertedIndexOf(ARTICLE_ABSTRACT) }),
    ARTICLE_ABSTRACT,
  );
});

// W7211952859 is the editorial behind PMID 42774036: OpenAlex indexes its whole
// text as the "abstract", with the paragraph breaks lost ("response.A
// particularly"), and the card showed 9137 characters of it (audit 2026-09-23).
test('an editorial, a letter, an erratum or front matter has no abstract to take', () => {
  const fullText = invertedIndexOf('the therapeutic response.A particularly important finding of this collection is that tumour cells adapt.');
  for (const type of ['editorial', 'letter', 'erratum', 'paratext']) {
    assert.equal(usableOpenAlexAbstract({ type, abstract_inverted_index: fullText }), '', type);
  }
});

test('text too long to be an abstract, or too short to be one, is not an abstract', () => {
  const tooLong = invertedIndexOf(Array.from({ length: 1300 }, (_, i) => `word${i}`).join(' '));
  assert.equal(reconstructOpenAlexAbstract(tooLong).length > 6000, true);
  assert.equal(usableOpenAlexAbstract({ type: 'article', abstract_inverted_index: tooLong }), '');
  assert.equal(usableOpenAlexAbstract({ type: 'article', abstract_inverted_index: invertedIndexOf('Lettre') }), '');
  assert.equal(usableOpenAlexAbstract({ type: 'article', abstract_inverted_index: invertedIndexOf('in volume 57, e8.') }), '');
});

test('a work with no index, or no work, has no abstract', () => {
  assert.equal(usableOpenAlexAbstract({ type: 'article' }), '');
  assert.equal(usableOpenAlexAbstract(null), '');
});

test('rebuilds the abstract in position order, not in key order', () => {
  assert.equal(
    reconstructOpenAlexAbstract({ world: [1], Hello: [0], again: [3], world2: [] , '!': [2] }),
    'Hello world ! again',
  );
});

test('places a word that repeats at each of its positions', () => {
  assert.equal(
    reconstructOpenAlexAbstract({ the: [0, 2], cat: [1], hat: [3] }),
    'the cat the hat',
  );
});

test('collapses the gap a missing position leaves instead of doubling the space', () => {
  // The sparse array leaves a hole at 2, which `join` renders as two spaces.
  assert.equal(reconstructOpenAlexAbstract({ a: [0], b: [1], d: [3] }), 'a b d');
});

test('returns an empty string when there is nothing to rebuild', () => {
  // The caller supplies its own placeholder, because they differ by locale.
  assert.equal(reconstructOpenAlexAbstract(null), '');
  assert.equal(reconstructOpenAlexAbstract(undefined), '');
  assert.equal(reconstructOpenAlexAbstract({}), '');
  assert.equal(reconstructOpenAlexAbstract('not an index'), '');
});

test('ignores malformed positions rather than producing holes or crashing', () => {
  assert.equal(
    reconstructOpenAlexAbstract({ good: [0], bad: 'nope', worse: [-1], odd: [null], last: [1] }),
    'good last',
  );
});
