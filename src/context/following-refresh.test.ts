import test from 'node:test';
import assert from 'node:assert/strict';
import { followingRefreshTurns, settleFollowingRefresh } from './following-refresh.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// The provider's state as the handlers change it, with the follows on screen
// that decide whether an answer still applies.
function provider() {
  const state = { follows: 'A', items: [] as string[], error: null as unknown, loading: true, events: [] as string[] };
  const turns = followingRefreshTurns();
  const start = (follows: string, request: Promise<string[]>) => settleFollowingRefresh(request, {
    isCurrent: () => state.follows === follows,
    ownsTurn: turns.take(),
    apply: (items) => { state.items = items; state.events.push(`applied ${follows}`); },
    fail: (error) => { state.error = error; state.events.push(`failed ${follows}`); },
    endLoading: () => { state.loading = false; state.events.push(`ended after ${follows}`); },
  });
  return { state, start };
}

// Reproduced with the real indicator logic: A pending, the follows change, B
// starts, A answers and B fails. A's end said "Papers updated" for B.
test('an older refresh that lands while a newer one is on its way leaves the indicator to the newer one', async () => {
  const { state, start } = provider();
  const a = deferred<string[]>();
  const b = deferred<string[]>();
  const first = start('A', a.promise);
  state.follows = 'B';
  const second = start('B', b.promise);

  a.resolve(['paper-a']);
  await first;
  assert.deepEqual([state.loading, state.items, state.events], [true, [], []], "A's answer is dropped and the spinner stays up for B");

  b.reject(new Error('Worker unreachable'));
  await second;
  assert.deepEqual([state.loading, state.events], [false, ['failed B', 'ended after B']], 'B ends it, with its failure in hand');
});

// The follows went to none, or a fresh cache answers for them: no newer
// refresh starts, so the older one must still end the spinner.
test('an older refresh ends the indicator when no newer refresh started', async () => {
  for (const reason of ['no follow left', 'a fresh cache']) {
    const { state, start } = provider();
    const a = deferred<string[]>();
    const first = start('A', a.promise);
    state.follows = reason;
    a.resolve(['paper-a']);
    await first;
    assert.deepEqual([state.loading, state.items, state.events], [false, [], ['ended after A']], reason);
  }
});

test('the latest refresh applies its answer and ends the indicator', async () => {
  const { state, start } = provider();
  await start('A', Promise.resolve(['paper-a']));
  assert.deepEqual([state.loading, state.items], [false, ['paper-a']]);
});
