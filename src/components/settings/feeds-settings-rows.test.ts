import test from 'node:test';
import assert from 'node:assert/strict';
import type { CustomFeed } from '../../utils/custom-feeds.ts';
import { feedLimitNote, feedRows, focusAfterMove, liveStatusText, rowAfterDelete } from './feeds-settings-rows.ts';

const thesis: CustomFeed = {
  id: 'thesis01',
  name: 'Thesis',
  order: 'newest',
  ingredients: [
    { kind: 'keyword', query: 'dark matter' },
    { kind: 'author', id: 'A123', label: 'Vera Rubin' },
  ],
};
const lab: CustomFeed = { id: 'labfeed1', name: 'Lab', order: 'best', ingredients: [] };
const reading: CustomFeed = { id: 'reading1', name: 'Reading', order: 'newest', ingredients: [{ kind: 'topic', id: 'T10', label: 'Galaxy formation' }] };

test('each row names the feed it acts on and lists its ingredients in order', () => {
  const [first] = feedRows([thesis, lab]);
  assert.deepEqual(first.names, {
    edit: 'Edit Thesis',
    moveUp: 'Move Thesis up',
    moveDown: 'Move Thesis down',
    delete: 'Delete Thesis',
  });
  assert.equal(first.ingredients, 'dark matter, Vera Rubin');
});

test('a feed without ingredients says so', () => {
  assert.equal(feedRows([lab])[0].ingredients, 'No ingredients yet');
});

test('only the move that stays inside the list is enabled', () => {
  const rows = feedRows([thesis, lab, reading]);
  assert.deepEqual(rows.map(row => [row.canMoveUp, row.canMoveDown]), [
    [false, true],
    [true, true],
    [true, false],
  ]);
  assert.deepEqual([feedRows([lab])[0].canMoveUp, feedRows([lab])[0].canMoveDown], [false, false]);
});

test('the account limit is mentioned only once it is reached', () => {
  assert.equal(feedLimitNote(7), null);
  assert.equal(feedLimitNote(8), '8 of 8 feeds');
});

test('two announcements with the same words still differ in the status line', () => {
  const sentence = 'Moved Thesis to position 1 of 3.';
  assert.notEqual(liveStatusText(sentence, 1), liveStatusText(sentence, 2));
  assert.notEqual(liveStatusText(sentence, 2), liveStatusText(sentence, 3));
  assert.equal(liveStatusText(sentence, 1).trim(), sentence);
  assert.equal(liveStatusText('', 1), '');
});

test('focus stays on the pressed move, or goes to the other one at an end', () => {
  const [top, middle] = feedRows([thesis, lab, reading]);
  assert.equal(focusAfterMove(middle, 'up'), 'up');
  assert.equal(focusAfterMove(top, 'up'), 'down');
  const [, bottom] = feedRows([lab, thesis]);
  assert.equal(focusAfterMove(bottom, 'down'), 'up');
  assert.equal(focusAfterMove(feedRows([lab])[0], 'up'), null);
});

test('once a feed is deleted, focus goes to the row that takes its place, else the one before it, else none', () => {
  assert.equal(rowAfterDelete([thesis, lab, reading], 'thesis01'), 'labfeed1');
  assert.equal(rowAfterDelete([thesis, lab, reading], 'labfeed1'), 'reading1');
  assert.equal(rowAfterDelete([thesis, lab, reading], 'reading1'), 'labfeed1');
  assert.equal(rowAfterDelete([thesis], 'thesis01'), null);
  assert.equal(rowAfterDelete([thesis, lab], 'missing1'), null);
});
