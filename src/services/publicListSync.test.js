import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createPublicListSyncEngine } from './publicListSync.js';

/** A hand-cranked clock, so the tests never wait in real time. */
function fakeTimers() {
  let nextId = 1;
  let now = 0;
  const pending = new Map();
  return {
    setTimer(callback, ms) {
      const id = nextId; nextId += 1;
      pending.set(id, { callback, at: now + ms, ms });
      return id;
    },
    clearTimer(id) { pending.delete(id); },
    /** Fires everything due within `ms`, including timers armed while firing. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await settle();
      }
      now = target;
    },
    get armed() { return pending.size; },
    get delay() { return [...pending.values()][0]?.ms; },
  };
}

/** Lets an async `run()` walk its awaits without any real waiting. */
async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function harness(overrides = {}) {
  const timers = fakeTimers();
  const calls = [];
  const events = [];
  let outcomes = overrides.outcomes || [];
  const engine = createPublicListSyncEngine({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: () => {},
    ...overrides.engine,
    sync: async (shareId, input) => {
      calls.push({ shareId, input });
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome || { shareId };
    },
  });
  engine.subscribe((key, state) => events.push({ key, status: state?.status ?? null, code: state?.code ?? null }));
  return { engine, timers, calls, events, fail: (error) => { outcomes = [error, ...outcomes]; } };
}

const REQUEST = {
  key: 'uid:list_1',
  shareId: '07070707070707070707070707070707',
  listId: 'list_1',
  title: 'Thesis reading',
  language: 'es',
  paperIds: ['arxiv:2401.00001'],
  papers: [{ id: 'arxiv:2401.00001', title: 'One' }],
};

test('nothing goes out until the debounce elapses', async () => {
  const { engine, timers, calls } = harness();
  engine.queue(REQUEST);
  assert.equal(calls.length, 0, 'a queued edit must not fire a request immediately');
  assert.equal(timers.delay, 900);
  await timers.advance(900);
  assert.equal(calls.length, 1);
});

test('a burst of edits on one list becomes a single request', async () => {
  const { engine, timers, calls } = harness();
  engine.queue({ ...REQUEST, paperIds: ['a', 'b', 'c'] });
  await timers.advance(400);
  engine.queue({ ...REQUEST, paperIds: ['a', 'b'] });
  await timers.advance(400);
  engine.queue({ ...REQUEST, paperIds: ['a'] });
  await timers.advance(900);

  assert.equal(calls.length, 1, 'three edits inside the window are one sync');
  assert.deepEqual(calls[0].input.paperIds, ['a'], 'the last membership wins');
});

test('hydrated papers accumulate across queued edits instead of overwriting', async () => {
  const { engine, timers, calls } = harness();
  // The save modal knows one paper; the lists page knows the rest. Neither
  // payload may erase the other, or the public copy would shrink to whatever
  // screen happened to sync last.
  engine.queue({ ...REQUEST, paperIds: ['p1', 'p2'], papers: [{ id: 'p1', title: 'One' }] });
  engine.queue({ ...REQUEST, paperIds: ['p1', 'p2'], papers: [{ id: 'p2', title: 'Two' }] });
  await timers.advance(900);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input.papers.map(paper => paper.id), ['p1', 'p2']);
});

test('an edit arriving mid-flight is not raced, it is re-run afterwards', async () => {
  const timers = fakeTimers();
  const calls = [];
  let release;
  const engine = createPublicListSyncEngine({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    sync: async (shareId, input) => {
      calls.push(input.paperIds);
      await new Promise((resolve) => { release = resolve; });
      return {};
    },
  });

  engine.queue({ ...REQUEST, paperIds: ['a'] });
  await timers.advance(900);
  assert.equal(calls.length, 1);

  engine.queue({ ...REQUEST, paperIds: ['a', 'b'] });
  assert.equal(calls.length, 1, 'the second edit must wait for the first request');
  release();
  await settle();
  await timers.advance(900);
  assert.deepEqual(calls, [['a'], ['a', 'b']]);
});

test('a first failure is retried on its own and never reaches the UI', async () => {
  const { engine, timers, calls, events } = harness({
    outcomes: [new Error('network down')],
  });
  engine.queue(REQUEST);
  await timers.advance(900);
  assert.equal(calls.length, 1);
  assert.ok(!events.some(event => event.status === 'error'), 'one blip is not news');

  await timers.advance(4_000);
  assert.equal(calls.length, 2);
  assert.equal(events.at(-1).status, 'synced');
});

test('a second failure surfaces with the Worker code, and retry runs it again', async () => {
  const quotaError = Object.assign(new Error('over quota'), { code: 'PUBLISH_QUOTA_EXCEEDED' });
  const { engine, timers, calls, events } = harness({
    outcomes: [quotaError, quotaError],
  });
  engine.queue(REQUEST);
  await timers.advance(900);
  await timers.advance(4_000);

  assert.equal(calls.length, 2);
  assert.deepEqual(
    { status: events.at(-1).status, code: events.at(-1).code },
    { status: 'error', code: 'PUBLISH_QUOTA_EXCEEDED' },
  );

  engine.retry('uid:list_1');
  await timers.advance(0);
  assert.equal(calls.length, 3);
  assert.equal(engine.getState('uid:list_1').status, 'synced');
});

test('a synced list stops announcing itself once the notice has been read', async () => {
  const { engine, timers } = harness();
  engine.queue(REQUEST);
  await timers.advance(900);
  assert.equal(engine.getState('uid:list_1').status, 'synced');
  await timers.advance(2_500);
  assert.equal(engine.getState('uid:list_1'), null, 'the badge goes quiet again');
});

test('the next sync names published papers by id and re-sends only the new one', async () => {
  const { engine, timers, calls } = harness();
  engine.queue({ ...REQUEST, paperIds: ['p1'], papers: [{ id: 'p1', title: 'One' }] });
  await timers.advance(900);
  engine.queue({ ...REQUEST, paperIds: ['p1', 'p2'], papers: [{ id: 'p2', title: 'Two' }] });
  await timers.advance(900);

  assert.deepEqual(calls[1].input.paperIds, ['p1', 'p2']);
  assert.deepEqual(calls[1].input.papers.map(paper => paper.id), ['p2'],
    'the Worker merge keeps p1 from the published copy; re-sending it is waste');
});

test('an incomplete request is refused instead of queueing a broken sync', async () => {
  const { engine, timers, calls } = harness();
  engine.queue({ key: 'uid:list_1', listId: 'list_1' });
  engine.queue({ key: 'uid:list_1', shareId: REQUEST.shareId });
  await timers.advance(5_000);
  assert.equal(calls.length, 0);
});

test('unpublishing cancels the queued sync instead of firing it at a dead share', async () => {
  const { engine, timers, calls, events } = harness();
  engine.queue(REQUEST);
  engine.cancel('uid:list_1');
  await timers.advance(5_000);

  assert.equal(calls.length, 0, 'the share id is gone; the request has nowhere to land');
  assert.equal(events.at(-1).status, null, 'and the badge clears with it');
  assert.equal(engine.getState('uid:list_1'), null);
});

test('a sync cancelled mid-flight fails quietly instead of blaming the owner', async () => {
  const timers = fakeTimers();
  const reported = [];
  const events = [];
  let reject;
  const engine = createPublicListSyncEngine({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: (error) => reported.push(error),
    sync: () => new Promise((resolve, failed) => { reject = failed; }),
  });
  engine.subscribe((key, state) => events.push(state?.status ?? null));

  engine.queue(REQUEST);
  await timers.advance(900);
  engine.cancel('uid:list_1');
  reject(new Error('share not found'));
  await settle();
  await timers.advance(10_000);

  assert.equal(reported.length, 0, 'a list the owner just unpublished cannot have failed');
  assert.ok(!events.includes('error'));
});

test('a throwing listener never loses a sync, and unsubscribing really stops', async () => {
  const { engine, timers, calls } = harness();
  const seen = [];
  engine.subscribe(() => { throw new Error('render blew up'); });
  const stop = engine.subscribe((key, state) => seen.push(state?.status ?? null));

  engine.queue(REQUEST);
  await timers.advance(900);
  assert.equal(calls.length, 1, 'a broken subscriber must not swallow the request');
  assert.ok(seen.includes('synced'));

  stop();
  const before = seen.length;
  engine.queue({ ...REQUEST, key: 'uid:list_2', listId: 'list_2' });
  await timers.advance(900);
  assert.equal(calls.length, 2);
  assert.equal(seen.length, before, 'a screen that unmounted hears nothing more');
});

/* --- SOURCE: the manual Update button is gone, for good ---------------------
   This is the whole point of the change, and it is the kind of thing a later
   "just add a small button" would undo without anyone noticing. The lists page
   may publish, share and unpublish; it may not offer to push an edit. */

test('SOURCE: the lists page has no manual public-list update control', async () => {
  const source = await readFile(
    new URL('../components/Lists/ListsPage.jsx', import.meta.url),
    'utf8',
  );
  assert.ok(!source.includes('updatePublicList'),
    'the whole-payload update call must not come back to the lists page');
  assert.ok(!/RefreshCw/.test(source), 'the Update button and its icon are gone');
  assert.ok(source.includes('queuePublicListSync'),
    'edits reach the public copy through the sync engine');
});

test('SOURCE: every list edit stamps updatedAt, or the recovery check goes blind', async () => {
  for (const path of ['../components/Lists/ListsPage.jsx', '../components/Lists/SaveToListModal.jsx']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    const edits = source.match(/arrayUnion\(|arrayRemove\(/g) || [];
    const stamps = source.match(/updatedAt: serverTimestamp\(\)/g) || [];
    assert.ok(edits.length > 0, `${path}: expected membership writes`);
    assert.equal(stamps.length, edits.length,
      `${path}: every membership write must stamp updatedAt so a lost sync can be found later`);
  }
});
