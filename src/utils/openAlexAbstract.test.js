import test from 'node:test';
import assert from 'node:assert/strict';

import { reconstructOpenAlexAbstract } from './openAlexAbstract.js';

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
