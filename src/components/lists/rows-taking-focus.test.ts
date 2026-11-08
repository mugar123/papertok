import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsTakingFocus } from './rows-taking-focus.ts';

const none: ReadonlyMap<string, string | null> = new Map();
const anyRow = () => true;

test('a removed row hands focus to the row after it', () => {
  const takers = rowsTakingFocus(none, ['a', 'b', 'c'], ['a', 'c'], anyRow);
  assert.deepEqual([...takers], [['b', 'c']]);
});

test('the last row hands focus to the row before it', () => {
  const takers = rowsTakingFocus(none, ['a', 'b', 'c'], ['a', 'b'], anyRow);
  assert.deepEqual([...takers], [['c', 'b']]);
});

test('the only row hands focus to the list heading', () => {
  const takers = rowsTakingFocus(none, ['a'], [], anyRow);
  assert.deepEqual([...takers], [['a', null]]);
});

test('rows still loading their details, which have no control, are passed over', () => {
  const loaded = (paperId: string) => paperId !== 'c' && paperId !== 'a';
  assert.deepEqual([...rowsTakingFocus(none, ['a', 'b', 'c', 'd'], ['a', 'c', 'd'], loaded)], [['b', 'd']]);
  assert.deepEqual([...rowsTakingFocus(none, ['a', 'b', 'c'], ['a', 'c'], loaded)], [['b', null]]);
});

test('rows leaving together all hand focus to the first row after them that stays', () => {
  const takers = rowsTakingFocus(none, ['a', 'b', 'c', 'd'], ['a', 'd'], anyRow);
  assert.deepEqual([...takers], [['b', 'd'], ['c', 'd']]);
});

test('a row whose successor leaves later passes focus to that successor\'s successor', () => {
  // A phone sheet stays open on a row that has left; when it closes, the row
  // that took over may have left too.
  const first = rowsTakingFocus(none, ['a', 'b', 'c'], ['a', 'c'], anyRow);
  const second = rowsTakingFocus(first, ['a', 'c'], ['a'], anyRow);
  assert.equal(second.get('b'), 'a');
  assert.equal(second.get('c'), 'a');
  const third = rowsTakingFocus(second, ['a'], [], anyRow);
  assert.equal(third.get('b'), null);
});

test('nothing changes when no row left', () => {
  const takers = rowsTakingFocus(none, ['a', 'b'], ['a', 'b', 'c'], anyRow);
  assert.equal(takers, none);
});
