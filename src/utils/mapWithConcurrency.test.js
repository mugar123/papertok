import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mapWithConcurrency } from './mapWithConcurrency.js';

/**
 * The guard on the fan-out that grows with an account.
 *
 * The reading library issues one `in` query per ten paper ids, and the id set
 * is capped at PERSONAL_LIBRARY_MAX_RECORDS = 600 — so a full library is 60
 * Firestore reads. `Promise.all` started all sixty at once on the single
 * WebChannel the app has, and the reads belonging to the screen that asked for
 * the library queued behind them.
 *
 * A ceiling on a burst is only a ceiling if something fails when it is removed,
 * so these tests fail if the pool stops bounding, and the structural one fails
 * if the library read goes back to an unbounded `Promise.all`.
 */

function tracker() {
  const state = { inFlight: 0, peak: 0, order: [] };
  return {
    state,
    task: async (item) => {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      state.order.push(item);
      await new Promise(resolve => setTimeout(resolve, 5));
      state.inFlight -= 1;
      return item * 2;
    },
  };
}

test('THE LEAK GUARD: the burst never exceeds the ceiling', async () => {
  const items = Array.from({ length: 60 }, (_, index) => index);
  const { state, task } = tracker();

  await mapWithConcurrency(items, 6, task);

  assert.ok(
    state.peak <= 6,
    `sixty batches ran ${state.peak} at a time; the ceiling is 6. `
    + 'An unbounded Promise.all would report 60 here.',
  );
  assert.ok(state.peak > 1, 'and it must actually run in parallel, not one at a time');
});

test('every item runs, and results keep input order', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  const { state, task } = tracker();

  const results = await mapWithConcurrency(items, 3, task);

  assert.equal(results.length, items.length);
  assert.deepEqual(state.order.slice().sort((a, b) => a - b), items);
  assert.deepEqual(results.map(r => r.value), [2, 4, 6, 8, 10, 12, 14]);
});

test('one failure cannot abandon the workers still running', async () => {
  const items = [0, 1, 2, 3, 4, 5];
  let completed = 0;

  const results = await mapWithConcurrency(items, 2, async (item) => {
    if (item === 1) throw new Error('batch denied');
    await new Promise(resolve => setTimeout(resolve, 5));
    completed += 1;
    return item;
  });

  assert.equal(completed, 5, 'the other five batches still finished');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.message, 'batch denied');
  assert.equal(results[0].status, 'fulfilled');
});

test('an empty list spawns no workers and a ceiling below one still runs', async () => {
  assert.deepEqual(await mapWithConcurrency([], 6, async () => 'never'), []);
  const results = await mapWithConcurrency([1, 2], 0, async (item) => item);
  assert.deepEqual(results.map(r => r.value), [1, 2], 'a zero ceiling must not deadlock');
});

test('STRUCTURAL: the library read fans out through the bounded pool', async () => {
  const source = await readFile(new URL('../services/interactionProfileStore.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function fetchLibraryRecords'));

  assert.ok(
    body.includes('mapWithConcurrency(batches, LIBRARY_READ_CONCURRENCY'),
    'fetchLibraryRecords must run its batches through the bounded pool',
  );
  assert.ok(
    !/Promise\.all\(\s*batches/.test(body),
    'and must not go back to starting every batch at once',
  );
});
