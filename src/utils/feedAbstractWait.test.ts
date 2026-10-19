import test from 'node:test';
import assert from 'node:assert/strict';
import { abstractWaitIds, openAbstractWait, type AbstractWaits } from './feedAbstractWait.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));

function waits() {
  let current: AbstractWaits = [];
  return {
    set: (update: (value: AbstractWaits) => AbstractWaits) => { current = update(current); },
    loading: () => [...abstractWaitIds(current)],
  };
}

function pending() {
  let settle!: () => void;
  const promise = new Promise<void>(resolve => { settle = resolve; });
  return { promise, settle };
}

test('cards stay loading, and can receive text, until every source of their wait settles', async () => {
  const state = waits();
  const source = pending();
  const fillable = openAbstractWait(state.set, new Set(['a', 'b']), [Promise.resolve(), source.promise]);
  await flush();
  assert.deepEqual(state.loading(), ['a', 'b']);
  assert.deepEqual([...fillable()], ['a', 'b']);
  source.settle();
  await flush();
  assert.deepEqual(state.loading(), []);
  assert.deepEqual([...fillable()], []);
});

test('a source that never answers ends the wait at its bound, and text after that cannot fill the card', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = waits();
  const fillable = openAbstractWait(state.set, new Set(['stalled']), [new Promise(() => {})]);
  assert.deepEqual(state.loading(), ['stalled']);
  t.mock.timers.tick(60_000);
  await flush();
  assert.deepEqual(state.loading(), []);
  assert.deepEqual([...fillable()], []);
});

test('overlapping waits close independently, and a wait without cards changes nothing', async () => {
  const state = waits();
  const first = pending();
  const second = pending();
  openAbstractWait(state.set, new Set(['shared']), [first.promise]);
  openAbstractWait(state.set, new Set(['shared', 'other']), [second.promise]);
  assert.deepEqual([...openAbstractWait(state.set, new Set(), [new Promise(() => {})])()], []);
  first.settle();
  await flush();
  assert.deepEqual(state.loading(), ['shared', 'other']);
  second.settle();
  await flush();
  assert.deepEqual(state.loading(), []);
});
