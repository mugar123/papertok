import test from 'node:test';
import assert from 'node:assert/strict';
import { focusMovedOut, rowAfterOverlay, rowsTakingFocus } from './rows-taking-focus.ts';

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

test('an overlay whose row left while it was open hands focus to the row now at its place', () => {
  // The remove dialog, or the desktop Edit window when Save unticks Read later.
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c'], ['a', 'c'], anyRow), 'c');
  assert.equal(rowAfterOverlay('c', ['a', 'b', 'c'], ['a', 'b'], anyRow), 'b');
  assert.equal(rowAfterOverlay('a', ['a'], [], anyRow), null);
});

test('an overlay whose row keeps its place returns focus to that row', () => {
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c'], ['a', 'b', 'c'], anyRow), 'b');
  // Rows around it left or arrived from another device.
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c'], ['b'], anyRow), 'b');
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c'], ['x', 'a', 'b', 'c', 'y'], anyRow), 'b');
  // The only row, unliked and liked again on its card.
  assert.equal(rowAfterOverlay('a', ['a'], ['a'], anyRow), 'a');
});

test('a row that came back elsewhere while its card was open gives focus to the row now at its place', () => {
  // Favorites adds a paper liked again last; Reading history puts it first.
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'b'], anyRow), 'c');
  assert.equal(rowAfterOverlay('c', ['a', 'b', 'c', 'd'], ['c', 'a', 'b', 'd'], anyRow), 'd');
  // Last in Favorites, it comes back where it was; first in Reading history too.
  assert.equal(rowAfterOverlay('d', ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], anyRow), 'd');
  assert.equal(rowAfterOverlay('a', ['a', 'b', 'c'], ['a', 'b', 'c'], anyRow), 'a');
  // Unliked, liked and unliked again: gone, and the place is still the same.
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c', 'd'], ['a', 'c', 'd'], anyRow), 'c');
});

test('an overlay whose row left passes over rows without a control and rows that left too', () => {
  const loaded = (paperId: string) => paperId !== 'c';
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c', 'd'], ['a', 'c', 'd'], loaded), 'd');
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c', 'd'], ['a', 'd'], anyRow), 'd');
  // No other row has a control yet: the row itself, still shown elsewhere.
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c'], ['a', 'c', 'b'], (paperId) => paperId === 'b'), 'b');
  assert.equal(rowAfterOverlay('b', ['a', 'b', 'c'], ['a', 'c'], (paperId) => paperId === 'b'), null);
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
