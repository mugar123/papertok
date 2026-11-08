import test from 'node:test';
import assert from 'node:assert/strict';
import { focusMovedOut, rowHasLeft, rowsTakingFocus } from './rows-taking-focus.ts';

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

test('a row that comes back, at the end of the list, still names the row that took its place', () => {
  // Liked again on its card: Favorites adds it last, and the card hands focus
  // to the row at the reader's place rather than to the far end of the list.
  const left = rowsTakingFocus(none, ['a', 'b', 'c', 'd'], ['a', 'c', 'd'], anyRow);
  const back = rowsTakingFocus(left, ['a', 'c', 'd'], ['a', 'c', 'd', 'b'], anyRow);
  assert.equal(back.get('b'), 'c');
});

test('an overlay whose row left while it was open hands focus to the row that took over', () => {
  // The desktop Edit window: Save unticks Read later, the row leaves, and the
  // window closes afterwards.
  const takers = rowsTakingFocus(none, ['a', 'b', 'c'], ['a', 'c'], anyRow);
  const shown = { listId: '__read_later__', paperIds: ['a', 'c'] };
  assert.equal(rowHasLeft({ listId: '__read_later__', paperId: 'b' }, shown, takers), true);
  assert.equal(takers.get('b'), 'c');
});

test('an overlay whose row is still there, came back or belongs to another list returns focus to its opener', () => {
  const takers = rowsTakingFocus(none, ['a', 'b', 'c'], ['a', 'c'], anyRow);
  assert.equal(rowHasLeft({ listId: 'list_1', paperId: 'a' }, { listId: 'list_1', paperIds: ['a', 'c'] }, takers), false);
  assert.equal(rowHasLeft({ listId: 'list_1', paperId: 'b' }, { listId: 'list_1', paperIds: ['a', 'b', 'c'] }, takers), false);
  assert.equal(rowHasLeft({ listId: 'list_1', paperId: 'b' }, { listId: 'list_2', paperIds: ['a', 'c'] }, takers), false);
  assert.equal(rowHasLeft(null, { listId: 'list_1', paperIds: ['a', 'c'] }, takers), false);
});

test('a closing overlay leaves focus where the reader moved it, out of the overlay', () => {
  // The phone row sheet is closing when the reader taps Search.
  const sheet = { contains: (node: string) => node === 'cancel' || node === 'remove' };
  assert.equal(focusMovedOut('search input', 'body', sheet), true);
  assert.equal(focusMovedOut('another row', 'body', sheet), true);
  // Without the overlay element, as Base UI does without its popup.
  assert.equal(focusMovedOut('cancel', 'body', null), true);
  assert.equal(focusMovedOut('body', 'body', null), false);
});

test('a closing overlay still hands focus over from inside it or from the page body', () => {
  const sheet = { contains: (node: string) => node === 'cancel' || node === 'remove' };
  assert.equal(focusMovedOut('cancel', 'body', sheet), false);
  // A press on the backdrop, or the focused control leaving, puts focus on the body.
  assert.equal(focusMovedOut('body', 'body', sheet), false);
  assert.equal(focusMovedOut(null, 'body', sheet), false);
});
