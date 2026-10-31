import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexReturn } from './lists-index-return.ts';

// A window and list names that write what is done to them into one log, in order.
function page(scrollY: number) {
  const log: string[] = [];
  const view = {
    scrollY,
    scrollTo: (options: { top: number; behavior: 'instant' }) => { log.push(`scroll to ${options.top}, ${options.behavior}`); },
  };
  const name = (listId: string) => ({
    scrollIntoView: (options: { block: 'nearest'; behavior: 'instant' }) => { log.push(`${listId} into sight, ${options.block}, ${options.behavior}`); },
    focus: (options: { preventScroll: true }) => { log.push(`${listId} focus, preventScroll ${options.preventScroll}`); },
  });
  return { log, view, name };
}

test('closing a list puts the index back where it was when the list opened, on that list', () => {
  const { log, view, name } = page(730);
  const index = createIndexReturn(view);
  index.leave('list_2');
  view.scrollY = 0; // the open list is at the top of the page
  index.arrive((listId) => name(listId));
  assert.deepEqual(log, [
    'scroll to 730, instant',
    'list_2 into sight, nearest, instant',
    'list_2 focus, preventScroll true',
  ]);
});

test('the position is spent by the first return, and the latest open is the one returned to', () => {
  const { log, view, name } = page(100);
  const index = createIndexReturn(view);
  index.leave('list_1');
  view.scrollY = 400;
  index.leave('list_3'); // the first open never reached its index
  index.arrive((listId) => name(listId));
  assert.deepEqual(log, ['scroll to 400, instant', 'list_3 into sight, nearest, instant', 'list_3 focus, preventScroll true']);
  log.length = 0;
  index.arrive((listId) => name(listId)); // the index mounting again later
  assert.deepEqual(log, []);
});

test('an index that no open came from stays where the page puts it', () => {
  // A list reopened on the way back from a paper, or on a fresh visit.
  const { log, view, name } = page(500);
  createIndexReturn(view).arrive((listId) => name(listId));
  assert.deepEqual(log, []);
});

test('a paper opened from the list takes the position along, and closing the reopened list returns to it', () => {
  // Opening a paper unmounts the page: the page that reopens the list is a new one.
  const first = page(3611);
  const leaving = createIndexReturn(first.view);
  leaving.leave('list_13');
  first.view.scrollY = 0;
  const carried = leaving.top();
  assert.equal(carried, 3611);

  const second = page(0);
  const returning = createIndexReturn(second.view);
  returning.resume('list_13', carried);
  returning.arrive((listId) => second.name(listId));
  assert.deepEqual(second.log, [
    'scroll to 3611, instant',
    'list_13 into sight, nearest, instant',
    'list_13 focus, preventScroll true',
  ]);
});

test('a position that was never recorded, or comes back damaged, is not returned to', () => {
  const { log, view, name } = page(500);
  const index = createIndexReturn(view);
  assert.equal(index.top(), null);
  for (const carried of [undefined, null, '730', Number.NaN, Number.POSITIVE_INFINITY, -1, {}]) {
    index.resume('list_2', carried);
    index.arrive((listId) => name(listId));
  }
  assert.deepEqual(log, []);
  index.resume('list_2', 0); // the top of the index is a position, unlike a missing one
  index.arrive((listId) => name(listId));
  assert.deepEqual(log, ['scroll to 0, instant', 'list_2 into sight, nearest, instant', 'list_2 focus, preventScroll true']);
});

test('a list deleted while open leaves the position restored and nothing to focus', () => {
  const { log, view } = page(730);
  const index = createIndexReturn(view);
  index.leave('list_2');
  index.arrive(() => null);
  assert.deepEqual(log, ['scroll to 730, instant']);
});
