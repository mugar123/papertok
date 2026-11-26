import assert from 'node:assert/strict';
import test from 'node:test';
import { linkedListNeedsRead, linkedListView } from './linked-list.ts';

const LIST = 'list_0a1b2c3d4e5f60718293a4b5';

test('an address that names no list leaves the page its index', () => {
  for (const loading of [true, false]) {
    assert.equal(linkedListView({ listId: undefined, held: false, loading, answer: null }), 'none');
  }
});

test('a list the page holds opens, whatever else is still loading', () => {
  for (const loading of [true, false]) {
    assert.equal(linkedListView({ listId: LIST, held: true, loading, answer: null }), 'open');
  }
  // The page's own three lists are held, though a list document cannot have their names.
  assert.equal(linkedListView({ listId: '__favorites__', held: true, loading: false, answer: null }), 'open');
});

test('a list the page does not hold is asked for by itself before it is called missing', () => {
  // While the lists load, the page waits for them and asks nothing more.
  const loading = linkedListView({ listId: LIST, held: false, loading: true, answer: null });
  assert.equal(loading, 'waiting');
  assert.equal(linkedListNeedsRead(loading, true), false);
  // They ended without it, as for a list made a second ago: the page still waits, and asks for the list.
  const ended = linkedListView({ listId: LIST, held: false, loading: false, answer: null });
  assert.equal(ended, 'waiting');
  assert.equal(linkedListNeedsRead(ended, false), true);
  // The answer ends the wait either way, and nothing more is asked.
  for (const [answer, view] of [['missing', 'missing'], ['failed', 'unavailable']] as const) {
    assert.equal(linkedListView({ listId: LIST, held: false, loading: false, answer }), view);
    assert.equal(linkedListNeedsRead(view, false), false);
  }
  // "Try again" loads the lists once more, and the page waits again.
  assert.equal(linkedListView({ listId: LIST, held: false, loading: true, answer: 'failed' }), 'waiting');
});

test('an address that cannot name a list is missing without a read', () => {
  for (const listId of ['', '.', '..', 'a/b', '__name__', 'x'.repeat(161)]) {
    const view = linkedListView({ listId, held: false, loading: false, answer: null });
    assert.equal(view, 'missing', listId);
    assert.equal(linkedListNeedsRead(view, false), false, listId);
  }
});
