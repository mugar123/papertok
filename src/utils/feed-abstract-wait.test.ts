import test from 'node:test';
import assert from 'node:assert/strict';
import {
  abstractStatusText,
  abstractWaitIds,
  nextAbstractAnnouncement,
  openAbstractWait,
  type AbstractAnnouncement,
  type AbstractWaits,
} from './feed-abstract-wait.ts';

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

// One entry per render of a card: whether a request may still supply its
// abstract, whether it has text, and whether it is on screen.
type CardRender = { awaiting: boolean; hasText?: boolean; visible: boolean };
function spoken(renders: CardRender[]) {
  let announcement: AbstractAnnouncement | undefined;
  return renders.map(({ awaiting, hasText = false, visible }) => {
    const next = nextAbstractAnnouncement(announcement, { awaiting, hasText, visible });
    // A state set during render must settle: the same render again changes nothing.
    assert.equal(nextAbstractAnnouncement(next, { awaiting, hasText, visible }), next);
    announcement = next;
    return abstractStatusText(announcement, visible);
  });
}
const loading = { awaiting: true, visible: true };
const offScreen = { awaiting: true, visible: false };
const loaded = { awaiting: false, hasText: true, visible: true };
const none = { awaiting: false, visible: true };
const settledOffScreen = { awaiting: false, visible: false };

test('the card on screen says its abstract is loading, then whether it arrived', () => {
  assert.deepEqual(spoken([loading, loaded, loaded]), ['Loading abstract', 'Abstract loaded', 'Abstract loaded']);
  assert.deepEqual(spoken([loading, none, none]), ['Loading abstract', 'No abstract available', 'No abstract available']);
  assert.deepEqual(spoken([offScreen, loading]), ['', 'Loading abstract']);
});

test('a wait that ends off screen is not spoken, and a return after the end says nothing', () => {
  assert.deepEqual(spoken([offScreen, settledOffScreen, none]), ['', '', '']);
  assert.deepEqual(spoken([loading, none, settledOffScreen, none, settledOffScreen, none]),
    ['Loading abstract', 'No abstract available', '', '', '', '']);
});

test('a card shown without a wait says nothing until a later wait starts, then announces its end', () => {
  assert.deepEqual(spoken([none, loading, loaded]), ['', 'Loading abstract', 'Abstract loaded']);
  assert.deepEqual(spoken([loaded, loaded]), ['', '']);
});
