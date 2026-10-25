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

test('a list deleted while open leaves the position restored and nothing to focus', () => {
  const { log, view } = page(730);
  const index = createIndexReturn(view);
  index.leave('list_2');
  index.arrive(() => null);
  assert.deepEqual(log, ['scroll to 730, instant']);
});
